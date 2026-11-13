//! `enroll` (TECHNICAL.md 4.4): verifies the phone's App Attest attestation here, stores a
//! device record and returns a receipt signed by the verdict key.
//!
//! The relay is untrusted. If it alone checked the attestation, it could enrol a software key
//! for an account, sign that account's batches, open the beacon keys sealed to a box key it
//! chose, and fake a tag. So the referee checks the attestation object itself: Apple's chain,
//! this app, and a clientDataHash it recomputes from the challenge and the very keys it stores
//! (`enroll_client_data_hash`, the same bytes as `enrollClientDataHash` in packages/protocol).
//!
//! An account keeps the device it first enrolled. Moving it to other keys takes `rebind_sig`, the
//! enrolled device's NEAR key signing the new keys (`rebind_digest`): otherwise a relay holding a
//! genuine iPhone of its own could attest it for someone else's account and take over their
//! seat. Enrolling the same keys again changes nothing and returns the stored receipt, so a call
//! that timed out on the way back is safe to repeat.

use crate::cmd::APP_ID;
use crate::codec::{b64, fixed_b64, from_b64, parse, to_borsh, uuid_string};
use crate::records::{device_record_key, enroll_receipt_digest, Device};
use crate::{account, host};
use appattest::Environment;
use serde::Deserialize;
use serde_json::{json, Value};
use tail_protocol::digest::{enroll_client_data_hash, rebind_digest};
use tail_protocol::CallId;
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
    /// Only to move an enrolled account to other keys: ed25519 by the enrolled device's
    /// `near_pk` over `rebind_digest(account_id, app_attest_pk, player_box_pk, near_pk)` of the
    /// new keys, base64 (64 bytes).
    #[serde(default)]
    rebind_sig: Option<String>,
}

/// Normalises to the 65-byte uncompressed form with the same check the engine applies at
/// `start`, so a bad key fails here and not when the match begins.
fn app_attest_key(b64_key: &str) -> Result<[u8; 65], String> {
    let bytes = from_b64("app_attest_pk", b64_key)?;
    let key = appattest::public_key(&bytes).map_err(|_| "app_attest_pk: not a P-256 public key")?;
    Ok(appattest::public_key_bytes(&key))
}

/// The referee seals the player's keys and HUDs to this key. With a point of small order the
/// X25519 shared secret is all zeros whatever the secret, so anyone could open them. Sealing
/// refuses such a key too (`tail_protocol::seal`); refusing it here stops it before a match.
fn check_box_pk(pk: &[u8; 32]) -> Result<(), String> {
    if tail_protocol::seal::is_low_order(pk) {
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

/// What enrolment does when the account already has a device stored. With none stored, the new
/// one is stored, and a `rebind_sig` is ignored: a phone that cannot know whether this referee
/// holds its account (a retry, a referee newly pinned) may send one anyway.
#[derive(Debug, PartialEq, Eq)]
enum Admit {
    /// The same keys again: keep the stored record and return its receipt. An attestation of
    /// the same keys for a device stored as a ghost is `Replace` instead.
    Keep,
    /// Other keys, with the stored device's consent (or the same keys, now attested).
    Replace,
}

fn admit(old: &Device, new: &Device, rebind_sig: Option<&[u8; 64]>) -> Result<Admit, String> {
    let same_keys = old.app_attest_pk == new.app_attest_pk
        && old.player_box_pk == new.player_box_pk
        && old.near_pk == new.near_pk;
    if same_keys {
        return Ok(if new.attested && !old.attested {
            Admit::Replace
        } else {
            Admit::Keep
        });
    }
    let sig = rebind_sig.ok_or(format!(
        "{} is enrolled with another device: moving it takes rebind_sig from that device's NEAR key",
        new.account_id
    ))?;
    let digest = rebind_digest(
        &new.account_id,
        &new.app_attest_pk,
        &new.player_box_pk,
        &new.near_pk,
    );
    if !tail_protocol::verify::ed25519(&old.near_pk, &digest, sig) {
        return Err("rebind_sig is not the enrolled device's signature over these keys".into());
    }
    Ok(Admit::Replace)
}

pub fn run(input: Value) -> Result<Value, String> {
    let mut i: Input = parse(input)?;
    let rebind_sig = i
        .rebind_sig
        .take()
        .map(|s| fixed_b64::<64>("rebind_sig", &s))
        .transpose()?;
    let allow_unattested = host::author_secret(ALLOW_UNATTESTED).as_deref() == Some("1");
    let new = device(i, allow_unattested, host::wall_ms() / 1000, host::call_id()?)?;
    let key = device_record_key(&new.account_id);
    let stored = host::storage_get(&key)?
        .map(|bytes| borsh::from_slice::<Device>(&bytes).map(|d| (d, bytes)))
        .transpose()
        .map_err(|e| format!("device record of {}: {e}", new.account_id))?;
    let raced = || format!("{} was enrolled by another call meanwhile; retry", new.account_id);
    // The writes are conditional on what was read, so of two enrolments racing for one account
    // only one lands. A match already started keeps the copy of the device it took at `start`.
    let device = match stored {
        None => {
            if !host::storage_set_if_absent(&key, &to_borsh(&new))? {
                return Err(raced());
            }
            new
        }
        Some((old, old_bytes)) => match admit(&old, &new, rebind_sig.as_ref())? {
            Admit::Keep => old,
            Admit::Replace => {
                if !host::storage_replace(&key, &old_bytes, &to_borsh(&new))? {
                    return Err(raced());
                }
                new
            }
        },
    };
    let receipt = to_borsh(&device);
    let sig = host::sign_digest(&enroll_receipt_digest(&device))?;
    Ok(json!({
        "account_id": device.account_id,
        "app_attest_pk": b64(&device.app_attest_pk),
        "attested": device.attested,
        "call_id": uuid_string(&device.call_id),
        "receipt": b64(&receipt),
        "sig": b64(&sig),
        // The key that signed `sig`: the relay can tell which referee holds this device.
        "referee_pk": b64(&host::referee_pk()?),
    }))
}

#[cfg(test)]
mod tests {
    use super::{admit, app_attest_key, check_attested, check_box_pk, device, Admit, Input};
    use crate::codec::b64;
    use crate::records::Device;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use ed25519_dalek::{Signer, SigningKey};
    use serde_json::{json, Value};
    use tail_protocol::digest::rebind_digest;

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

    fn enrolled(near_seed: u8, attested: bool) -> Device {
        Device {
            account_id: "alice.tail.testnet".into(),
            app_attest_pk: g().try_into().unwrap(),
            attested,
            player_box_pk: tail_protocol::seal::public_key(&[near_seed; 32]),
            near_pk: SigningKey::from_bytes(&[near_seed; 32])
                .verifying_key()
                .to_bytes(),
            call_id: [near_seed; 16],
        }
    }

    fn rebind_sig(signer: u8, to: &Device) -> [u8; 64] {
        let digest = rebind_digest(&to.account_id, &to.app_attest_pk, &to.player_box_pk, &to.near_pk);
        SigningKey::from_bytes(&[signer; 32]).sign(&digest).to_bytes()
    }

    #[test]
    fn the_same_keys_again_keep_the_record_unless_now_attested() {
        let old = enrolled(1, false);
        assert_eq!(admit(&old, &enrolled(1, false), None), Ok(Admit::Keep));
        assert_eq!(admit(&old, &enrolled(1, true), None), Ok(Admit::Replace));
        // An attested device is never downgraded to a ghost.
        assert_eq!(
            admit(&enrolled(1, true), &enrolled(1, false), None),
            Ok(Admit::Keep)
        );
    }

    #[test]
    fn other_keys_take_the_enrolled_devices_signature() {
        let old = enrolled(1, true);
        // The relay's own genuine iPhone, attested for this account: refused without consent.
        let new = enrolled(2, true);
        let err = admit(&old, &new, None).unwrap_err();
        assert!(err.contains("rebind_sig"), "{err}");
        // Signed by the new device itself, not the enrolled one.
        assert!(admit(&old, &new, Some(&rebind_sig(2, &new))).is_err());
        // The enrolled device's consent to some other keys.
        assert!(admit(&old, &new, Some(&rebind_sig(1, &enrolled(3, true)))).is_err());
        assert_eq!(admit(&old, &new, Some(&rebind_sig(1, &new))), Ok(Admit::Replace));
        // One changed key is a move too.
        let mut box_only = old.clone();
        box_only.player_box_pk = tail_protocol::seal::public_key(&[9; 32]);
        assert!(admit(&old, &box_only, None).is_err());
        assert_eq!(
            admit(&old, &box_only, Some(&rebind_sig(1, &box_only))),
            Ok(Admit::Replace)
        );
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
