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
//!
//! `rebind_sig` carries no time, so a relay that kept an earlier move's attestation and
//! signature could replay them to put an App Attest key back that the account has since left.
//! The record keeps when Apple certified the stored key (`DeviceRecord::credential_not_before`),
//! and a move must bring an attestation certified later.

use crate::cmd::APP_ID;
use crate::codec::{b64, fixed_b64, from_b64, parse, to_borsh, uuid_string};
use crate::records::{device_record_key, enroll_receipt_digest, Device, DeviceRecord};
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
    /// new keys, base64 (64 bytes). Ignored when the account has no device stored.
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
/// over `client_data_hash`. Returns the credential certificate's notBefore (Unix s).
fn check_attested(
    attestation: &[u8],
    client_data_hash: &[u8; 32],
    claimed: &[u8; 65],
    now_unix_s: u64,
) -> Result<u64, String> {
    let attested =
        appattest::verify_attestation(attestation, client_data_hash, APP_ID, ENVIRONMENT, now_unix_s)
            .map_err(|e| format!("attestation refused: {e}"))?;
    if appattest::public_key_bytes(&attested.key) != *claimed {
        return Err("app_attest_pk is not the attested key".into());
    }
    Ok(attested.not_before_unix_s)
}

/// The record for this input. `now_unix_s` is the host wall clock (set by the TDX host, not
/// attested); it only bounds the certificates' validity windows, while the chain, the nonce and
/// the key binding are pure maths.
fn device(
    i: Input,
    allow_unattested: bool,
    now_unix_s: u64,
    call_id: CallId,
) -> Result<DeviceRecord, String> {
    account::validate(&i.account_id)?;
    let app_attest_pk = app_attest_key(&i.app_attest_pk)?;
    let player_box_pk = fixed_b64("player_box_pk", &i.player_box_pk)?;
    let near_pk = fixed_b64("near_pk", &i.near_pk)?;
    check_box_pk(&player_box_pk)?;
    // A ghost has no certificate, so no time: 0.
    let (attested, credential_not_before) = match (i.attestation, i.challenge) {
        (Some(attestation), Some(challenge)) => {
            let challenge = fixed_b64("challenge", &challenge)?;
            let hash = enroll_client_data_hash(&challenge, &i.account_id, &player_box_pk, &near_pk);
            let not_before = check_attested(
                &from_b64("attestation", &attestation)?,
                &hash,
                &app_attest_pk,
                now_unix_s,
            )?;
            (true, not_before)
        }
        (None, None) if allow_unattested => (false, 0),
        (None, None) => return Err(format!("attestation required ({ALLOW_UNATTESTED} is not set)")),
        _ => return Err("attestation and challenge come together".into()),
    };
    Ok(DeviceRecord {
        device: Device {
            account_id: i.account_id,
            app_attest_pk,
            attested,
            player_box_pk,
            near_pk,
            call_id,
        },
        credential_not_before,
    })
}

/// What enrolment does with the new device, given the one stored for the account.
#[derive(Debug, PartialEq, Eq)]
enum Admit {
    /// The same keys again: keep the stored record and return its receipt. An attestation of
    /// the same keys for a device stored as a ghost is `Store` instead.
    Keep,
    /// Store the new record: nothing was stored, or other keys with the stored device's consent
    /// and a later attestation, or the same keys now attested.
    Store,
}

/// With nothing stored the new device is stored and a `rebind_sig` is ignored: the phone sends
/// one whenever it has enrolled before, since it cannot know whether this referee holds its
/// account (a referee newly pinned, an earlier attempt that never answered).
fn admit(
    stored: Option<&DeviceRecord>,
    offered: &DeviceRecord,
    rebind_sig: Option<&[u8; 64]>,
) -> Result<Admit, String> {
    let Some(stored) = stored else {
        return Ok(Admit::Store);
    };
    let (old, new) = (&stored.device, &offered.device);
    let same_keys = old.app_attest_pk == new.app_attest_pk
        && old.player_box_pk == new.player_box_pk
        && old.near_pk == new.near_pk;
    if same_keys {
        return Ok(if new.attested && !old.attested {
            Admit::Store
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
    // The phone keeps its NEAR key across moves, so the stored `near_pk` also signed every
    // earlier move of this account: the signature alone cannot tell a replay from consent.
    // A ghost's 0 is never later, so an attested device is never moved to a ghost either.
    let stored_from = stored.credential_not_before;
    if stored_from != 0 && offered.credential_not_before <= stored_from {
        return Err(format!(
            "{} is enrolled with a key Apple certified at {stored_from} (Unix s): a move needs a later attestation",
            new.account_id
        ));
    }
    Ok(Admit::Store)
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
    let account_id = new.device.account_id.clone();
    let key = device_record_key(&account_id);
    let stored = host::storage_get(&key)?
        .map(|bytes| DeviceRecord::decode(&bytes).map(|r| (r, bytes)))
        .transpose()
        .map_err(|e| format!("device record of {account_id}: {e}"))?;
    let raced = || format!("{account_id} was enrolled by another call meanwhile; retry");
    // The writes are conditional on what was read, so of two enrolments racing for one account
    // only one lands. A match already started keeps the copy of the device it took at `start`.
    let record = match (
        admit(stored.as_ref().map(|(r, _)| r), &new, rebind_sig.as_ref())?,
        stored,
    ) {
        (Admit::Keep, Some((old, _))) => old,
        (_, None) => {
            if !host::storage_set_if_absent(&key, &new.encode())? {
                return Err(raced());
            }
            new
        }
        (Admit::Store, Some((_, old_bytes))) => {
            if !host::storage_replace(&key, &old_bytes, &new.encode())? {
                return Err(raced());
            }
            new
        }
    };
    let device = record.device;
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
    use crate::records::{Device, DeviceRecord};
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
        let attested =
            appattest::verify_attestation(&object, &hash, super::APP_ID, super::ENVIRONMENT, now).unwrap();
        appattest::public_key_bytes(&attested.key)
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
        // The credential certificate's notBefore, kept to order later moves.
        assert_eq!(check_attested(&object, &hash, &key, now), Ok(1_794_427_669));
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
        let r = device(input(&i), true, 0, [5; 16]).unwrap();
        assert!(!r.device.attested);
        assert_eq!(r.credential_not_before, 0, "a ghost has no certificate time");
        assert_eq!(r.device.app_attest_pk.to_vec(), g());
        assert_eq!(r.device.call_id, [5; 16]);
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

    /// A device whose box and NEAR keys come from `near_seed`, Apple-certified at `from` (0: a
    /// ghost). Its App Attest key is G for `attest_seed` 1 and G with a flipped last byte
    /// otherwise: not a point, but `admit` compares keys as bytes (`device` checks the curve).
    fn enrolled(near_seed: u8, attest_seed: u8, from: u64) -> DeviceRecord {
        let mut app_attest_pk: [u8; 65] = g().try_into().unwrap();
        app_attest_pk[64] ^= attest_seed - 1;
        DeviceRecord {
            device: Device {
                account_id: "alice.tail.testnet".into(),
                app_attest_pk,
                attested: from != 0,
                player_box_pk: tail_protocol::seal::public_key(&[near_seed; 32]),
                near_pk: SigningKey::from_bytes(&[near_seed; 32])
                    .verifying_key()
                    .to_bytes(),
                call_id: [near_seed; 16],
            },
            credential_not_before: from,
        }
    }

    fn rebind_sig(signer: u8, to: &DeviceRecord) -> [u8; 64] {
        let to = &to.device;
        let digest = rebind_digest(&to.account_id, &to.app_attest_pk, &to.player_box_pk, &to.near_pk);
        SigningKey::from_bytes(&[signer; 32]).sign(&digest).to_bytes()
    }

    #[test]
    fn with_nothing_stored_any_device_is_stored_and_a_rebind_sig_ignored() {
        let new = enrolled(1, 1, 100);
        assert_eq!(admit(None, &new, None), Ok(Admit::Store));
        // The phone sends one whenever it enrolled before, signed or not by a key this referee
        // has seen.
        assert_eq!(admit(None, &new, Some(&rebind_sig(1, &new))), Ok(Admit::Store));
        assert_eq!(admit(None, &new, Some(&[0; 64])), Ok(Admit::Store));
    }

    #[test]
    fn the_same_keys_again_keep_the_record_unless_now_attested() {
        let old = enrolled(1, 1, 0);
        assert_eq!(admit(Some(&old), &enrolled(1, 1, 0), None), Ok(Admit::Keep));
        assert_eq!(admit(Some(&old), &enrolled(1, 1, 100), None), Ok(Admit::Store));
        // An attested device is never downgraded to a ghost.
        assert_eq!(
            admit(Some(&enrolled(1, 1, 100)), &enrolled(1, 1, 0), None),
            Ok(Admit::Keep)
        );
        // Attested again, with or without a rebind_sig: idempotent, whatever the time.
        let stored = enrolled(1, 1, 100);
        for from in [50, 100, 200] {
            let again = enrolled(1, 1, from);
            assert_eq!(admit(Some(&stored), &again, None), Ok(Admit::Keep));
            assert_eq!(
                admit(Some(&stored), &again, Some(&rebind_sig(1, &again))),
                Ok(Admit::Keep)
            );
        }
    }

    #[test]
    fn other_keys_take_the_enrolled_devices_signature() {
        let old = enrolled(1, 1, 100);
        // The relay's own genuine iPhone, attested for this account: refused without consent.
        let new = enrolled(2, 2, 200);
        let err = admit(Some(&old), &new, None).unwrap_err();
        assert!(err.contains("rebind_sig"), "{err}");
        // Signed by the new device itself, not the enrolled one.
        assert!(admit(Some(&old), &new, Some(&rebind_sig(2, &new))).is_err());
        // The enrolled device's consent to some other keys.
        assert!(admit(Some(&old), &new, Some(&rebind_sig(1, &enrolled(3, 3, 200)))).is_err());
        assert_eq!(
            admit(Some(&old), &new, Some(&rebind_sig(1, &new))),
            Ok(Admit::Store)
        );
        // One changed key is a move too: the box key alone, or the App Attest key alone (an
        // App Attest key refresh: the phone keeps its box and NEAR keys).
        let mut box_only = old.clone();
        box_only.device.player_box_pk = tail_protocol::seal::public_key(&[9; 32]);
        box_only.credential_not_before = 200;
        let attest_only = enrolled(1, 2, 200);
        for moved in [box_only, attest_only] {
            let err = admit(Some(&old), &moved, None).unwrap_err();
            assert!(err.contains("rebind_sig"), "{err}");
            assert_eq!(
                admit(Some(&old), &moved, Some(&rebind_sig(1, &moved))),
                Ok(Admit::Store)
            );
        }
    }

    #[test]
    fn a_kept_attestation_cannot_move_the_account_back() {
        // The account moved from key 2 (certified at 100) to key 3 (at 200), keeping its NEAR
        // key, so that key signed both moves. The relay kept the first move's attestation and
        // signature and replays them.
        let stored = enrolled(1, 3, 200);
        let replayed = enrolled(1, 2, 100);
        let sig = rebind_sig(1, &replayed);
        let err = admit(Some(&stored), &replayed, Some(&sig)).unwrap_err();
        assert!(err.contains("later attestation"), "{err}");
        // An attestation certified in the same second is no later.
        let same_second = enrolled(1, 2, 200);
        assert!(admit(Some(&stored), &same_second, Some(&rebind_sig(1, &same_second))).is_err());
        // Nor is a ghost: an attested device does not move to a software key.
        let ghost = enrolled(1, 2, 0);
        assert!(admit(Some(&stored), &ghost, Some(&rebind_sig(1, &ghost))).is_err());
        // A newer attestation with the device's consent moves it.
        let newer = enrolled(1, 2, 300);
        assert_eq!(
            admit(Some(&stored), &newer, Some(&rebind_sig(1, &newer))),
            Ok(Admit::Store)
        );
        // A record from before the time was kept (0) orders nothing, as a ghost's.
        let legacy = enrolled(1, 3, 0);
        assert_eq!(
            admit(Some(&legacy), &replayed, Some(&rebind_sig(1, &replayed))),
            Ok(Admit::Store)
        );
    }

    #[test]
    fn a_retry_after_a_failed_attempt_replaces_it_with_the_same_near_key() {
        // The first attempt stored its record, then failed before the phone heard back. The
        // phone attests a fresh App Attest key, keeps its NEAR key, and signs the new keys.
        let failed = enrolled(1, 2, 100);
        let mut retry = enrolled(1, 3, 160);
        retry.device.player_box_pk = tail_protocol::seal::public_key(&[8; 32]);
        assert_eq!(
            admit(Some(&failed), &retry, Some(&rebind_sig(1, &retry))),
            Ok(Admit::Store)
        );
        // Without the signature it is a takeover like any other.
        assert!(admit(Some(&failed), &retry, None).is_err());
        // Once stored, the retry's own keys again are idempotent.
        assert_eq!(
            admit(Some(&retry), &retry.clone(), Some(&rebind_sig(1, &retry))),
            Ok(Admit::Keep)
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
