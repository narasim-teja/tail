//! App Attest assertion checks, following Apple's "Validating apps that connect to your server"
//! ("Verify the assertion"):
//!
//! 1. the caller computes clientDataHash (TAIL signs `SHA256("tail/batch" ‖ borsh(Batch))`
//!    directly, so this crate takes the hash, not the client data)
//! 2. nonce = SHA256(authenticatorData ‖ clientDataHash)
//! 3. the DER ECDSA signature is valid for nonce under the attested P-256 key
//! 4. authenticatorData RP ID hash = SHA256(App ID)
//! 5. counter strictly greater than the last one accepted for this key
//!
//! The attestation itself (certificate chain to Apple's root, its nonce) is checked once at
//! enrolment by the relay (TECHNICAL.md 4.4); [`credential_key`] only extracts the attested key
//! from it and binds it to the keyId.

use ciborium::Value;
use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
use sha2::{Digest, Sha256};
use std::fmt;
use x509_cert::der::Decode;
use x509_cert::Certificate;

pub use p256::ecdsa::VerifyingKey as PublicKey;

/// rpIdHash (32) ‖ flags (1) ‖ counter (4, big endian).
pub const AUTH_DATA_MIN_LEN: usize = 37;

/// Which of Apple's checks failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    /// Not CBOR, missing fields, short authenticatorData, not a certificate.
    Decode,
    /// The public key is not a P-256 point or does not hash to the keyId.
    Key,
    /// Steps 2-3: the signature does not verify over the nonce.
    Signature,
    /// Step 4: the assertion was made for another app.
    RpId,
    /// Step 5: the counter did not increase (replayed or reordered assertion).
    Counter,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Error {
    pub step: Step,
    pub msg: String,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.step, self.msg)
    }
}

impl std::error::Error for Error {}

fn err(step: Step, msg: impl Into<String>) -> Error {
    Error {
        step,
        msg: msg.into(),
    }
}

fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn cbor_map(bytes: &[u8], what: &str) -> Result<Vec<(Value, Value)>, Error> {
    let v: Value = ciborium::de::from_reader(bytes)
        .map_err(|e| err(Step::Decode, format!("{what} is not CBOR: {e}")))?;
    match v {
        Value::Map(m) => Ok(m),
        _ => Err(err(Step::Decode, format!("{what} is not a CBOR map"))),
    }
}

fn field<'a>(m: &'a [(Value, Value)], key: &str) -> Option<&'a Value> {
    m.iter()
        .find(|(k, _)| matches!(k, Value::Text(t) if t == key))
        .map(|(_, v)| v)
}

fn bytes_field<'a>(m: &'a [(Value, Value)], key: &str, what: &str) -> Result<&'a [u8], Error> {
    match field(m, key) {
        Some(Value::Bytes(b)) => Ok(b),
        _ => Err(err(Step::Decode, format!("{what} has no byte string '{key}'"))),
    }
}

/// Parses an enrolled device key (SEC1, as stored at enrolment: 65 bytes uncompressed).
pub fn public_key(sec1: &[u8]) -> Result<VerifyingKey, Error> {
    VerifyingKey::from_sec1_bytes(sec1).map_err(|_| err(Step::Key, "not a SEC1 P-256 public key"))
}

/// The SEC1 uncompressed encoding of a key (what enrolment stores and the referee keeps).
pub fn public_key_bytes(key: &VerifyingKey) -> [u8; 65] {
    key.to_sec1_point(false)
        .as_bytes()
        .try_into()
        .expect("an uncompressed P-256 point is 65 bytes")
}

/// The attested P-256 key: from the credential certificate (x5c[0]) of the attestation
/// object, checked against the keyId (keyId = SHA256(uncompressed public key)).
pub fn credential_key(attestation: &[u8], key_id: &[u8]) -> Result<VerifyingKey, Error> {
    let m = cbor_map(attestation, "attestation")?;
    let Some(Value::Map(stmt)) = field(&m, "attStmt") else {
        return Err(err(Step::Decode, "attestation has no attStmt map"));
    };
    let Some(Value::Array(chain)) = field(stmt, "x5c") else {
        return Err(err(Step::Decode, "attStmt.x5c missing"));
    };
    let Some(Value::Bytes(leaf)) = chain.first() else {
        return Err(err(Step::Decode, "attStmt.x5c[0] is not a certificate"));
    };
    let cert =
        Certificate::from_der(leaf).map_err(|e| err(Step::Decode, format!("credential certificate: {e}")))?;
    let point = cert
        .tbs_certificate()
        .subject_public_key_info()
        .subject_public_key
        .as_bytes()
        .ok_or_else(|| err(Step::Decode, "credential public key has unused bits"))?;
    if sha256(&[point]) != key_id {
        return Err(err(Step::Key, "SHA256(credential public key) is not the keyId"));
    }
    public_key(point)
}

/// Verifies one assertion over `client_data_hash` and returns its counter. `prev_counter` is the
/// last counter accepted for this key (0 right after attestation, whose counter is 0).
pub fn verify_assertion(
    key: &VerifyingKey,
    assertion: &[u8],
    client_data_hash: &[u8; 32],
    app_id: &str,
    prev_counter: u32,
) -> Result<u32, Error> {
    let m = cbor_map(assertion, "assertion")?;
    let sig_der = bytes_field(&m, "signature", "assertion")?;
    let auth = bytes_field(&m, "authenticatorData", "assertion")?;
    if auth.len() < AUTH_DATA_MIN_LEN {
        return Err(err(
            Step::Decode,
            format!(
                "authenticatorData is {} bytes, need {AUTH_DATA_MIN_LEN}",
                auth.len()
            ),
        ));
    }

    // Steps 2-3. ECDSA hashes its message with SHA-256, so the signature is over SHA256(nonce),
    // exactly as Apple's Secure Enclave produces it.
    let nonce = sha256(&[auth, client_data_hash]);
    let sig = Signature::from_der(sig_der).map_err(|_| err(Step::Signature, "signature is not DER ECDSA"))?;
    key.verify(&nonce, &sig)
        .map_err(|_| err(Step::Signature, "signature does not verify over nonce"))?;

    // Step 4.
    if auth[..32] != sha256(&[app_id.as_bytes()]) {
        return Err(err(Step::RpId, format!("rpIdHash is not SHA256(\"{app_id}\")")));
    }

    // Step 5.
    let counter = u32::from_be_bytes([auth[33], auth[34], auth[35], auth[36]]);
    if counter <= prev_counter {
        return Err(err(
            Step::Counter,
            format!("counter {counter} is not greater than {prev_counter}"),
        ));
    }
    Ok(counter)
}

/// Builds an assertion the way the Secure Enclave does: CBOR `{signature, authenticatorData}`
/// with authenticatorData = SHA256(app_id) ‖ flags 0 ‖ u32be(counter) and an ECDSA P-256
/// signature over SHA256(authenticatorData ‖ clientDataHash). Simulators and tests only: a real
/// device key never leaves the phone.
#[cfg(feature = "signer")]
pub fn sign_assertion(
    key: &p256::ecdsa::SigningKey,
    client_data_hash: &[u8; 32],
    app_id: &str,
    counter: u32,
) -> Vec<u8> {
    use p256::ecdsa::signature::Signer;
    let mut auth = Vec::with_capacity(AUTH_DATA_MIN_LEN);
    auth.extend_from_slice(&sha256(&[app_id.as_bytes()]));
    auth.push(0);
    auth.extend_from_slice(&counter.to_be_bytes());
    let nonce = sha256(&[&auth, client_data_hash]);
    let sig: Signature = key.sign(&nonce);
    let map = Value::Map(vec![
        (
            Value::Text("signature".into()),
            Value::Bytes(sig.to_der().as_bytes().to_vec()),
        ),
        (Value::Text("authenticatorData".into()), Value::Bytes(auth)),
    ]);
    let mut out = Vec::new();
    ciborium::ser::into_writer(&map, &mut out).expect("CBOR into a Vec cannot fail");
    out
}
