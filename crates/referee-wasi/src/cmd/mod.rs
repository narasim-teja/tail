//! One module per command. Each parses its own input shape (unknown fields refused) and
//! returns the JSON result; `main` wraps it in `{ok, result | error}`.

mod bench;
mod end;
mod enroll;
mod pubkeys;
mod start;
mod tick;
mod voice;

use crate::codec::{b64, from_b64, to_borsh};
use crate::host;
use crate::records::domain;
use crate::state::{self, MatchState};
use crate::vault::{self, Purpose};
use referee_core::ConsistencyProof;
use serde_json::{json, Value};
use tail_protocol::digest::{hud_sig_digest, verdict_digest};
use tail_protocol::{merkle, CallId, Hud, LogEntry, MatchId, SignedHud, SignedVerdict, VerdictPayload};

pub fn dispatch(name: &str, input: Value) -> Result<Value, String> {
    match name {
        "pubkeys" => pubkeys::run(input),
        "enroll" => enroll::run(input),
        "start" => start::run(input),
        "tick" => tick::run(input),
        "voice" => voice::run(input),
        "end" => end::run(input),
        "declassify" => end::declassify(input),
        "declassify_batches" => end::declassify_batches(input),
        "bench_state" => bench::run(input),
        other => Err(format!("unknown cmd {other:?}")),
    }
}

/// Signs the engine's verdicts in order. The engine sets `seq`, `prev` and `call_id` (each
/// verdict's log entry is its digest, so it must); this only checks they belong to this match
/// and call.
fn sign_all(
    match_id: MatchId,
    call_id: CallId,
    payloads: Vec<VerdictPayload>,
) -> Result<Vec<String>, String> {
    payloads
        .into_iter()
        .map(|p| {
            if p.match_id != match_id || p.call_id != call_id {
                return Err("engine produced a verdict for another match or call".to_owned());
            }
            let sig = host::sign_digest(&verdict_digest(&p))?;
            let v = SignedVerdict {
                match_id: p.match_id,
                seq: p.seq,
                prev: p.prev,
                call_id: p.call_id,
                body: p.body,
                sig,
            };
            Ok(b64(&to_borsh(&v)))
        })
        .collect()
}

/// `[{seq, from_size, path}]`, one per Checkpoint / End, for the contract's `apply`.
fn proofs_json(proofs: &[ConsistencyProof]) -> Vec<Value> {
    proofs
        .iter()
        .map(|p| {
            json!({
                "seq": p.seq,
                "from_size": p.from_size,
                "path": p.path.iter().map(|h| b64(h)).collect::<Vec<_>>(),
            })
        })
        .collect()
}

/// Where a call's log entries start: the bind of their sealed blob.
fn log_bind(first: u64) -> [u8; 8] {
    first.to_le_bytes()
}

/// One call's new log entries as the relay gets them: the leaf hashes in the clear (for
/// inclusion and consistency proofs) and the entries themselves sealed to the referee, bound to
/// the log index of the first, for `declassify` after End.
fn log_out(box_sk: &[u8; 32], match_id: &MatchId, first: u64, log: &[LogEntry]) -> (Vec<String>, String) {
    let leaves = log.iter().map(|e| b64(&merkle::leaf(e))).collect();
    let sealed = vault::seal(
        box_sk,
        Purpose::Log,
        match_id,
        &log_bind(first),
        &to_borsh(&log.to_vec()),
    );
    (leaves, b64(&sealed))
}

/// Seals `plaintext` to a player's box key under a protocol seal context.
fn seal_to(pk: &[u8; 32], plaintext: &[u8], context: &[u8]) -> Result<Vec<u8>, String> {
    let eph: [u8; 32] = host::random();
    tail_protocol::seal::seal_with(&eph, pk, plaintext, context)
        .map_err(|e| format!("cannot seal to a player's box key ({e:?})"))
}

/// Signs each HUD (`hud_sig_digest`) and seals the `SignedHud` to its player: sealing alone
/// would not stop the relay, which can seal to the same key, from swapping one in.
fn seal_huds(st: &MatchState, huds: Vec<(u16, Hud)>) -> Result<Vec<Value>, String> {
    huds.into_iter()
        .map(|(player, hud)| {
            let pk = st
                .box_pks
                .get(usize::from(player))
                .ok_or(format!("engine produced a HUD for unknown player {player}"))?;
            let sig = host::sign_digest(&hud_sig_digest(&hud))?;
            let sealed = seal_to(pk, &to_borsh(&SignedHud { hud, sig }), tail_protocol::domain::HUD)?;
            Ok(json!({ "player": player, "sealed": b64(&sealed) }))
        })
        .collect()
}

/// Opens the receipts `voice` returned. Only this referee can make one, so a receipt that
/// does not open is a relay bug, and the call is refused rather than the receipt dropped.
fn receipts(
    box_sk: &[u8; 32],
    match_id: &MatchId,
    list: &[String],
) -> Result<Vec<referee_core::HintReceipt>, String> {
    list.iter()
        .enumerate()
        .map(|(i, r)| {
            let plain = vault::open(box_sk, Purpose::Receipt, match_id, &[], &from_b64("receipt", r)?)
                .map_err(|e| format!("receipt {i}: {e}"))?;
            borsh::from_slice(&plain).map_err(|e| format!("receipt {i} is not a HintReceipt: {e}"))
        })
        .collect()
}

/// Opens a match's tick state and refuses a stale one.
fn open_checked(match_id: &MatchId, blob_b64: &str, last_seq: u32) -> Result<MatchState, String> {
    let st = state::open(&from_b64("state", blob_b64)?, domain::STATE, match_id)?;
    state::check_seq(st.last_seq(), last_seq)?;
    Ok(st)
}
