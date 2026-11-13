//! `end` calls `referee_core::finish`, which reveals the VRF output in a signed `End` verdict
//! carrying the engine's own log size and Merkle root; `declassify` releases the match's secrets
//! once it has ended (TECHNICAL.md 4.8, 4.11). The log itself is the relay's: the engine keeps
//! only its Merkle frontier.

use super::tick::open_batch;
use super::{log_b64, open_checked, receipts, sign_all};
use crate::codec::{b64, fixed_b64, from_b64, parse, to_borsh, uuid_string};
use crate::host;
use crate::records::{domain, match_record_key, EndRecord, MatchRecord};
use crate::state;
use serde::Deserialize;
use serde_json::{json, Value};
use tail_protocol::{MatchId, Verdict};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EndInput {
    match_id: String,
    state: String,
    last_seq: u32,
    /// Receipts for hints of the last tick; they join the log before the End root is taken.
    #[serde(default)]
    receipts: Vec<String>,
}

fn load_record(match_id: &MatchId) -> Result<(Vec<u8>, MatchRecord), String> {
    let bytes = host::storage_get(&match_record_key(match_id))?.ok_or("no such match")?;
    let record = borsh::from_slice(&bytes).map_err(|e| format!("match record: {e}"))?;
    Ok((bytes, record))
}

pub fn run(input: Value) -> Result<Value, String> {
    let i: EndInput = parse(input)?;
    let match_id: MatchId = fixed_b64("match_id", &i.match_id)?;
    let mut st = open_checked(&match_id, &i.state, i.last_seq)?;
    let call_id = host::call_id()?;
    let (stored, mut record) = load_record(&match_id)?;
    if record.end.is_some() {
        return Err("match has already ended".into());
    }

    let fin = referee_core::finish(
        st.core,
        record.vrf_alpha.clone(),
        &record.vrf_signature,
        call_id,
        receipts(&i.receipts)?,
    )
    .map_err(|e| format!("end refused: {e:?}"))?;
    let (seq, log_size, root) = match fin.verdicts.first() {
        Some(p) => match &p.body {
            Verdict::End { log_size, root, .. } => (p.seq, *log_size, *root),
            _ => return Err("engine did not produce an End verdict".into()),
        },
        None => return Err("engine did not produce an End verdict".into()),
    };
    let verdicts = sign_all(match_id, call_id, fin.verdicts)?;
    record.end = Some(EndRecord {
        seq,
        log_size,
        root,
        call_id,
    });
    // Two `end` calls racing on one state blob: only the one whose write lands releases a
    // verdict, so a match never has two different End verdicts.
    if !host::storage_replace(&match_record_key(&match_id), &stored, &to_borsh(&record))? {
        return Err("match record changed during end; it has probably just ended".into());
    }
    st.core = fin.state;
    let blob = state::seal(&st, domain::STATE, &match_id)?;

    Ok(json!({
        "call_id": uuid_string(&call_id),
        "seq": seq,
        "verdicts": verdicts,
        "log_size": log_size,
        "root": hex::encode(root),
        "state": b64(&blob),
        "log": log_b64(&fin.log),
    }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeclassifyInput {
    match_id: String,
}

pub fn declassify(input: Value) -> Result<Value, String> {
    let i: DeclassifyInput = parse(input)?;
    let match_id: MatchId = fixed_b64("match_id", &i.match_id)?;
    let (_, r) = load_record(&match_id)?;
    let end = r
        .end
        .ok_or("match has not ended; nothing is declassified before End")?;
    Ok(json!({
        "match_id": b64(&r.match_id),
        "start_ms": r.start_ms,
        "end_ms": r.end_ms,
        "players": r.players.iter().map(|d| json!({
            "account_id": d.account_id,
            "app_attest_pk": b64(&d.app_attest_pk),
            "attested": d.attested,
            "player_box_pk": b64(&d.player_box_pk),
            "near_pk": b64(&d.near_pk),
            "enroll_call_id": uuid_string(&d.call_id),
        })).collect::<Vec<_>>(),
        "ring": r.ring,
        "k_m": hex::encode(r.k_m),
        "vrf_alpha": r.vrf_alpha,
        "vrf_signature": hex::encode(r.vrf_signature),
        "start_call_id": uuid_string(&r.start_call_id),
        "end": {
            "seq": end.seq,
            "log_size": end.log_size,
            "root": hex::encode(end.root),
            "call_id": uuid_string(&end.call_id),
        },
    }))
}

/// Sealed batches per call. A 60-minute 12-player match is about 8,600 batches, so the relay
/// sends them in chunks; 500 keeps one call's input and output well under the HTTPS and
/// stdout limits (README, "Measured").
const MAX_DECLASSIFY_BATCHES: usize = 500;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeclassifyBatchesInput {
    match_id: String,
    /// The End state blob. When given, its box key is used and one storage read is saved.
    #[serde(default)]
    state: Option<String>,
    sealed: Vec<String>,
}

/// Opens the sealed batches the relay kept and returns the plain `Batch`es of this match, for
/// the replay's trails. Only after End. The assertion is never returned. The replay checks
/// each batch's SHA256 against the log's `LogEntry::Batch` hashes, so nothing can be added.
pub fn declassify_batches(input: Value) -> Result<Value, String> {
    let i: DeclassifyBatchesInput = parse(input)?;
    let match_id: MatchId = fixed_b64("match_id", &i.match_id)?;
    if i.sealed.len() > MAX_DECLASSIFY_BATCHES {
        return Err(format!(
            "at most {MAX_DECLASSIFY_BATCHES} sealed batches per call"
        ));
    }
    // The stored record is the authority on whether the match has ended.
    let (_, record) = load_record(&match_id)?;
    if record.end.is_none() {
        return Err("match has not ended; nothing is declassified before End".into());
    }
    let box_sk = match &i.state {
        Some(blob) => {
            let st = state::open(&from_b64("state", blob)?, domain::STATE, &match_id)?;
            if st.core.phase() != referee_core::Phase::Ended {
                return Err("the state blob given is not the match's End state".into());
            }
            st.box_sk
        }
        None => host::box_sk()?,
    };
    let mut batches = Vec::with_capacity(i.sealed.len());
    let mut refused = Vec::new();
    for (index, sealed) in i.sealed.iter().enumerate() {
        match open_batch(&box_sk, sealed) {
            Ok(env) if env.batch.match_id == match_id => batches.push(b64(&to_borsh(&env.batch))),
            Ok(_) => refused.push(json!({ "index": index, "reason": "batch is for another match" })),
            Err(reason) => refused.push(json!({ "index": index, "reason": reason })),
        }
    }
    Ok(json!({ "batches": batches, "refused": refused }))
}
