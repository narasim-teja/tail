//! The golden vectors from packages/protocol (written by the TS side). Every value must be
//! reproduced byte for byte here, so TS and Rust cannot drift apart.

use borsh::BorshDeserialize;
use ed25519_dalek::{Signer, SigningKey, Verifier, VerifyingKey};
use serde_json::Value;
use tail_protocol::beacon::{
    beacon_tag, beacon_token, derive_player_key, derive_tag_key, resolve_token, tag_matches,
};
use tail_protocol::digest::{batch_client_data_hash, batch_hash, enroll_client_data_hash, verdict_digest};
use tail_protocol::seal::{open, public_key, seal_with, SealError};
use tail_protocol::{
    merkle, ring, Action, Batch, BatchEnvelope, Hud, LogEntry, PlayerKeys, SignedVerdict, Verdict,
};

fn load(name: &str) -> Value {
    let path = format!(
        "{}/../../packages/protocol/vectors/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))).unwrap()
}
fn bytes(v: &Value) -> Vec<u8> {
    hex::decode(v.as_str().expect("hex string")).expect("valid hex")
}
fn arr<const N: usize>(v: &Value) -> [u8; N] {
    bytes(v).try_into().expect("fixed length")
}

#[test]
fn beacon_keys_and_tokens_match() {
    let v = load("beacon");
    let km: [u8; 32] = arr(&v["K_m"]);
    let k_tag = derive_tag_key(&km);
    assert_eq!(k_tag, arr::<32>(&v["K_tag"]));
    let kp: Vec<[u8; 32]> = (0..3).map(|i| derive_player_key(&km, i)).collect();
    for (i, k) in kp.iter().enumerate() {
        assert_eq!(k, &arr::<32>(&v["K_p"][i]));
    }
    for t in v["tokens"].as_array().unwrap() {
        let player = t["player"].as_u64().unwrap() as usize;
        let epoch = t["epoch"].as_u64().unwrap() as u32;
        let token = beacon_token(&k_tag, &kp[player], epoch);
        assert_eq!(token, arr::<16>(&t["token"]));
        assert_eq!(beacon_tag(&k_tag, epoch), arr::<4>(&t["tag"]));
        assert!(tag_matches(&k_tag, &token, epoch));
        assert_eq!(resolve_token(&kp, &k_tag, &token, epoch), Some(player as u16));
        assert_eq!(resolve_token(&kp, &k_tag, &token, epoch + 2), None);
    }
}

#[test]
fn batch_round_trips_and_hashes_match() {
    let v = load("batch");
    let raw = bytes(&v["borsh"]);
    let b = Batch::try_from_slice(&raw).unwrap();
    assert_eq!(borsh::to_vec(&b).unwrap(), raw);
    assert_eq!(batch_hash(&b), arr::<32>(&v["hash"]));
    assert_eq!(batch_client_data_hash(&b), arr::<32>(&v["clientDataHash"]));
    assert_eq!(
        b.actions[0],
        Action::Hint {
            hint: 1,
            nonce: 42,
            text: Some("warmer? 🧊".into())
        }
    );
    assert_eq!(b.sightings[0].rssi_med, -128);

    let env = BatchEnvelope::try_from_slice(&bytes(&v["envelope"]["borsh"])).unwrap();
    assert_eq!(env.assertion, bytes(&v["envelope"]["assertion"]));

    let mut trailing = raw.clone();
    trailing.push(0);
    assert!(
        Batch::try_from_slice(&trailing).is_err(),
        "trailing bytes must be rejected"
    );

    let e = &v["enroll"];
    assert_eq!(
        enroll_client_data_hash(
            &arr(&e["challenge"]),
            e["accountId"].as_str().unwrap(),
            &arr(&e["playerBoxPk"]),
            &arr(&e["nearPk"]),
        ),
        arr::<32>(&e["clientDataHash"])
    );
}

#[test]
fn verdicts_digest_sign_and_verify_like_ts() {
    let v = load("verdicts");
    let sk = SigningKey::from_bytes(&arr(&v["refereeSeed"]));
    let pk = VerifyingKey::from_bytes(&arr(&v["refereePk"])).unwrap();
    assert_eq!(sk.verifying_key(), pk);
    for item in v["verdicts"].as_array().unwrap() {
        let raw = bytes(&item["signed"]);
        let sv = SignedVerdict::try_from_slice(&raw).unwrap();
        assert_eq!(borsh::to_vec(&sv).unwrap(), raw);
        let payload = sv.payload();
        assert_eq!(borsh::to_vec(&payload).unwrap(), bytes(&item["payload"]));
        let digest = verdict_digest(&payload);
        assert_eq!(digest, arr::<32>(&item["digest"]));
        // ed25519 is deterministic: the same key over the same digest gives the TS signature.
        assert_eq!(sk.sign(&digest).to_bytes(), sv.sig);
        assert!(pk
            .verify(&digest, &ed25519_dalek::Signature::from_bytes(&sv.sig))
            .is_ok());
    }
    let tag = SignedVerdict::try_from_slice(&bytes(&v["verdicts"][2]["signed"])).unwrap();
    assert_eq!(tag.body, Verdict::Tag { hunter: 2, target: 0 });
}

#[test]
fn merkle_roots_and_proofs_match() {
    let v = load("merkle");
    let leaves: Vec<[u8; 32]> = v["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| merkle::leaf(&LogEntry::try_from_slice(&bytes(&e["borsh"])).unwrap()))
        .collect();
    for (i, l) in leaves.iter().enumerate() {
        assert_eq!(l, &arr::<32>(&v["leaves"][i]));
    }
    for r in v["roots"].as_array().unwrap() {
        let n = r["size"].as_u64().unwrap() as usize;
        assert_eq!(
            merkle::root(&leaves[..n]),
            arr::<32>(&r["root"]),
            "root of size {n}"
        );
    }
    let root = merkle::root(&leaves);
    for p in v["proofs"].as_array().unwrap() {
        let i = p["index"].as_u64().unwrap() as usize;
        let proof: Vec<[u8; 32]> = p["proof"].as_array().unwrap().iter().map(arr::<32>).collect();
        assert_eq!(merkle::proof(&leaves, i), proof);
        assert!(merkle::verify(&leaves[i], i, leaves.len(), &proof, &root));
        assert!(!merkle::verify(
            &leaves[(i + 1) % leaves.len()],
            i,
            leaves.len(),
            &proof,
            &root
        ));
    }
}

#[test]
fn ring_matches() {
    let v = load("ring");
    let accounts: Vec<String> = v["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a.as_str().unwrap().to_owned())
        .collect();
    let sig: [u8; 64] = arr(&v["vrfSignature"]);
    assert_eq!(ring::players_hash(&accounts), arr::<32>(&v["playersHash"]));
    assert_eq!(ring::ring_commit(&sig), arr::<32>(&v["ringCommit"]));
    let expected: Vec<String> = v["ring"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a.as_str().unwrap().to_owned())
        .collect();
    assert_eq!(ring::build_ring(&accounts, &sig), expected);
}

#[test]
fn sealing_matches_and_rejects_tampering() {
    let v = load("seal");
    let sk: [u8; 32] = arr(&v["recipientSk"]);
    assert_eq!(public_key(&sk), arr::<32>(&v["recipientPk"]));
    let ctx = v["context"].as_str().unwrap().as_bytes();
    let plaintext = bytes(&v["plaintext"]);
    let sealed = seal_with(&arr(&v["ephSk"]), &public_key(&sk), &plaintext, ctx);
    assert_eq!(sealed, bytes(&v["sealed"]));
    assert_eq!(open(&sk, &sealed, ctx).unwrap(), plaintext);
    assert_eq!(open(&sk, &sealed, b"tail/hud"), Err(SealError::Decrypt));
    let mut bad = sealed.clone();
    bad[40] ^= 1;
    assert_eq!(open(&sk, &bad, ctx), Err(SealError::Decrypt));

    let keys = PlayerKeys::try_from_slice(&plaintext).unwrap();
    assert_eq!(keys.target, "alice.tail.testnet");
    let hud = Hud::try_from_slice(&bytes(&v["hud"]["borsh"])).unwrap();
    assert_eq!(hud.head, 1_020_000);
    assert_eq!(borsh::to_vec(&hud).unwrap(), bytes(&v["hud"]["borsh"]));
    let bare = Hud::try_from_slice(&bytes(&v["hudNoOptions"]["borsh"])).unwrap();
    assert!(bare.leak.is_none() && bare.hint_fact.is_none());
}
