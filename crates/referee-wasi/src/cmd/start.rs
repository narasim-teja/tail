//! `start` (TECHNICAL.md 4.8): K_m, one VRF output, then `referee_core::init`, which builds the
//! ring, the players' keys, one `Enrolled` log entry per player and the `Start` verdict (seq 1).
//! Here each player's keys are signed and sealed to their box key, and the verdict is signed.
//! K_m and the VRF reveal stay in storage for `end` and `declassify`; the sealed tick state
//! carries everything a tick needs.

use super::{log_out, seal_to, sign_all, APP_ID};
use crate::codec::{b64, fixed_b64, parse, to_borsh, uuid_string};
use crate::records::{device_record_key, domain, match_record_key, Device, DeviceRecord, MatchRecord};
use crate::state::{self, MatchState};
use crate::{account, host};
use serde::Deserialize;
use serde_json::{json, Value};
use tail_protocol::digest::keys_sig_digest;
use tail_protocol::ring::{build_ring, sort_accounts};
use tail_protocol::{PlayerKeys, SignedPlayerKeys, Verdict};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CircleIn {
    lat_e7: i32,
    lon_e7: i32,
    radius_m: u32,
}

impl From<&CircleIn> for referee_core::Circle {
    fn from(c: &CircleIn) -> Self {
        Self {
            lat_e7: c.lat_e7,
            lon_e7: c.lon_e7,
            radius_m: c.radius_m,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    match_id: String,
    players: Vec<String>,
    /// Unix ms; defaults to the host clock. `end_ms = start_ms + duration_ms`.
    #[serde(default)]
    start_ms: Option<u64>,
    duration_ms: u64,
    /// Every player's starting head in the token's smallest unit, as a decimal string (u128).
    stake: String,
    zone: CircleIn,
    #[serde(default)]
    safehouses: Vec<CircleIn>,
}

fn load_device(account_id: &str) -> Result<Device, String> {
    let bytes =
        host::storage_get(&device_record_key(account_id))?.ok_or(format!("{account_id} is not enrolled"))?;
    DeviceRecord::decode(&bytes)
        .map(|r| r.device)
        .map_err(|e| format!("device record of {account_id}: {e}"))
}

/// Each player's keys, signed as well as sealed to their box key: the relay can seal to the
/// same key, so only the signature says the referee sent them.
fn seal_keys(keys: Vec<(u16, PlayerKeys)>, devices: &[Device]) -> Result<Vec<Value>, String> {
    keys.into_iter()
        .map(|(player, pk)| {
            let device = &devices[usize::from(player)];
            let sig = host::sign_digest(&keys_sig_digest(&pk))?;
            let signed = SignedPlayerKeys { keys: pk, sig };
            let sealed = seal_to(&device.player_box_pk, &signed)?;
            Ok(json!({ "player": player, "account_id": device.account_id, "sealed": b64(&sealed) }))
        })
        .collect()
}

pub fn run(input: Value) -> Result<Value, String> {
    let i: Input = parse(input)?;
    let match_id: [u8; 16] = fixed_b64("match_id", &i.match_id)?;
    let stake: u128 = i
        .stake
        .parse()
        .map_err(|_| "stake must be a decimal u128 string")?;
    for a in &i.players {
        account::validate(a)?;
    }
    // Player numbers are positions in byte-sorted order, as in the engine and `players_hash`.
    let sorted = sort_accounts(&i.players);
    if sorted.len() > referee_core::MAX_PLAYERS {
        // Checked before the storage reads it would otherwise cost.
        return Err(format!("at most {} players", referee_core::MAX_PLAYERS));
    }
    let start_ms = i.start_ms.unwrap_or_else(host::wall_ms);
    let call_id = host::call_id()?;
    let devices = sorted
        .iter()
        .map(|a| load_device(a))
        .collect::<Result<Vec<_>, _>>()?;
    let box_sk = host::box_sk()?;

    let k_m: [u8; 32] = host::random();
    // Seed = lowercase match id hex (no ':' allowed by the VRF). The contract checks that the
    // revealed alpha ends with ":" + that hex.
    let vrf = host::vrf(&hex::encode(match_id))?;
    let cfg = referee_core::MatchConfig {
        match_id,
        // The App ID the engine checks every assertion against is the one enrolment checked
        // attestations against, pinned in the code: a relay that could name it could have
        // assertions from an app of its own accepted.
        app_id: APP_ID.to_owned(),
        stake,
        duration_ms: i.duration_ms,
        zone: (&i.zone).into(),
        safehouses: i.safehouses.iter().map(Into::into).collect(),
    };
    let core_devices = devices
        .iter()
        .map(|d| referee_core::Device {
            account_id: d.account_id.clone(),
            key: d.app_attest_pk,
            // An assertion counter starts at 0 right after attestation.
            counter: 0,
            attested: d.attested,
        })
        .collect();
    let started = referee_core::init(cfg, core_devices, &k_m, &vrf.signature, start_ms, call_id)
        .map_err(|e| format!("start refused: {e:?}"))?;
    let views = started.state.players();
    if views.iter().map(|p| &p.account).ne(sorted.iter()) {
        return Err("engine player order differs from the sorted accounts".into());
    }

    let keys = seal_keys(started.keys, &devices)?;
    let (players_hash, ring_commit, end_ms) = match started.verdicts.first().map(|v| &v.body) {
        Some(Verdict::Start {
            players_hash,
            ring_commit,
            end_ms,
            ..
        }) => (*players_hash, *ring_commit, *end_ms),
        _ => return Err("engine did not produce a Start verdict".into()),
    };
    let verdicts = sign_all(match_id, call_id, started.verdicts)?;

    let record = MatchRecord {
        match_id,
        start_ms,
        end_ms,
        players: devices.clone(),
        ring: build_ring(&sorted, &vrf.signature),
        k_m,
        vrf_alpha: vrf.alpha,
        vrf_signature: vrf.signature,
        start_call_id: call_id,
        end: None,
    };
    // One Start per match id: the record is written only if absent, and the signed verdict is
    // released only after that write wins.
    if !host::storage_set_if_absent(&match_record_key(&match_id), &to_borsh(&record))? {
        return Err(format!("match {} has already started", hex::encode(match_id)));
    }

    let st = MatchState {
        version: state::VERSION,
        match_id,
        tick_no: 0,
        box_sk,
        box_pks: devices.iter().map(|d| d.player_box_pk).collect(),
        core: started.state,
    };
    let blob = state::seal(&st, domain::STATE, &match_id)?;
    let (leaves, log_sealed) = log_out(&box_sk, &match_id, 0, &started.log);

    Ok(json!({
        "call_id": uuid_string(&call_id),
        "seq": st.last_seq(),
        "verdicts": verdicts,
        "players_hash": hex::encode(players_hash),
        "ring_commit": hex::encode(ring_commit),
        "players": sorted,
        "start_ms": start_ms,
        "end_ms": end_ms,
        "keys": keys,
        "state": b64(&blob),
        "state_bytes": blob.len(),
        "leaves": leaves,
        "log_sealed": log_sealed,
        "log_size": st.core.log_size(),
        "log_root": hex::encode(st.core.log_root()),
    }))
}
