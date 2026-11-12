//! `bench_state`: the tick's state round trip alone, at a chosen size, either sealed and handed
//! back (`mode: "sealed"`, what `tick` does) or read and written in OutLayer storage
//! (`mode: "storage"`). Measures which design a tick can afford; `scripts/latency.ts` drives
//! it. It touches no match: its blobs are sealed under their own domain and match id.

use crate::codec::{b64, from_b64, parse, to_borsh};
use crate::host;
use crate::records::domain;
use crate::state;
use borsh::{BorshDeserialize, BorshSerialize};
use serde::Deserialize;
use serde_json::{json, Value};

/// Under the 256 KiB limit of one `encryption_keys` call.
const MAX_SIZE: usize = 200_000;
const BENCH_MATCH: [u8; 16] = [0; 16];
const BENCH_RECORD: &str = "bench:state";

/// Stands in for a match state of `pad.len()` bytes; `seq` is checked like a tick's.
#[derive(BorshSerialize, BorshDeserialize)]
struct BenchState {
    seq: u32,
    pad: Vec<u8>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "lowercase")]
enum Mode {
    Sealed,
    Storage,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    mode: Mode,
    /// Bytes of state to carry.
    size: usize,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    last_seq: u32,
}

fn decode(bytes: &[u8]) -> Result<BenchState, String> {
    borsh::from_slice(bytes).map_err(|e| format!("bench state: {e}"))
}

pub fn run(input: Value) -> Result<Value, String> {
    let i: Input = parse(input)?;
    if i.size > MAX_SIZE {
        return Err(format!("size is at most {MAX_SIZE}"));
    }
    let t0 = host::now_ms();
    let (blob, bytes, seq) = match i.mode {
        Mode::Sealed => {
            // Same steps as a tick: open, rollback check, reseal.
            let seq = match &i.state {
                Some(s) => {
                    let prev = decode(&state::open_raw(
                        &from_b64("state", s)?,
                        domain::BENCH_STATE,
                        &BENCH_MATCH,
                    )?)?;
                    state::check_seq(prev.seq, i.last_seq)?;
                    prev.seq + 1
                }
                None => 1,
            };
            let next = BenchState {
                seq,
                pad: vec![0; i.size],
            };
            let blob = state::seal(&next, domain::BENCH_STATE, &BENCH_MATCH)?;
            let n = blob.len();
            (Some(blob), n, seq)
        }
        Mode::Storage => {
            let seq = match host::storage_get(BENCH_RECORD)? {
                Some(prev) => decode(&prev)?.seq + 1,
                None => 1,
            };
            let plain = to_borsh(&BenchState {
                seq,
                pad: vec![0; i.size],
            });
            host::storage_set(BENCH_RECORD, &plain)?;
            (None, plain.len(), seq)
        }
    };
    Ok(json!({
        "state": blob.as_deref().map(b64),
        "bytes": bytes,
        "seq": seq,
        "enclave_ms": host::now_ms() - t0,
    }))
}
