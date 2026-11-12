//! `enroll` (TECHNICAL.md 4.4): stores a device record and returns a receipt signed by the
//! verdict key. v1: the relay has verified the App Attest attestation object; from here on the
//! referee checks every assertion against the key stored here.

use crate::codec::{b64, fixed_b64, from_b64, parse, to_borsh, uuid_string};
use crate::records::{device_record_key, enroll_receipt_digest, Device};
use crate::{account, host};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    account_id: String,
    /// SEC1 P-256 public key, compressed (33) or uncompressed (65 bytes), base64.
    app_attest_pk: String,
    player_box_pk: String,
    near_pk: String,
}

/// Normalises to the 65-byte uncompressed form with the same check the engine applies at
/// `start`, so a bad key fails here and not when the match begins.
fn app_attest_key(b64_key: &str) -> Result<[u8; 65], String> {
    let bytes = from_b64("app_attest_pk", b64_key)?;
    let key = appattest::public_key(&bytes).map_err(|_| "app_attest_pk: not a P-256 public key")?;
    Ok(appattest::public_key_bytes(&key))
}

pub fn run(input: Value) -> Result<Value, String> {
    let i: Input = parse(input)?;
    account::validate(&i.account_id)?;
    let device = Device {
        account_id: i.account_id,
        app_attest_pk: app_attest_key(&i.app_attest_pk)?,
        player_box_pk: fixed_b64("player_box_pk", &i.player_box_pk)?,
        near_pk: fixed_b64("near_pk", &i.near_pk)?,
        call_id: host::call_id()?,
    };
    let receipt = to_borsh(&device);
    let sig = host::sign_digest(&enroll_receipt_digest(&device))?;
    // A re-enrolment (new phone, reinstalled app) replaces the record. A match already started
    // keeps the copy it took at `start`.
    host::storage_set(&device_record_key(&device.account_id), &receipt)?;
    Ok(json!({
        "account_id": device.account_id,
        "app_attest_pk": b64(&device.app_attest_pk),
        "call_id": uuid_string(&device.call_id),
        "receipt": b64(&receipt),
        "sig": b64(&sig),
    }))
}

#[cfg(test)]
mod tests {
    use super::app_attest_key;
    use crate::codec::b64;

    #[test]
    fn app_attest_key_checks_the_curve() {
        // The P-256 generator point, uncompressed.
        let g = hex::decode(
            "046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296\
             4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5",
        )
        .unwrap();
        assert_eq!(app_attest_key(&b64(&g)).unwrap().to_vec(), g);
        // Compressed G normalises to the same 65 bytes.
        let mut c = vec![0x03];
        c.extend_from_slice(&g[1..33]);
        assert_eq!(app_attest_key(&b64(&c)).unwrap().to_vec(), g);
        let mut off = g.clone();
        off[64] ^= 1;
        assert!(app_attest_key(&b64(&off)).is_err());
    }
}
