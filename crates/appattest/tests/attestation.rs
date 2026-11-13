//! The real vector is the attestation of the `tail-attest` run of the S3 spike: an iPhone 17 Pro
//! attested its key over a raw 32-byte clientDataHash, exactly as enrolment does. Each negative
//! test breaks one of Apple's checks on that real object; the positive test shows the unbroken
//! input passes. The credential certificate is valid only from 2026-11-11T20:07:49Z to
//! 2026-11-14T20:07:49Z, so every check runs at the capture time.

use appattest::{public_key_bytes, verify_attestation, Environment, Step, APPLE_ROOT_DER, APPLE_ROOT_SHA256};
use base64::{engine::general_purpose::STANDARD, Engine};
use ciborium::Value;
use serde::Deserialize;
use sha2::{Digest, Sha256};

const VECTOR: &str = include_str!("data/s3-tail-attest.json");
const LEAF_NOT_BEFORE: u64 = 1_794_427_669; // 2026-11-11T20:07:49Z
const LEAF_NOT_AFTER: u64 = 1_794_686_869; // 2026-11-14T20:07:49Z

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vector {
    app_id: String,
    key_id: String,
    environment: String,
    captured_at_unix_s: u64,
    attestation: String,
    attestation_client_data: String,
    attestation_client_data_hash: String,
}

fn b64(s: &str) -> Vec<u8> {
    STANDARD.decode(s).unwrap()
}

struct Real {
    app_id: String,
    key_id: Vec<u8>,
    now: u64,
    object: Vec<u8>,
    client_data: Vec<u8>,
    hash: [u8; 32],
}

fn real() -> Real {
    let v: Vector = serde_json::from_str(VECTOR).unwrap();
    assert_eq!(v.environment, "development");
    let client_data = b64(&v.attestation_client_data);
    let hash: [u8; 32] = b64(&v.attestation_client_data_hash).try_into().unwrap();
    assert_eq!(Sha256::digest(&client_data).as_slice(), hash);
    Real {
        app_id: v.app_id,
        key_id: b64(&v.key_id),
        now: v.captured_at_unix_s,
        object: b64(&v.attestation),
        client_data,
        hash,
    }
}

fn verify(object: &[u8], hash: &[u8; 32], app_id: &str, env: Environment, now: u64) -> Result<(), Step> {
    verify_attestation(object, hash, app_id, env, now)
        .map(|_| ())
        .map_err(|e| e.step)
}

/// Rebuilds the attestation CBOR with `f` applied to its top-level map.
fn rebuild(object: &[u8], f: impl FnOnce(&mut Vec<(Value, Value)>)) -> Vec<u8> {
    let Value::Map(mut m) = ciborium::de::from_reader::<Value, _>(object).unwrap() else {
        panic!("attestation is a map")
    };
    f(&mut m);
    let mut out = Vec::new();
    ciborium::ser::into_writer(&Value::Map(m), &mut out).unwrap();
    out
}

fn entry<'a>(m: &'a mut [(Value, Value)], key: &str) -> &'a mut Value {
    &mut m
        .iter_mut()
        .find(|(k, _)| matches!(k, Value::Text(t) if t == key))
        .unwrap()
        .1
}

fn x5c(m: &mut [(Value, Value)]) -> &mut Vec<Value> {
    let Value::Map(stmt) = entry(m, "attStmt") else {
        panic!("attStmt map")
    };
    let Value::Array(chain) = entry(stmt, "x5c") else {
        panic!("x5c array")
    };
    chain
}

fn cert_bytes(v: &mut Value) -> &mut Vec<u8> {
    let Value::Bytes(b) = v else {
        panic!("certificate bytes")
    };
    b
}

#[test]
fn the_real_iphone_attestation_verifies_and_yields_the_key_id_key() {
    let r = real();
    let key = verify_attestation(&r.object, &r.hash, &r.app_id, Environment::Development, r.now).unwrap();
    // Apple's keyId is SHA256 of the uncompressed key: the phone and the certificate agree.
    assert_eq!(Sha256::digest(public_key_bytes(&key)).as_slice(), r.key_id);
}

#[test]
fn the_pinned_root_is_apples() {
    assert_eq!(hex::encode(Sha256::digest(APPLE_ROOT_DER)), APPLE_ROOT_SHA256);
}

#[test]
fn another_challenge_fails_the_nonce() {
    let r = real();
    let mut cd = r.client_data.clone();
    cd[0] ^= 1; // the challenge is the first 32 bytes
    let other: [u8; 32] = Sha256::digest(&cd).into();
    let dev = Environment::Development;
    assert_eq!(verify(&r.object, &other, &r.app_id, dev, r.now), Err(Step::Nonce));
    assert_eq!(verify(&r.object, &r.hash, &r.app_id, dev, r.now), Ok(()));
}

#[test]
fn another_app_id_fails_the_rp_id_check() {
    let r = real();
    let dev = Environment::Development;
    assert_eq!(
        verify(&r.object, &r.hash, "LKABS9RZAC.com.other.app", dev, r.now),
        Err(Step::RpId)
    );
}

#[test]
fn a_development_key_is_not_a_production_one() {
    let r = real();
    assert_eq!(
        verify(&r.object, &r.hash, &r.app_id, Environment::Production, r.now),
        Err(Step::Aaguid)
    );
}

#[test]
fn a_tampered_credential_certificate_fails_the_chain() {
    let r = real();
    // The subject CN is the hex keyId; changing one digit keeps the DER valid but breaks the
    // intermediate's signature.
    let cn = hex::encode(&r.key_id);
    let tampered = rebuild(&r.object, |m| {
        let leaf = cert_bytes(&mut x5c(m)[0]);
        let at = leaf.windows(cn.len()).position(|w| w == cn.as_bytes()).unwrap();
        leaf[at] = if leaf[at] == b'0' { b'1' } else { b'0' };
    });
    let dev = Environment::Development;
    assert_eq!(
        verify(&tampered, &r.hash, &r.app_id, dev, r.now),
        Err(Step::Chain)
    );
}

#[test]
fn a_tampered_intermediate_fails_the_chain() {
    let r = real();
    let tampered = rebuild(&r.object, |m| {
        let ca = cert_bytes(&mut x5c(m)[1]);
        // The last byte is inside the root's signature over the intermediate.
        let last = ca.len() - 1;
        ca[last] ^= 1;
    });
    let dev = Environment::Development;
    assert_eq!(
        verify(&tampered, &r.hash, &r.app_id, dev, r.now),
        Err(Step::Chain)
    );
}

#[test]
fn a_chain_without_apples_intermediate_is_refused() {
    let r = real();
    let dev = Environment::Development;
    // Leaf presented as signed by the root itself: wrong issuer.
    let to_root = rebuild(&r.object, |m| x5c(m)[1] = Value::Bytes(APPLE_ROOT_DER.to_vec()));
    assert_eq!(verify(&to_root, &r.hash, &r.app_id, dev, r.now), Err(Step::Chain));
    // The leaf as its own issuer.
    let self_issued = rebuild(&r.object, |m| {
        let leaf = x5c(m)[0].clone();
        x5c(m)[1] = leaf;
    });
    assert_eq!(
        verify(&self_issued, &r.hash, &r.app_id, dev, r.now),
        Err(Step::Chain)
    );
    let only_leaf = rebuild(&r.object, |m| {
        x5c(m).truncate(1);
    });
    assert_eq!(
        verify(&only_leaf, &r.hash, &r.app_id, dev, r.now),
        Err(Step::Decode)
    );
}

#[test]
fn certificates_are_checked_at_the_given_time() {
    let r = real();
    let dev = Environment::Development;
    assert_eq!(
        verify(&r.object, &r.hash, &r.app_id, dev, LEAF_NOT_BEFORE),
        Ok(())
    );
    assert_eq!(verify(&r.object, &r.hash, &r.app_id, dev, LEAF_NOT_AFTER), Ok(()));
    assert_eq!(
        verify(&r.object, &r.hash, &r.app_id, dev, LEAF_NOT_BEFORE - 1),
        Err(Step::Chain)
    );
    assert_eq!(
        verify(&r.object, &r.hash, &r.app_id, dev, LEAF_NOT_AFTER + 1),
        Err(Step::Chain)
    );
}

#[test]
fn a_nonzero_counter_is_caught_by_the_nonce() {
    // The certificate commits to authData, so a changed counter cannot keep a valid nonce.
    // `check_attested_auth_data` refuses the counter itself (unit test in src/lib.rs).
    let r = real();
    let tampered = rebuild(&r.object, |m| {
        let Value::Bytes(auth) = entry(m, "authData") else {
            panic!("authData bytes")
        };
        auth[36] = 1;
    });
    let dev = Environment::Development;
    assert_eq!(
        verify(&tampered, &r.hash, &r.app_id, dev, r.now),
        Err(Step::Nonce)
    );
}

#[test]
fn another_format_or_garbage_is_a_decode_error() {
    let r = real();
    let dev = Environment::Development;
    let packed = rebuild(&r.object, |m| *entry(m, "fmt") = Value::Text("packed".into()));
    assert_eq!(verify(&packed, &r.hash, &r.app_id, dev, r.now), Err(Step::Decode));
    assert_eq!(
        verify(&[0xff, 0x00], &r.hash, &r.app_id, dev, r.now),
        Err(Step::Decode)
    );
    assert_eq!(verify(&[], &r.hash, &r.app_id, dev, r.now), Err(Step::Decode));
}
