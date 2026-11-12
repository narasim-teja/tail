//! `tick`: one step of a match, with no storage access. The relay passes back the sealed state
//! it got from the previous call (or from `start`), the last verdict seq it holds, the sealed
//! batches the phones sent since, and the voice receipts for earlier hints. The rules engine
//! does the rest, App Attest checks included.

use super::{log_b64, open_checked, receipts, sign_all};
use crate::codec::{b64, fixed_b64, from_b64, parse, to_borsh, uuid_string};
use crate::host;
use crate::records::domain;
use crate::state;
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
    /// Borsh `HintReceipt`s from `voice`, for hints of earlier ticks.
    #[serde(default)]
    receipts: Vec<String>,
}

/// Opens one phone's sealed batch; the error says why it was dropped.
pub(super) fn open_batch(box_sk: &[u8; 32], sealed_b64: &str) -> Result<BatchEnvelope, String> {
    let sealed = from_b64("batch", sealed_b64)?;
    let plain = tail_protocol::seal::open(box_sk, &sealed, domain::SEAL_BATCH)
        .map_err(|e| format!("does not open with the referee box key ({e:?})"))?;
    borsh::from_slice(&plain).map_err(|e| format!("not a BatchEnvelope ({e})"))
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

    let tick_no = st.tick_no.checked_add(1).ok_or("tick counter overflow")?;
    let out = referee_core::tick(
        st.core,
        referee_core::TickInput {
            tick_no,
            now_ms,
            call_id,
            batches,
            receipts: receipts(&i.receipts)?,
        },
    )
    // A refused tick changes nothing; the caller retries with the same blob.
    .map_err(|e| format!("tick refused: {e:?}"))?;

    let verdicts = sign_all(match_id, call_id, out.verdicts)?;
    let mut huds = Vec::with_capacity(out.huds.len());
    for (player, hud) in &out.huds {
        let pk = st
            .box_pks
            .get(usize::from(*player))
            .ok_or(format!("engine produced a HUD for unknown player {player}"))?;
        let eph: [u8; 32] = host::random();
        let sealed = tail_protocol::seal::seal_with(&eph, pk, &to_borsh(hud), domain::SEAL_HUD);
        huds.push(json!({ "player": player, "sealed": b64(&sealed) }));
    }
    let rejected: Vec<Value> = out
        .rejected
        .iter()
        .map(|r| json!({ "player": r.player, "seq": r.seq, "reason": format!("{:?}", r.reason) }))
        .collect();
    let refused: Vec<Value> = out
        .refused
        .iter()
        .map(|r| {
            json!({
                "player": r.player,
                "nonce": r.nonce,
                "action": format!("{:?}", r.action),
                "reason": format!("{:?}", r.reason),
            })
        })
        .collect();
    let hints: Vec<Value> = out
        .hints
        .iter()
        .map(|h| {
            json!({
                "hint_id": h.hint_id,
                "from": h.from,
                "to": h.to,
                "amount": h.amount.to_string(),
                "hint": h.fact.hint,
                "value": h.fact.value,
                "nonce": h.nonce,
                "text": h.text,
            })
        })
        .collect();

    st.core = out.state;
    st.tick_no = tick_no;
    let blob = state::seal(&st, domain::STATE, &match_id)?;

    Ok(json!({
        "call_id": uuid_string(&call_id),
        "tick_no": tick_no,
        "now_ms": now_ms,
        "seq": st.last_seq(),
        "over": out.over,
        "state": b64(&blob),
        "state_bytes": blob.len(),
        "verdicts": verdicts,
        "huds": huds,
        "log": log_b64(&out.log),
        "log_size": st.core.log_size(),
        "log_root": hex::encode(st.core.log_root()),
        "hints": hints,
        "opened": accepted_input,
        "unopened": unopened,
        "rejected": rejected,
        "refused": refused,
    }))
}
