//! `tick`: one step of a match, with no storage access. The relay passes back the sealed state
//! it got from the previous call (or from `start`), the last verdict seq it holds, the sealed
//! batches the phones sent since, and the receipts `voice` returned for earlier hints. The
//! rules engine does the rest, App Attest checks included.
//!
//! What leaves in the clear is what the relay needs to run the match: signed verdicts with
//! their consistency proofs, leaf hashes, reject codes and who has a hint to voice. The log
//! entries, HUDs and hint facts leave sealed.

use super::{log_out, open_checked, proofs_json, receipts, seal_huds, sign_all};
use crate::codec::{b64, fixed_b64, from_b64, parse, to_borsh, uuid_string};
use crate::host;
use crate::records::HintBlob;
use crate::state;
use crate::vault::{self, Purpose};
use referee_core::{ActionKind, Refusal, Rejection};
use serde::Deserialize;
use serde_json::{json, Value};
use tail_protocol::{BatchEnvelope, MatchId, CLOCK_SKEW_MS};

/// Sealed batches per tick: 16 players × two 5 s batches per 10 s tick, with slack.
const MAX_BATCHES: usize = 256;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    match_id: String,
    state: String,
    last_seq: u32,
    /// Referee time of this tick (Unix ms); defaults to the host clock. It may lag the host
    /// clock (that is the same as calling later) but not run ahead of it.
    #[serde(default)]
    now_ms: Option<u64>,
    #[serde(default)]
    batches: Vec<String>,
    /// `log_sealed` blobs from `voice` (sealed `HintReceipt`s), for hints of earlier ticks.
    #[serde(default)]
    receipts: Vec<String>,
}

/// Opens one phone's sealed batch; the error says why it was dropped.
pub(super) fn open_batch(box_sk: &[u8; 32], sealed_b64: &str) -> Result<BatchEnvelope, String> {
    let sealed = from_b64("batch", sealed_b64)?;
    let plain = tail_protocol::seal::open(box_sk, &sealed, tail_protocol::domain::BATCH)
        .map_err(|e| format!("does not open with the referee box key ({e:?})"))?;
    borsh::from_slice(&plain).map_err(|e| format!("not a BatchEnvelope ({e})"))
}

fn rejected_json(r: &Rejection) -> Value {
    json!({ "player": r.player, "seq": r.seq, "reason": r.reason.code() })
}

fn refused_json(r: &Refusal) -> Value {
    let action = match r.action {
        ActionKind::Strike => "strike",
        ActionKind::Hint(_) => "hint",
    };
    // The protocol's `refuse_code` only: the amounts some reasons carry (a lock count, a head)
    // are the player's to see in their HUD, not the relay's.
    json!({ "player": r.player, "nonce": r.nonce, "action": action, "reason": r.reason.code() })
}

pub fn run(input: Value) -> Result<Value, String> {
    let i: Input = parse(input)?;
    if i.batches.len() > MAX_BATCHES {
        return Err(format!("at most {MAX_BATCHES} batches per tick"));
    }
    let match_id: MatchId = fixed_b64("match_id", &i.match_id)?;
    let mut st = open_checked(&match_id, &i.state, i.last_seq)?;
    let wall = host::wall_ms();
    let now_ms = i.now_ms.unwrap_or(wall);
    // A caller who could run the referee clock ahead of real time could end a match early or
    // make players go dark. Holding it back only delays the referee, which withholding ticks
    // does anyway.
    if now_ms > wall + CLOCK_SKEW_MS {
        return Err(format!("now_ms {now_ms} is ahead of the referee clock {wall}"));
    }
    let call_id = host::call_id()?;

    let mut batches = Vec::with_capacity(i.batches.len());
    let mut unopened = Vec::new();
    for (index, sealed) in i.batches.iter().enumerate() {
        match open_batch(&st.box_sk, sealed) {
            Ok(b) => batches.push(b),
            Err(reason) => unopened.push(json!({ "index": index, "reason": reason })),
        }
    }
    let accepted_input = batches.len();
    let receipts = receipts(&st.box_sk, &match_id, &i.receipts)?;

    let tick_no = st.tick_no.checked_add(1).ok_or("tick counter overflow")?;
    let first = st.core.log_size();
    let out = referee_core::tick(
        st.core,
        referee_core::TickInput {
            tick_no,
            now_ms,
            call_id,
            batches,
            receipts,
        },
    )
    // A refused tick changes nothing; the caller retries with the same blob.
    .map_err(|e| format!("tick refused: {e:?}"))?;
    st.core = out.state;
    st.tick_no = tick_no;

    let verdicts = sign_all(match_id, call_id, out.verdicts)?;
    let huds = seal_huds(&st, out.huds)?;
    let (leaves, log_sealed) = log_out(&st.box_sk, &match_id, first, &out.log);
    // Who asked is public anyway (the Hint verdict names them); what they learn is not.
    let hints: Vec<Value> = out
        .hints
        .into_iter()
        .map(|h| {
            let blob = HintBlob {
                match_id,
                hint_id: h.hint_id,
                player: h.from,
                hint: h.fact.hint,
                value: h.fact.value,
                recent: h.recent,
                question: h.text,
            };
            let sealed = vault::seal(&st.box_sk, Purpose::Hint, &match_id, &[], &to_borsh(&blob));
            // The match id goes in front so `voice` knows which state blob to open.
            json!({ "player": h.from, "blob": b64(&[match_id.as_slice(), &sealed].concat()) })
        })
        .collect();
    let blob = state::seal(&st, crate::records::domain::STATE, &match_id)?;

    Ok(json!({
        "call_id": uuid_string(&call_id),
        "tick_no": tick_no,
        "now_ms": now_ms,
        "seq": st.last_seq(),
        "over": out.over,
        "state": b64(&blob),
        "state_bytes": blob.len(),
        "verdicts": verdicts,
        "proofs": proofs_json(&out.proofs),
        "huds": huds,
        "leaves": leaves,
        "log_sealed": log_sealed,
        "log_size": st.core.log_size(),
        "log_root": hex::encode(st.core.log_root()),
        "hints": hints,
        "opened": accepted_input,
        "unopened": unopened,
        "rejected": out.rejected.iter().map(rejected_json).collect::<Vec<_>>(),
        "refused": out.refused.iter().map(refused_json).collect::<Vec<_>>(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use referee_core::Refuse;
    use tail_protocol::refuse_code;

    #[test]
    fn a_refusal_leaves_as_its_protocol_code_without_the_amounts() {
        let r = Refusal {
            player: 1,
            nonce: 7,
            action: ActionKind::Hint(0),
            reason: Refuse::InsufficientHead { head: 5, price: 9 },
        };
        assert_eq!(
            refused_json(&r),
            json!({ "player": 1, "nonce": 7, "action": "hint", "reason": refuse_code::FUNDS })
        );
    }
}
