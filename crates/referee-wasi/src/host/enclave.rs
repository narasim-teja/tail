//! The OutLayer backend of `host`: the worker's keys, storage, VRF and environment, and WASI
//! for randomness and clocks. This is the deployed referee.

use super::Vrf;
use outlayer::{encryption_keys, env, signing_keys, storage, vrf};
use serde_json::Value;

/// `signing_keys` path of the verdict key (`caller: "none"`: one key for the project).
const VERDICT_KEY: &str = "verdicts";
/// `encryption_keys` path that seals tick state (`caller: "signer"`: the relay's key).
const STATE_KEY: &str = "state";

/// The call's input: the JSON the relay sent, on stdin.
pub fn input_json() -> Result<Option<Value>, serde_json::Error> {
    env::input_json()
}

/// The call's answer, on stdout.
pub fn output_json(value: &Value) -> Result<(), serde_json::Error> {
    env::output_json(value)
}

/// An author secret (`author_secrets` in the manifest), never the caller's (`require_owner`).
pub fn author_secret(name: &str) -> Option<String> {
    env::var(name).filter(|v| !v.is_empty())
}

/// A deployed referee without `NEARAI_API_KEY` is a broken deployment: `voice` refuses rather
/// than quietly serving template lines.
pub const NEARAI_KEY_OPTIONAL: bool = false;

fn host_var(name: &str) -> Result<String, String> {
    env::var(name)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("host did not set {name}"))
}

/// Only the project owner may drive the referee. The verdict key is `caller: "none"`, so any
/// account with a payment key could otherwise make this code sign a `Start` (or later a `Tag`)
/// for a match id of its choosing. All three names are set by the worker and stripped from
/// secret rows, so no caller can supply them. The `author_secrets` row (whitelisted to the
/// owner) already refuses other callers before the code runs; this check does not depend on
/// how that row's access condition is set.
pub fn require_owner() -> Result<(), String> {
    if host_var("OUTLAYER_EXECUTION_TYPE")? != "HTTPS" {
        return Err("the referee runs over HTTPS only".into());
    }
    let owner = host_var("OUTLAYER_PROJECT_OWNER")?;
    let sender = host_var("NEAR_SENDER_ID")?;
    let payer = host_var("NEAR_USER_ACCOUNT_ID")?;
    if sender != owner || payer != owner {
        return Err(format!("only the project owner {owner} may call the referee"));
    }
    // The referee reads only the author's own secrets (`author_secrets` in the manifest). A row
    // the call names would put the caller's variables in the environment next to them.
    if env::var("OUTLAYER_SECRETS_ROWS").is_some() {
        return Err("the referee takes no secret rows from the call".into());
    }
    Ok(())
}

/// The OutLayer call id as 16 UUID bytes; every verdict carries it so the replay can fetch
/// the call's attestation record (`/attestations/by-call/{id}`).
pub fn call_id() -> Result<[u8; 16], String> {
    crate::codec::uuid_bytes(&host_var("OUTLAYER_CALL_ID")?)
}

/// Secret randomness from `wasi:random/random` (the host's CSPRNG).
pub fn random<const N: usize>() -> [u8; N] {
    let v = wasi::random::random::get_random_bytes(N as u64);
    v.try_into()
        .expect("wasi:random returns exactly the length asked for")
}

pub fn referee_pk() -> Result<[u8; 32], String> {
    let pk = signing_keys::public_key(VERDICT_KEY, None).map_err(|e| format!("verdict key: {e}"))?;
    pk.try_into().map_err(|v: Vec<u8>| {
        format!(
            "verdict key: expected a 32-byte ed25519 key, got {} bytes",
            v.len()
        )
    })
}

/// Signs a 32-byte digest that this module composed under one of its fixed domains. Never
/// pass caller bytes here: the key is the project's voice.
pub fn sign_digest(digest: &[u8; 32]) -> Result<[u8; 64], String> {
    let sig = signing_keys::sign(VERDICT_KEY, None, digest).map_err(|e| format!("sign: {e}"))?;
    sig.try_into()
        .map_err(|v: Vec<u8>| format!("sign: expected a 64-byte signature, got {} bytes", v.len()))
}

pub fn encrypt_state(plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, String> {
    encryption_keys::encrypt(STATE_KEY, None, plaintext, aad).map_err(|e| format!("seal state: {e}"))
}

pub fn decrypt_state(ciphertext: &[u8], aad: &[u8]) -> Result<Vec<u8>, String> {
    encryption_keys::decrypt(STATE_KEY, None, ciphertext, aad)
        .map_err(|_| "state blob does not open: not sealed by this referee for this match".into())
}

pub fn storage_get(key: &str) -> Result<Option<Vec<u8>>, String> {
    storage::get(key).map_err(|e| format!("storage get {key}: {e}"))
}

pub fn storage_set(key: &str, value: &[u8]) -> Result<(), String> {
    storage::set(key, value).map_err(|e| format!("storage set {key}: {e}"))
}

pub fn storage_set_if_absent(key: &str, value: &[u8]) -> Result<bool, String> {
    storage::set_if_absent(key, value).map_err(|e| format!("storage set_if_absent {key}: {e}"))
}

/// Compare-and-swap; `Ok(false)` when another run changed or removed the record first.
pub fn storage_replace(key: &str, expected: &[u8], value: &[u8]) -> Result<bool, String> {
    storage::set_if_equals(key, expected, value)
        .map(|(swapped, _)| swapped)
        .map_err(|e| format!("storage set_if_equals {key}: {e}"))
}

/// One OutLayer VRF output: `signature` = ed25519(vrf_sk, alpha), alpha =
/// `vrf:{request_id}:{sender}:{seed}`, set by the worker except for the seed.
pub fn vrf(seed: &str) -> Result<Vrf, String> {
    let r = vrf::random(seed).map_err(|e| format!("vrf: {e}"))?;
    let mut signature = [0u8; 64];
    hex::decode_to_slice(&r.signature_hex, &mut signature).map_err(|_| {
        format!(
            "vrf: signature is not 64 bytes of hex ({} chars)",
            r.signature_hex.len()
        )
    })?;
    Ok(Vrf {
        alpha: r.alpha,
        signature,
    })
}

pub fn vrf_pk() -> Result<String, String> {
    vrf::public_key().map_err(|e| format!("vrf pubkey: {e}"))
}

/// Monotonic milliseconds, for timing inside the enclave.
pub fn now_ms() -> u64 {
    wasi::clocks::monotonic_clock::now() / 1_000_000
}

/// Host wall-clock time in Unix milliseconds. Not attested (the TDX host sets it); it only bounds
/// how far ahead of real time a caller may push the referee clock (`tick`).
pub fn wall_ms() -> u64 {
    let t = wasi::clocks::wall_clock::now();
    t.seconds * 1000 + u64::from(t.nanoseconds / 1_000_000)
}
