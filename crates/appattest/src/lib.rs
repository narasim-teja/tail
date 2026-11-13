//! Apple App Attest checks, following Apple's "Validating apps that connect to your server".
//!
//! [`verify_attestation`] ("Verify the attestation", once per device at enrolment; the referee
//! runs it inside the enclave so the untrusted relay cannot enrol a key Apple never attested):
//!
//! 1. x5c = [credential certificate, intermediate], each validly signed by the next and inside
//!    its validity window, ending at the pinned Apple App Attestation Root CA
//! 2. nonce = SHA256(authenticatorData ‖ clientDataHash) (the caller computes clientDataHash)
//! 3. the credential certificate's extension 1.2.840.113635.100.8.2 holds that nonce
//! 4. the credential key is a P-256 point; credentialId = SHA256(that key, uncompressed)
//! 5. rpIdHash = SHA256(App ID), counter = 0, aaguid = the expected environment's
//!
//! [`verify_assertion`] ("Verify the assertion", every batch, in the engine):
//!
//! 1. the caller computes clientDataHash (TAIL signs `SHA256("tail/batch" ‖ borsh(Batch))`
//!    directly, so this crate takes the hash, not the client data)
//! 2. nonce = SHA256(authenticatorData ‖ clientDataHash)
//! 3. the DER ECDSA signature is valid for nonce under the attested P-256 key
//! 4. authenticatorData RP ID hash = SHA256(App ID)
//! 5. counter strictly greater than the last one accepted for this key

use ciborium::Value;
use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
use p384::ecdsa::signature::hazmat::PrehashVerifier;
use sha2::{Digest, Sha256, Sha384};
use std::fmt;
use x509_cert::der::asn1::{ContextSpecific, OctetString};
use x509_cert::der::oid::ObjectIdentifier;
use x509_cert::der::{AnyRef, Decode, Reader, SliceReader, TagNumber};
use x509_cert::ext::pkix::BasicConstraints;
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
    /// Step 5: the counter did not increase (replayed or reordered assertion), or an
    /// attestation's counter is not 0.
    Counter,
    /// Attestation step 1: a certificate is not signed by the next one up to Apple's root, is
    /// outside its validity window, or the intermediate is not a CA.
    Chain,
    /// Attestation steps 2-4: the credential certificate does not commit to
    /// SHA256(authenticatorData ‖ clientDataHash), so the key was attested over other data.
    Nonce,
    /// Attestation step 8: the aaguid is not the expected environment's.
    Aaguid,
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

/// Apple App Attestation Root CA (P-384), DER. Source:
/// https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem, the same
/// certificate as `packages/appattest/apple-app-attest-root-ca.pem`. Its SHA-256 is pinned in
/// [`APPLE_ROOT_SHA256`] and checked by the tests.
pub const APPLE_ROOT_DER: &[u8] = include_bytes!("../apple-app-attest-root-ca.der");
/// SHA-256 of [`APPLE_ROOT_DER`] (`APPLE_ROOT_SHA256` in `packages/appattest`).
pub const APPLE_ROOT_SHA256: &str = "1cb9823ba28ba6ad2d33a006941de2ae4f513ef1d4e831b9f7e0fa7b6242c932";

/// The credential certificate extension that carries the nonce.
const NONCE_OID: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.113635.100.8.2");
const ECDSA_WITH_SHA256: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.10045.4.3.2");
const ECDSA_WITH_SHA384: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.10045.4.3.3");

/// rpIdHash ‖ flags ‖ counter ‖ aaguid (16) ‖ credentialIdLength (2, big endian).
const ATTESTED_AUTH_DATA_MIN_LEN: usize = AUTH_DATA_MIN_LEN + 16 + 2;
/// authenticatorData flag AT: attested credential data (aaguid, credentialId) follows.
const FLAG_ATTESTED: u8 = 0x40;

/// Which App Attest environment the app was signed for (its `appattest-environment`
/// entitlement). Apple marks development keys so a debug build cannot pass for a release one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Environment {
    Development,
    Production,
}

impl Environment {
    /// The aaguid Apple writes into authenticatorData for this environment.
    pub fn aaguid(self) -> [u8; 16] {
        match self {
            Self::Development => *b"appattestdevelop",
            Self::Production => *b"appattest\0\0\0\0\0\0\0",
        }
    }
}

fn certificate(der: &[u8], what: &str) -> Result<Certificate, Error> {
    Certificate::from_der(der).map_err(|e| err(Step::Decode, format!("{what}: {e}")))
}

/// The exact TBSCertificate bytes a certificate's signature covers (re-encoding the parsed
/// structure could differ from what the issuer signed).
fn tbs_bytes(der: &[u8]) -> Result<&[u8], x509_cert::der::Error> {
    let mut r = SliceReader::new(der)?;
    let tbs = r.sequence(|r| {
        let tbs = r.tlv_bytes()?;
        AnyRef::decode(r)?; // signatureAlgorithm
        AnyRef::decode(r)?; // signatureValue
        Ok::<_, x509_cert::der::Error>(tbs)
    })?;
    r.finish()?;
    Ok(tbs)
}

/// Unix seconds of an X.509 time.
fn unix_s(t: x509_cert::time::Time) -> u64 {
    t.to_unix_duration().as_secs()
}

/// `cert` (DER `der`) was signed by `issuer`'s P-384 key and is valid at `now_unix_s`. Apple's
/// root and intermediate are both P-384; the intermediate signs with SHA-256, the root with
/// SHA-384.
fn check_issued(
    der: &[u8],
    cert: &Certificate,
    issuer: &Certificate,
    now_unix_s: u64,
    what: &str,
) -> Result<(), Error> {
    let tbs = cert.tbs_certificate();
    if tbs.issuer() != issuer.tbs_certificate().subject() {
        return Err(err(Step::Chain, format!("{what} names another issuer")));
    }
    let alg = cert.signature_algorithm();
    if tbs.signature() != alg {
        return Err(err(
            Step::Chain,
            format!("{what}: inner and outer signature algorithms differ"),
        ));
    }
    let signed = tbs_bytes(der).map_err(|e| err(Step::Decode, format!("{what}: {e}")))?;
    let prehash: Vec<u8> = if alg.oid == ECDSA_WITH_SHA256 {
        Sha256::digest(signed).to_vec()
    } else if alg.oid == ECDSA_WITH_SHA384 {
        Sha384::digest(signed).to_vec()
    } else {
        return Err(err(
            Step::Chain,
            format!("{what}: signature algorithm {} is not ECDSA SHA-256/384", alg.oid),
        ));
    };
    let issuer_point = issuer
        .tbs_certificate()
        .subject_public_key_info()
        .subject_public_key
        .as_bytes()
        .ok_or_else(|| err(Step::Decode, format!("{what}: issuer key has unused bits")))?;
    let issuer_key = p384::ecdsa::VerifyingKey::from_sec1_bytes(issuer_point)
        .map_err(|_| err(Step::Chain, format!("{what}: issuer key is not a P-384 point")))?;
    let sig_der = cert
        .signature()
        .as_bytes()
        .ok_or_else(|| err(Step::Decode, format!("{what}: signature has unused bits")))?;
    let sig = p384::ecdsa::Signature::from_der(sig_der)
        .map_err(|_| err(Step::Chain, format!("{what}: signature is not DER ECDSA P-384")))?;
    issuer_key
        .verify_prehash(&prehash, &sig)
        .map_err(|_| err(Step::Chain, format!("{what} is not signed by its issuer")))?;
    check_validity(cert, now_unix_s, what)
}

fn check_validity(cert: &Certificate, now_unix_s: u64, what: &str) -> Result<(), Error> {
    let v = cert.tbs_certificate().validity();
    let (from, until) = (unix_s(v.not_before), unix_s(v.not_after));
    if now_unix_s < from || now_unix_s > until {
        return Err(err(
            Step::Chain,
            format!("{what} is valid from {from} to {until} (Unix s), not at {now_unix_s}"),
        ));
    }
    Ok(())
}

/// The nonce in the credential certificate: `SEQUENCE { [1] EXPLICIT OCTET STRING }`.
fn certificate_nonce(cert: &Certificate) -> Result<Vec<u8>, Error> {
    let ext = cert
        .tbs_certificate()
        .extensions()
        .and_then(|exts| exts.iter().find(|e| e.extn_id == NONCE_OID))
        .ok_or_else(|| err(Step::Nonce, "credential certificate has no nonce extension"))?;
    let parse = |der: &[u8]| -> Result<Vec<u8>, x509_cert::der::Error> {
        let mut r = SliceReader::new(der)?;
        let nonce = r.sequence(|r| {
            let tagged = ContextSpecific::<OctetString>::decode_explicit(r, TagNumber(1))?
                .ok_or_else(|| x509_cert::der::Error::from(x509_cert::der::ErrorKind::Failed))?;
            Ok::<_, x509_cert::der::Error>(tagged.value.into_bytes().into_vec())
        })?;
        r.finish()?;
        Ok(nonce)
    };
    parse(ext.extn_value.as_bytes()).map_err(|e| err(Step::Nonce, format!("nonce extension: {e}")))
}

/// Attestation authenticatorData: rpIdHash ‖ flags ‖ counter ‖ aaguid ‖ credentialId (COSE key
/// after it is not needed: the key comes from the certificate). Checks Apple's steps 6-9 against
/// `point`, the credential certificate's uncompressed key.
fn check_attested_auth_data(
    auth: &[u8],
    app_id: &str,
    environment: Environment,
    point: &[u8],
) -> Result<(), Error> {
    if auth.len() < ATTESTED_AUTH_DATA_MIN_LEN {
        return Err(err(
            Step::Decode,
            format!(
                "authData is {} bytes, need {ATTESTED_AUTH_DATA_MIN_LEN}",
                auth.len()
            ),
        ));
    }
    if auth[32] & FLAG_ATTESTED == 0 {
        return Err(err(Step::Decode, "authData carries no attested credential data"));
    }
    let id_len = usize::from(u16::from_be_bytes([auth[53], auth[54]]));
    let Some(credential_id) = auth.get(55..55 + id_len) else {
        return Err(err(Step::Decode, "credentialId truncated"));
    };
    if auth[..32] != sha256(&[app_id.as_bytes()]) {
        return Err(err(Step::RpId, format!("rpIdHash is not SHA256(\"{app_id}\")")));
    }
    let counter = u32::from_be_bytes([auth[33], auth[34], auth[35], auth[36]]);
    if counter != 0 {
        return Err(err(
            Step::Counter,
            format!("attestation counter is {counter}, expected 0"),
        ));
    }
    if auth[37..53] != environment.aaguid() {
        return Err(err(
            Step::Aaguid,
            format!("aaguid is not the {environment:?} value"),
        ));
    }
    if credential_id != sha256(&[point]) {
        return Err(err(
            Step::Key,
            "credentialId is not SHA256(credential public key)",
        ));
    }
    Ok(())
}

/// Verifies an `apple-appattest` attestation object made over `client_data_hash` for `app_id`
/// in `environment`, with certificate validity checked at `now_unix_s`, and returns the attested
/// P-256 key. Everything the key is later trusted for rests on this: only a key that Apple
/// attested on a real device, for this app, over this exact clientDataHash, passes.
pub fn verify_attestation(
    attestation: &[u8],
    client_data_hash: &[u8; 32],
    app_id: &str,
    environment: Environment,
    now_unix_s: u64,
) -> Result<VerifyingKey, Error> {
    let m = cbor_map(attestation, "attestation")?;
    if !matches!(field(&m, "fmt"), Some(Value::Text(t)) if t == "apple-appattest") {
        return Err(err(Step::Decode, "fmt is not apple-appattest"));
    }
    let auth = bytes_field(&m, "authData", "attestation")?;
    let Some(Value::Map(stmt)) = field(&m, "attStmt") else {
        return Err(err(Step::Decode, "attestation has no attStmt map"));
    };
    let Some(Value::Array(x5c)) = field(stmt, "x5c") else {
        return Err(err(Step::Decode, "attStmt.x5c missing"));
    };
    let [Value::Bytes(leaf_der), Value::Bytes(ca_der)] = x5c.as_slice() else {
        return Err(err(
            Step::Decode,
            "attStmt.x5c is not [credential, intermediate] certificates",
        ));
    };

    // Step 1.
    let root = certificate(APPLE_ROOT_DER, "Apple root")?;
    let ca = certificate(ca_der, "intermediate certificate")?;
    let leaf = certificate(leaf_der, "credential certificate")?;
    check_validity(&root, now_unix_s, "Apple root")?;
    check_issued(ca_der, &ca, &root, now_unix_s, "intermediate certificate")?;
    let is_ca = ca
        .tbs_certificate()
        .get_extension::<BasicConstraints>()
        .map_err(|e| err(Step::Decode, format!("intermediate basicConstraints: {e}")))?
        .is_some_and(|(_, bc)| bc.ca);
    if !is_ca {
        return Err(err(Step::Chain, "intermediate certificate is not a CA"));
    }
    check_issued(leaf_der, &leaf, &ca, now_unix_s, "credential certificate")?;

    // Steps 2-4.
    if certificate_nonce(&leaf)? != sha256(&[auth, client_data_hash]) {
        return Err(err(Step::Nonce, "nonce is not SHA256(authData ‖ clientDataHash)"));
    }

    // Steps 5-9. The uncompressed encoding is what credentialId hashes.
    let point = leaf
        .tbs_certificate()
        .subject_public_key_info()
        .subject_public_key
        .as_bytes()
        .ok_or_else(|| err(Step::Decode, "credential public key has unused bits"))?;
    if point.len() != 65 || point[0] != 0x04 {
        return Err(err(
            Step::Key,
            "credential public key is not an uncompressed P-256 point",
        ));
    }
    let key = public_key(point)?;
    check_attested_auth_data(auth, app_id, environment, point)?;
    Ok(key)
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The real attestation's authData and credential key (tests/data/s3-tail-attest.json).
    fn real_auth_data() -> (Vec<u8>, Vec<u8>) {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let v: serde_json::Value =
            serde_json::from_str(include_str!("../tests/data/s3-tail-attest.json")).unwrap();
        let object = STANDARD.decode(v["attestation"].as_str().unwrap()).unwrap();
        let m = cbor_map(&object, "attestation").unwrap();
        let auth = bytes_field(&m, "authData", "attestation").unwrap().to_vec();
        let Some(Value::Map(stmt)) = field(&m, "attStmt") else {
            panic!("attStmt")
        };
        let Some(Value::Array(x5c)) = field(stmt, "x5c") else {
            panic!("x5c")
        };
        let Value::Bytes(leaf) = &x5c[0] else {
            panic!("leaf")
        };
        let leaf = Certificate::from_der(leaf).unwrap();
        let point = leaf
            .tbs_certificate()
            .subject_public_key_info()
            .subject_public_key
            .as_bytes()
            .unwrap()
            .to_vec();
        (auth, point)
    }

    const APP: &str = "LKABS9RZAC.com.lkabs9rzac.tail";
    const DEV: Environment = Environment::Development;

    fn step(auth: &[u8], point: &[u8]) -> Result<(), Step> {
        check_attested_auth_data(auth, APP, DEV, point).map_err(|e| e.step)
    }

    #[test]
    fn the_real_auth_data_passes() {
        let (auth, point) = real_auth_data();
        assert_eq!(step(&auth, &point), Ok(()));
    }

    #[test]
    fn a_nonzero_attestation_counter_is_refused() {
        let (mut auth, point) = real_auth_data();
        auth[36] = 1;
        assert_eq!(step(&auth, &point), Err(Step::Counter));
    }

    #[test]
    fn a_production_aaguid_is_not_a_development_one() {
        let (mut auth, point) = real_auth_data();
        auth[37..53].copy_from_slice(&Environment::Production.aaguid());
        assert_eq!(step(&auth, &point), Err(Step::Aaguid));
        assert_eq!(
            check_attested_auth_data(&auth, APP, Environment::Production, &point).map_err(|e| e.step),
            Ok(())
        );
    }

    #[test]
    fn the_credential_id_must_hash_the_certificate_key() {
        let (mut auth, point) = real_auth_data();
        auth[55] ^= 1;
        assert_eq!(step(&auth, &point), Err(Step::Key));
    }

    #[test]
    fn auth_data_without_attested_credential_data_is_refused() {
        let (mut auth, point) = real_auth_data();
        auth[32] &= !FLAG_ATTESTED;
        assert_eq!(step(&auth, &point), Err(Step::Decode));
        let (auth, point) = real_auth_data();
        assert_eq!(step(&auth[..60], &point), Err(Step::Decode));
        assert_eq!(step(&auth[..54], &point), Err(Step::Decode));
    }

    #[test]
    fn the_pinned_root_is_a_self_signed_p384_root() {
        let root = Certificate::from_der(APPLE_ROOT_DER).unwrap();
        // 2026-11-12: inside the root's 2020-2045 window.
        check_issued(APPLE_ROOT_DER, &root, &root, 1_794_514_082, "Apple root").unwrap();
    }
}
