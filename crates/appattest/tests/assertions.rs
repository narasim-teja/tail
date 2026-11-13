//! The real vector is the `tail-attest` run of the S3 spike: an iPhone 17 Pro signed two
//! assertions over raw 32-byte clientDataHashes, exactly as the game signs batches. Each
//! negative test breaks one of Apple's checks on that real assertion; each has a twin showing
//! the unbroken input passes.

use appattest::{
    public_key, public_key_bytes, sign_assertion, verify_assertion, verify_attestation, Environment, Step,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use ciborium::Value;
use p256::ecdsa::{SigningKey, VerifyingKey};
use serde::Deserialize;
use sha2::{Digest, Sha256};

const VECTOR: &str = include_str!("data/s3-tail-attest.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Assertion {
    client_data: String,
    client_data_hash: String,
    object: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vector {
    app_id: String,
    captured_at_unix_s: u64,
    attestation: String,
    attestation_client_data_hash: String,
    assertions: Vec<Assertion>,
}

fn b64(s: &str) -> Vec<u8> {
    STANDARD.decode(s).unwrap()
}

struct Real {
    app_id: String,
    key: VerifyingKey,
    // (assertion object, clientDataHash)
    assertions: Vec<(Vec<u8>, [u8; 32])>,
}

fn real() -> Real {
    let v: Vector = serde_json::from_str(VECTOR).unwrap();
    // The key the assertions are checked against is the one the attestation proves.
    let attested_over: [u8; 32] = b64(&v.attestation_client_data_hash).try_into().unwrap();
    let key = verify_attestation(
        &b64(&v.attestation),
        &attested_over,
        &v.app_id,
        Environment::Development,
        v.captured_at_unix_s,
    )
    .unwrap();
    let assertions = v
        .assertions
        .iter()
        .map(|a| {
            let hash: [u8; 32] = b64(&a.client_data_hash).try_into().unwrap();
            assert_eq!(Sha256::digest(b64(&a.client_data)).as_slice(), hash);
            (b64(&a.object), hash)
        })
        .collect();
    Real {
        app_id: v.app_id,
        key,
        assertions,
    }
}

// Rebuilds an assertion CBOR map with one byte string changed.
fn rebuild(obj: &[u8], f: impl Fn(&str, &mut Vec<u8>)) -> Vec<u8> {
    let Value::Map(m) = ciborium::de::from_reader::<Value, _>(obj).unwrap() else {
        panic!("assertion is a map")
    };
    let m = m
        .into_iter()
        .map(|(k, v)| {
            let (Value::Text(name), Value::Bytes(mut b)) = (k.clone(), v) else {
                panic!("text keys, byte values")
            };
            f(&name, &mut b);
            (k, Value::Bytes(b))
        })
        .collect();
    let mut out = Vec::new();
    ciborium::ser::into_writer(&Value::Map(m), &mut out).unwrap();
    out
}

#[test]
fn real_iphone_assertions_verify_with_increasing_counters() {
    let r = real();
    let mut prev = 0;
    for (obj, hash) in &r.assertions {
        prev = verify_assertion(&r.key, obj, hash, &r.app_id, prev).unwrap();
    }
    assert_eq!(prev, 2);
}

#[test]
fn an_assertion_for_another_app_fails_the_rp_id_check() {
    let r = real();
    let (obj, hash) = &r.assertions[0];
    let e = verify_assertion(&r.key, obj, hash, "LKABS9RZAC.com.other.app", 0).unwrap_err();
    assert_eq!(e.step, Step::RpId);
    assert!(verify_assertion(&r.key, obj, hash, &r.app_id, 0).is_ok());
}

#[test]
fn other_client_data_fails_the_signature() {
    let r = real();
    let (obj, hash) = &r.assertions[0];
    let mut other = *hash;
    other[0] ^= 1;
    assert_eq!(
        verify_assertion(&r.key, obj, &other, &r.app_id, 0)
            .unwrap_err()
            .step,
        Step::Signature
    );
    assert!(verify_assertion(&r.key, obj, hash, &r.app_id, 0).is_ok());
}

#[test]
fn tampered_authenticator_data_fails_the_signature() {
    let r = real();
    let (obj, hash) = &r.assertions[0];
    // Raising the counter by hand is what a replaying relay would try.
    let bad = rebuild(obj, |k, b| {
        if k == "authenticatorData" {
            b[36] = 9;
        }
    });
    assert_eq!(
        verify_assertion(&r.key, &bad, hash, &r.app_id, 0)
            .unwrap_err()
            .step,
        Step::Signature
    );
    let same = rebuild(obj, |_, _| {});
    assert!(verify_assertion(&r.key, &same, hash, &r.app_id, 0).is_ok());
}

#[test]
fn a_tampered_signature_fails() {
    let r = real();
    let (obj, hash) = &r.assertions[0];
    let bad = rebuild(obj, |k, b| {
        if k == "signature" {
            let n = b.len();
            b[n - 1] ^= 1;
        }
    });
    assert_eq!(
        verify_assertion(&r.key, &bad, hash, &r.app_id, 0)
            .unwrap_err()
            .step,
        Step::Signature
    );
}

#[test]
fn a_replayed_counter_fails_and_a_fresh_one_passes() {
    let r = real();
    let (obj, hash) = &r.assertions[1];
    assert_eq!(verify_assertion(&r.key, obj, hash, &r.app_id, 1).unwrap(), 2);
    assert_eq!(
        verify_assertion(&r.key, obj, hash, &r.app_id, 2)
            .unwrap_err()
            .step,
        Step::Counter
    );
}

#[test]
fn another_devices_key_fails_the_signature() {
    let r = real();
    let (obj, hash) = &r.assertions[0];
    let stranger = *SigningKey::from_slice(&[7u8; 32]).unwrap().verifying_key();
    assert_eq!(
        verify_assertion(&stranger, obj, hash, &r.app_id, 0)
            .unwrap_err()
            .step,
        Step::Signature
    );
}

#[test]
fn garbage_is_a_decode_error() {
    let r = real();
    let e = verify_assertion(&r.key, &[0xff, 0x00], &[0; 32], &r.app_id, 0).unwrap_err();
    assert_eq!(e.step, Step::Decode);
    let short = rebuild(&r.assertions[0].0, |k, b| {
        if k == "authenticatorData" {
            b.truncate(36);
        }
    });
    let e = verify_assertion(&r.key, &short, &r.assertions[0].1, &r.app_id, 0).unwrap_err();
    assert_eq!(e.step, Step::Decode);
}

#[test]
fn the_enrolled_key_round_trips_through_its_sec1_bytes() {
    let r = real();
    let bytes = public_key_bytes(&r.key);
    assert_eq!(bytes[0], 4, "uncompressed point");
    assert_eq!(public_key(&bytes).unwrap(), r.key);
    assert_eq!(public_key(&bytes[..64]).unwrap_err().step, Step::Key);
}

#[test]
fn simulated_assertions_pass_the_same_verifier_as_real_ones() {
    let sk = SigningKey::from_slice(&[42u8; 32]).unwrap();
    let hash = [9u8; 32];
    let obj = sign_assertion(&sk, &hash, "TEAM.app", 5);
    assert_eq!(
        verify_assertion(sk.verifying_key(), &obj, &hash, "TEAM.app", 4).unwrap(),
        5
    );
    assert_eq!(
        verify_assertion(sk.verifying_key(), &obj, &hash, "TEAM.app", 5)
            .unwrap_err()
            .step,
        Step::Counter
    );
    assert_eq!(
        verify_assertion(sk.verifying_key(), &obj, &hash, "TEAM.other", 4)
            .unwrap_err()
            .step,
        Step::RpId
    );
}
