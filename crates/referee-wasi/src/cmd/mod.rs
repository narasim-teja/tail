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
use serde_json::Value;
use tail_protocol::digest::verdict_digest;
use tail_protocol::{CallId, LogEntry, MatchId, SignedVerdict, VerdictPayload};

pub fn dispatch(name: &str, input: Value) -> Result<Value, String> {
    match name {
        "pubkeys" => pubkeys::run(input),
        "enroll" => enroll::run(input),
        "start" => start::run(input),
        "tick" => tick::run(input),
        "voice" => voice::run(input),
        "end" => end::run(input),
        "declassify" => end::declassify(input),
        "bench_state" => bench::run(input),
        other => Err(format!("unknown cmd {other:?}")),
    }
}

/// Signs the engine's verdicts in order. The engine sets `seq` and `call_id` (each verdict's
/// log entry is its digest, so it must); this only checks they belong to this match and call.
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
                call_id: p.call_id,
                body: p.body,
                sig,
            };
            Ok(b64(&to_borsh(&v)))
        })
        .collect()
}

fn log_b64(log: &[LogEntry]) -> Vec<String> {
    log.iter().map(|e| b64(&to_borsh(e))).collect()
}

/// Decodes the borsh `HintReceipt`s the relay got from `voice`.
fn receipts(list: &[String]) -> Result<Vec<referee_core::HintReceipt>, String> {
    list.iter()
        .map(|r| {
            borsh::from_slice(&from_b64("receipt", r)?)
                .map_err(|e| format!("receipt is not a HintReceipt: {e}"))
        })
        .collect()
}

/// Opens a match's tick state and refuses a stale one.
fn open_checked(match_id: &MatchId, blob_b64: &str, last_seq: u32) -> Result<MatchState, String> {
    let st = state::open(&from_b64("state", blob_b64)?, domain::STATE, match_id)?;
    state::check_seq(st.last_seq(), last_seq)?;
    Ok(st)
}
