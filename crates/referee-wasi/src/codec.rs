//! Encodings at the JSON edge: base64 for bytes, hex where a value is usually read by people.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use borsh::BorshSerialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

pub fn b64(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

pub fn from_b64(field: &str, s: &str) -> Result<Vec<u8>, String> {
    STANDARD
        .decode(s)
        .map_err(|e| format!("{field}: not base64 ({e})"))
}

pub fn fixed_b64<const N: usize>(field: &str, s: &str) -> Result<[u8; N], String> {
    let v = from_b64(field, s)?;
    v.try_into()
        .map_err(|v: Vec<u8>| format!("{field}: expected {N} bytes, got {}", v.len()))
}

pub fn to_borsh<T: BorshSerialize>(v: &T) -> Vec<u8> {
    borsh::to_vec(v).expect("borsh serialization into a Vec cannot fail")
}

/// Parses a command's input into its typed shape; unknown fields are refused by each type.
pub fn parse<T: DeserializeOwned>(input: Value) -> Result<T, String> {
    serde_json::from_value(input).map_err(|e| format!("bad input: {e}"))
}

/// OutLayer call ids are UUID strings; verdicts carry their 16 bytes.
pub fn uuid_bytes(s: &str) -> Result<[u8; 16], String> {
    let groups: Vec<&str> = s.split('-').collect();
    let lens: Vec<usize> = groups.iter().map(|g| g.len()).collect();
    if lens != [8, 4, 4, 4, 12] {
        return Err(format!("call id {s:?} is not a UUID"));
    }
    let mut out = [0u8; 16];
    hex::decode_to_slice(groups.concat(), &mut out).map_err(|_| format!("call id {s:?} is not a UUID"))?;
    Ok(out)
}

pub fn uuid_string(b: &[u8; 16]) -> String {
    let h = hex::encode(b);
    format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuid_round_trip() {
        let s = "0193f2a4-7c1e-7b2a-9d4e-1f2a3b4c5d6e";
        let b = uuid_bytes(s).unwrap();
        assert_eq!(b[0], 0x01);
        assert_eq!(b[15], 0x6e);
        assert_eq!(uuid_string(&b), s);
    }

    #[test]
    fn uuid_rejects_other_shapes() {
        assert!(uuid_bytes("").is_err());
        assert!(uuid_bytes("0193f2a47c1e7b2a9d4e1f2a3b4c5d6e").is_err());
        assert!(uuid_bytes("0193f2a4-7c1e-7b2a-9d4e-1f2a3b4c5d6g").is_err());
    }

    #[test]
    fn fixed_b64_checks_length() {
        assert_eq!(fixed_b64::<2>("x", "AAE=").unwrap(), [0, 1]);
        assert!(fixed_b64::<3>("x", "AAE=")
            .unwrap_err()
            .contains("expected 3 bytes"));
    }
}
