//! `enroll` (TECHNICAL.md 4.4): verifies the phone's App Attest attestation here, stores a
//! device record and returns a receipt signed by the verdict key.
//!
//! The relay is untrusted. If it alone checked the attestation, it could enrol a software key
//! for an account, sign that account's batches, open the beacon keys sealed to a box key it
//! chose, and fake a tag. So the referee checks the attestation object itself: Apple's chain,
//! this app, and a clientDataHash it recomputes from the challenge and the very keys it stores
//! (`enroll_client_data_hash`, the same bytes as `enrollClientDataHash` in packages/protocol).

use crate::cmd::start::DEFAULT_APP_ID;
use crate::codec::{b64, fixed_b64, from_b64, parse, to_borsh, uuid_string};
use crate::records::{device_record_key, enroll_receipt_digest, Device};
use crate::{account, host};
use appattest::Environment;
use serde::Deserialize;
use serde_json::{json, Value};
use tail_protocol::digest::enroll_client_data_hash;
use tail_protocol::CallId;

/// The App ID whose attestations count. Pinned in the code (so the published wasm hash pins it)
/// rather than taken from the caller: a relay that could name the app could enrol keys attested
/// for an app of its own.
const APP_ID: &str = DEFAULT_APP_ID;
/// The phone app is signed with the development App Attest entitlement
/// (`apps/mobile/app.config.ts`); a TestFlight / App Store build changes both together.
const ENVIRONMENT: Environment = Environment::Development;
/// Author secret (on OutLayer) or process variable (local test referee) that, set to `1`, lets
/// `enroll` store a device without an attestation, as `attested: false`. Testnet only: it is
/// how ghost phones (simulators, scripts) join.
pub const ALLOW_UNATTESTED: &str = "ALLOW_UNATTESTED";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    account_id: String,
    /// SEC1 P-256 public key, compressed (33) or uncompressed (65 bytes), base64.
    app_attest_pk: String,
    player_box_pk: String,
    near_pk: String,
    /// The CBOR attestation object exactly as the phone sent it, base64. Absent only for a
    /// ghost.
    attestation: Option<String>,
    /// The 32-byte challenge the phone's attestation covers, base64.
    challenge: Option<String>,
}

/// Normalises to the 65-byte uncompressed form with the same check the engine applies at
/// `start`, so a bad key fails here and not when the match begins.
fn app_attest_key(b64_key: &str) -> Result<[u8; 65], String> {
    let bytes = from_b64("app_attest_pk", b64_key)?;
    let key = appattest::public_key(&bytes).map_err(|_| "app_attest_pk: not a P-256 public key")?;
    Ok(appattest::public_key_bytes(&key))
}

/// The referee seals the player's keys and HUDs to this key. A point of small order (all-zero
/// included) makes every X25519 shared secret one of a handful of known values, so anyone could
/// open them. X25519 clamps the scalar to a multiple of the cofactor 8, so the product is zero
/// exactly for those points.
fn check_box_pk(pk: &[u8; 32]) -> Result<(), String> {
    if x25519_dalek::x25519([0x55; 32], *pk) == [0; 32] {
        return Err("player_box_pk: a low-order X25519 point".into());
    }
    Ok(())
}

/// The attestation proves `claimed` was made in a real iPhone's Secure Enclave for `APP_ID`,
/// over `client_data_hash`.
fn check_attested(
    attestation: &[u8],
    client_data_hash: &[u8; 32],
    claimed: &[u8; 65],
    now_unix_s: u64,
) -> Result<(), String> {
    let key = appattest::verify_attestation(attestation, client_data_hash, APP_ID, ENVIRONMENT, now_unix_s)
        .map_err(|e| format!("attestation refused: {e}"))?;
    if appattest::public_key_bytes(&key) != *claimed {
        return Err("app_attest_pk is not the attested key".into());
    }
    Ok(())
}

/// The record for this input. `now_unix_s` is the host wall clock (set by the TDX host, not
/// attested); it only bounds the certificates' validity windows, while the chain, the nonce and
/// the key binding are pure maths.
fn device(i: Input, allow_unattested: bool, now_unix_s: u64, call_id: CallId) -> Result<Device, String> {
    account::validate(&i.account_id)?;
    let app_attest_pk = app_attest_key(&i.app_attest_pk)?;
    let player_box_pk = fixed_b64("player_box_pk", &i.player_box_pk)?;
    let near_pk = fixed_b64("near_pk", &i.near_pk)?;
    check_box_pk(&player_box_pk)?;
    let attested = match (i.attestation, i.challenge) {
        (Some(attestation), Some(challenge)) => {
            let challenge = fixed_b64("challenge", &challenge)?;
            let hash = enroll_client_data_hash(&challenge, &i.account_id, &player_box_pk, &near_pk);
            check_attested(
                &from_b64("attestation", &attestation)?,
                &hash,
                &app_attest_pk,
                now_unix_s,
            )?;
            true
        }
        (None, None) if allow_unattested => false,
        (None, None) => return Err(format!("attestation required ({ALLOW_UNATTESTED} is not set)")),
        _ => return Err("attestation and challenge come together".into()),
    };
    Ok(Device {
        account_id: i.account_id,
        app_attest_pk,
        attested,
        player_box_pk,
        near_pk,
        call_id,
    })
}

pub fn run(input: Value) -> Result<Value, String> {
    let i: Input = parse(input)?;
    let allow_unattested = host::author_secret(ALLOW_UNATTESTED).as_deref() == Some("1");
    let device = device(i, allow_unattested, host::wall_ms() / 1000, host::call_id()?)?;
    let receipt = to_borsh(&device);
    let sig = host::sign_digest(&enroll_receipt_digest(&device))?;
    // A re-enrolment (new phone, reinstalled app) replaces the record. A match already started
    // keeps the copy it took at `start`.
    host::storage_set(&device_record_key(&device.account_id), &receipt)?;
    Ok(json!({
        "account_id": device.account_id,
        "app_attest_pk": b64(&device.app_attest_pk),
        "attested": device.attested,
        "call_id": uuid_string(&device.call_id),
        "receipt": b64(&receipt),
        "sig": b64(&sig),
    }))
}

#[cfg(test)]
mod tests {
    use super::{app_attest_key, check_attested, check_box_pk, device, Input};
    use crate::codec::b64;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use serde_json::{json, Value};

    /// The S3 spike's real iPhone attestation (crates/appattest/tests/data).
    const VECTOR: &str = include_str!("../../../appattest/tests/data/s3-tail-attest.json");

    fn vector() -> Value {
        serde_json::from_str(VECTOR).unwrap()
    }

    fn unb64(v: &Value) -> Vec<u8> {
        STANDARD.decode(v.as_str().unwrap()).unwrap()
    }

    /// The spike's attested key, uncompressed (keyId = SHA256 of it, checked in crates/appattest).
    fn real_key(v: &Value) -> [u8; 65] {
        let object = unb64(&v["attestation"]);
        let hash: [u8; 32] = unb64(&v["attestationClientDataHash"]).try_into().unwrap();
        let now = v["capturedAtUnixS"].as_u64().unwrap();
        let key =
            appattest::verify_attestation(&object, &hash, super::APP_ID, super::ENVIRONMENT, now).unwrap();
        appattest::public_key_bytes(&key)
    }

    fn input(v: &Value) -> Input {
        serde_json::from_value(v.clone()).unwrap()
    }

    fn ghost() -> Value {
        json!({
            "account_id": "ghost-a.tail.testnet",
            "app_attest_pk": b64(&g()),
            "player_box_pk": b64(&[9; 32]),
            "near_pk": b64(&[2; 32]),
        })
    }

    /// The P-256 generator point, uncompressed.
    fn g() -> Vec<u8> {
        hex::decode(
            "046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296\
             4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5",
        )
        .unwrap()
    }

    #[test]
    fn app_attest_key_checks_the_curve() {
        let g = g();
        assert_eq!(app_attest_key(&b64(&g)).unwrap().to_vec(), g);
        // Compressed G normalises to the same 65 bytes.
        let mut c = vec![0x03];
        c.extend_from_slice(&g[1..33]);
        assert_eq!(app_attest_key(&b64(&c)).unwrap().to_vec(), g);
        let mut off = g.clone();
        off[64] ^= 1;
        assert!(app_attest_key(&b64(&off)).is_err());
    }

    #[test]
    fn a_real_attestation_vouches_only_for_its_own_key() {
        let v = vector();
        let object = unb64(&v["attestation"]);
        let hash: [u8; 32] = unb64(&v["attestationClientDataHash"]).try_into().unwrap();
        let now = v["capturedAtUnixS"].as_u64().unwrap();
        let key = real_key(&v);
        assert_eq!(check_attested(&object, &hash, &key, now), Ok(()));
        let other: [u8; 65] = g().try_into().unwrap();
        assert_eq!(
            check_attested(&object, &hash, &other, now),
            Err("app_attest_pk is not the attested key".into())
        );
    }

    #[test]
    fn an_attestation_over_other_bindings_is_refused() {
        // The spike attested over its fields without the "tail/enroll/v1" domain, so the
        // referee's own clientDataHash of the same fields differs and the nonce fails: the
        // relay cannot reuse a phone's attestation for keys or an account it picks.
        let v = vector();
        let e = &v["enroll"];
        let mut i = json!({
            "account_id": e["accountId"],
            "app_attest_pk": b64(&real_key(&v)),
            "player_box_pk": e["playerBoxPk"],
            "near_pk": e["nearPk"],
            "attestation": v["attestation"],
            "challenge": e["challenge"],
        });
        let now = v["capturedAtUnixS"].as_u64().unwrap();
        let err = device(input(&i), true, now, [0; 16]).unwrap_err();
        assert!(err.starts_with("attestation refused: Nonce"), "{err}");
        i["near_pk"] = json!(b64(&[7; 32]));
        let err = device(input(&i), true, now, [0; 16]).unwrap_err();
        assert!(err.starts_with("attestation refused: Nonce"), "{err}");
    }

    #[test]
    fn an_unattested_device_needs_the_switch_and_is_marked() {
        let i = ghost();
        let err = device(input(&i), false, 0, [0; 16]).unwrap_err();
        assert!(err.contains("ALLOW_UNATTESTED"), "{err}");
        let d = device(input(&i), true, 0, [5; 16]).unwrap();
        assert!(!d.attested);
        assert_eq!(d.app_attest_pk.to_vec(), g());
        assert_eq!(d.call_id, [5; 16]);
    }

    #[test]
    fn attestation_and_challenge_come_together() {
        let v = vector();
        let mut i = ghost();
        i["attestation"] = v["attestation"].clone();
        assert!(device(input(&i), true, 0, [0; 16]).is_err());
        let mut i = ghost();
        i["challenge"] = json!(b64(&[1; 32]));
        assert!(device(input(&i), true, 0, [0; 16]).is_err());
    }

    #[test]
    fn low_order_box_keys_are_refused() {
        // u = 0, 1, an order-8 point, p - 1, p, and p + 1 (non-canonical encodings of 0 and 1).
        let low = [
            "0000000000000000000000000000000000000000000000000000000000000000",
            "0100000000000000000000000000000000000000000000000000000000000000",
            "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
            "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
            "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
            "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
        ];
        for h in low {
            let pk: [u8; 32] = hex::decode(h).unwrap().try_into().unwrap();
            assert!(check_box_pk(&pk).is_err(), "{h}");
            let mut i = ghost();
            i["player_box_pk"] = json!(b64(&pk));
            assert!(device(input(&i), true, 0, [0; 16]).is_err(), "{h}");
        }
        let real = tail_protocol::seal::public_key(&[3; 32]);
        assert_eq!(check_box_pk(&real), Ok(()));
    }
}
