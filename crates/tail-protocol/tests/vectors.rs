//! The golden vectors from packages/protocol (written by the TS side). Every value must be
//! reproduced byte for byte here, so TS and Rust cannot drift apart. (carry.json is TS only:
//! mesh carry runs between the phone and the relay.)

use borsh::BorshDeserialize;
use ed25519_dalek::{Signer, SigningKey, Verifier, VerifyingKey};
use serde_json::Value;
use tail_protocol::beacon::{
    beacon_tag, beacon_token, check_log_salts, derive_log_key, derive_player_key, derive_tag_key, log_salt,
    resolve_token, tag_matches,
};
use tail_protocol::digest::{
    batch_client_data_hash, batch_hash, enroll_client_data_hash, hud_sig_digest, keys_sig_digest,
    verdict_digest, voice_sig_digest,
};
use tail_protocol::presence::{verify_presence, Presence, PresenceError};
use tail_protocol::seal::{is_low_order, open, public_key, seal_with, SealError};
use tail_protocol::{
    hint_kind, hint_price, merkle, reject_code, ring, verify, Action, Batch, BatchEnvelope, Hash, Hud,
    LogEntry, PlayerKeys, PresenceProof, SignedHud, SignedPlayerKeys, SignedVerdict, SignedVoiceLine,
    Verdict,
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
fn num(v: &Value) -> u64 {
    v.as_u64().expect("number")
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
        let player = num(&t["player"]) as usize;
        let epoch = num(&t["epoch"]) as u32;
        let token = beacon_token(&k_tag, &kp[player], epoch);
        assert_eq!(token, arr::<16>(&t["token"]));
        assert_eq!(beacon_tag(&k_tag, epoch), arr::<4>(&t["tag"]));
        assert!(tag_matches(&k_tag, &token, epoch));
        assert_eq!(resolve_token(&kp, &k_tag, &token, epoch), Some(player as u16));
        assert_eq!(resolve_token(&kp, &k_tag, &token, epoch + 2), None);
    }
}

#[test]
fn log_salts_match_and_check() {
    let v = load("salt");
    let km: [u8; 32] = arr(&v["K_m"]);
    let k_log = derive_log_key(&km);
    assert_eq!(k_log, arr::<32>(&v["K_log"]));
    for s in v["salts"].as_array().unwrap() {
        assert_eq!(log_salt(&k_log, num(&s["index"])), arr::<16>(&s["salt"]));
    }
    let decode = |name: &str| -> Vec<LogEntry> {
        load(name)["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| LogEntry::try_from_slice(&bytes(&e["borsh"])).unwrap())
            .collect()
    };
    let merkle_log = decode("merkle");
    assert_eq!(check_log_salts(&km, &merkle_log), Ok(()));
    assert_eq!(check_log_salts(&km, &decode("log")), Ok(()));
    // A salt is bound to its index: the Contact at 1 moved to 2 no longer checks.
    let moved = [
        merkle_log[0].clone(),
        merkle_log[2].clone(),
        merkle_log[1].clone(),
    ];
    assert_eq!(check_log_salts(&km, &moved), Err(2));
    assert_eq!(check_log_salts(&[0; 32], &merkle_log), Err(1));
    assert_eq!(merkle_log[2].salt(), None, "a Verdict has no salt");
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
fn verdicts_chain_digest_sign_and_verify_like_ts() {
    let v = load("verdicts");
    let sk = SigningKey::from_bytes(&arr(&v["refereeSeed"]));
    let pk = VerifyingKey::from_bytes(&arr(&v["refereePk"])).unwrap();
    assert_eq!(sk.verifying_key(), pk);
    let mut prev: Hash = [0; 32];
    for item in v["verdicts"].as_array().unwrap() {
        let raw = bytes(&item["signed"]);
        let sv = SignedVerdict::try_from_slice(&raw).unwrap();
        assert_eq!(borsh::to_vec(&sv).unwrap(), raw);
        assert_eq!(sv.prev, prev, "seq {} chains to the previous digest", sv.seq);
        let payload = sv.payload();
        assert_eq!(borsh::to_vec(&payload).unwrap(), bytes(&item["payload"]));
        let digest = verdict_digest(&payload);
        assert_eq!(digest, arr::<32>(&item["digest"]));
        // ed25519 is deterministic: the same key over the same digest gives the TS signature.
        assert_eq!(sk.sign(&digest).to_bytes(), sv.sig);
        assert!(pk
            .verify(&digest, &ed25519_dalek::Signature::from_bytes(&sv.sig))
            .is_ok());
        assert!(verify::signed_verdict(&sv, &pk.to_bytes()));
        prev = digest;
    }
    let hint = SignedVerdict::try_from_slice(&bytes(&v["verdicts"][1]["signed"])).unwrap();
    assert_eq!(
        hint.body,
        Verdict::Hint {
            from: 1,
            amount: 20_000,
            hint_id: 3,
            hint: hint_kind::NEAR
        }
    );
    assert_eq!(hint_price(1_000_000, hint_kind::NEAR), Some(20_000));
    let mut tag = SignedVerdict::try_from_slice(&bytes(&v["verdicts"][2]["signed"])).unwrap();
    assert_eq!(
        tag.body,
        Verdict::Tag {
            hunter: 2,
            target: 0,
            credit: 20_000
        }
    );
    let end = SignedVerdict::try_from_slice(&bytes(&v["verdicts"][5]["signed"])).unwrap();
    assert!(matches!(end.body, Verdict::End { ref hint_targets, .. } if hint_targets == &[0]));
    tag.prev = [0; 32];
    assert!(!verify::signed_verdict(&tag, &pk.to_bytes()), "prev is signed");
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
        let n = num(&r["size"]) as usize;
        assert_eq!(
            merkle::root(&leaves[..n]),
            arr::<32>(&r["root"]),
            "root of size {n}"
        );
    }
    let root = merkle::root(&leaves);
    let size = leaves.len() as u64;
    for p in v["proofs"].as_array().unwrap() {
        let i = num(&p["index"]) as usize;
        let proof: Vec<[u8; 32]> = p["proof"].as_array().unwrap().iter().map(arr::<32>).collect();
        assert_eq!(merkle::proof(&leaves, i), proof);
        assert!(merkle::verify(&leaves[i], i as u64, size, &proof, &root));
        assert!(!merkle::verify(
            &leaves[(i + 1) % leaves.len()],
            i as u64,
            size,
            &proof,
            &root
        ));
    }
}

#[test]
fn v2_log_entries_round_trip_and_leaves_match() {
    let v = load("log");
    for e in v["entries"].as_array().unwrap() {
        let raw = bytes(&e["borsh"]);
        let entry = LogEntry::try_from_slice(&raw).unwrap();
        assert_eq!(borsh::to_vec(&entry).unwrap(), raw);
        assert_eq!(merkle::leaf(&entry), arr::<32>(&e["leaf"]));
    }
    let rejected = LogEntry::try_from_slice(&bytes(&v["entries"][3]["borsh"])).unwrap();
    assert!(matches!(
        rejected,
        LogEntry::Rejected {
            player: 1,
            seq: 9,
            code: reject_code::TELEPORT,
            ..
        }
    ));
    let evidence = LogEntry::try_from_slice(&bytes(&v["entries"][4]["borsh"])).unwrap();
    assert!(matches!(evidence, LogEntry::Evidence { ref epochs, .. } if epochs == &[33, 35, 36, 38, 40]));
    assert!(LogEntry::try_from_slice(&[8]).is_err(), "unknown tag");
}

#[test]
fn consistency_proofs_match() {
    let v = load("consistency");
    let leaves: Vec<Hash> = v["leaves"].as_array().unwrap().iter().map(arr::<32>).collect();
    for c in v["proofs"].as_array().unwrap() {
        let (m, n) = (num(&c["m"]), num(&c["n"]));
        let proof: Vec<Hash> = c["proof"].as_array().unwrap().iter().map(arr::<32>).collect();
        let peaks: Vec<Hash> = c["peaks"].as_array().unwrap().iter().map(arr::<32>).collect();
        let (old, new) = (arr::<32>(&c["oldRoot"]), arr::<32>(&c["newRoot"]));
        assert_eq!(merkle::root(&leaves[..m as usize]), old);
        assert_eq!(merkle::root(&leaves[..n as usize]), new);
        assert_eq!(merkle::peaks(&leaves[..m as usize]), peaks);
        assert_eq!(
            merkle::consistency_proof(&leaves[..n as usize], m as usize),
            proof
        );
        assert_eq!(
            merkle::consistency_proof_from_frontier(m, &peaks, &leaves[m as usize..n as usize]),
            Some(proof.clone())
        );
        assert!(merkle::verify_consistency(m, n, &old, &new, &proof), "{m} → {n}");
    }
}

#[test]
fn presence_proof_matches_and_verifies() {
    let v = load("presence");
    let raw = bytes(&v["proof"]["borsh"]);
    let proof = PresenceProof::try_from_slice(&raw).unwrap();
    assert_eq!(borsh::to_vec(&proof).unwrap(), raw);
    let players: Vec<String> = v["players"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p.as_str().unwrap().to_owned())
        .collect();
    let roots: Vec<(u64, Hash)> = v["roots"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| (num(&r["logSize"]), arr::<32>(&r["root"])))
        .collect();
    let e = &v["expect"];
    assert_eq!(
        verify_presence(&proof, &roots, &players),
        Ok(Presence {
            a: num(&e["a"]) as u16,
            b: num(&e["b"]) as u16,
            epoch: num(&e["epoch"]) as u32
        })
    );
    assert_eq!(
        verify_presence(&proof, &roots[..1], &players),
        Err(PresenceError::NoRoot)
    );
    let mut bad = proof.clone();
    bad.path[0] = [0; 32];
    assert_eq!(
        verify_presence(&bad, &roots, &players),
        Err(PresenceError::BadPath)
    );
    let mut swapped = proof.clone();
    swapped.accounts.swap(0, 1);
    assert_eq!(
        verify_presence(&swapped, &roots, &players),
        Err(PresenceError::WrongAccounts)
    );
    assert_eq!(
        verify_presence(&proof, &roots, &players[..1]),
        Err(PresenceError::UnknownPlayer)
    );
    let mut not_contact = proof;
    not_contact.entry = LogEntry::Verdict {
        seq: 1,
        digest: [0; 32],
    };
    assert_eq!(
        verify_presence(&not_contact, &roots, &players),
        Err(PresenceError::NotContact)
    );
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
    let sealed = seal_with(&arr(&v["ephSk"]), &public_key(&sk), &plaintext, ctx).unwrap();
    assert_eq!(sealed, bytes(&v["sealed"]));
    assert_eq!(open(&sk, &sealed, ctx).unwrap(), plaintext);
    assert_eq!(open(&sk, &sealed, b"tail/hud"), Err(SealError::Decrypt));
    let mut bad = sealed.clone();
    bad[40] ^= 1;
    assert_eq!(open(&sk, &bad, ctx), Err(SealError::Decrypt));
    let keys = PlayerKeys::try_from_slice(&plaintext).unwrap();
    assert_eq!(keys.target, "alice.tail.testnet");
}

#[test]
fn low_order_keys_are_refused_both_ways() {
    let v = load("seal");
    let sk: [u8; 32] = arr(&v["recipientSk"]);
    let sealed = bytes(&v["sealed"]);
    let ctx = v["context"].as_str().unwrap().as_bytes();
    let low: Vec<[u8; 32]> = v["lowOrder"].as_array().unwrap().iter().map(arr::<32>).collect();
    assert_eq!(low.len(), 14);
    for k in &low {
        assert!(is_low_order(k), "{}", hex::encode(k));
        assert_eq!(
            seal_with(&arr(&v["ephSk"]), k, b"x", b"c"),
            Err(SealError::LowOrderKey)
        );
        let mut forged = sealed.clone();
        forged[..32].copy_from_slice(k);
        assert_eq!(open(&sk, &forged, ctx), Err(SealError::LowOrderKey));
    }
    assert!(!is_low_order(&arr(&v["recipientPk"])));
    assert!(!is_low_order(&public_key(&arr(&v["ephSk"]))));
}

#[test]
fn hud_v2_round_trips() {
    let v = load("hud");
    for key in ["hud", "hudNoOptions", "hudOut"] {
        let raw = bytes(&v[key]["borsh"]);
        let hud = Hud::try_from_slice(&raw).unwrap();
        assert_eq!(borsh::to_vec(&hud).unwrap(), raw, "{key}");
    }
    let full = Hud::try_from_slice(&bytes(&v["hud"]["borsh"])).unwrap();
    assert_eq!(full.head, 1_020_000);
    assert_eq!(full.next_seq, 34);
    assert_eq!(full.rejected, Some((30, reject_code::CLOCK_SKEW)));
    assert_eq!(full.tagged_by, None);
    let bare = Hud::try_from_slice(&bytes(&v["hudNoOptions"]["borsh"])).unwrap();
    assert!(bare.leak.is_none() && bare.hint_fact.is_none() && bare.rejected.is_none());
    let out = Hud::try_from_slice(&bytes(&v["hudOut"]["borsh"])).unwrap();
    assert_eq!(out.status, tail_protocol::target_status::OUT);
    assert_eq!(out.tagged_by.as_deref(), Some("carol.tail.testnet"));
}

#[test]
fn signed_hud_keys_and_voice_match_and_open() {
    let v = load("hud");
    let sk = SigningKey::from_bytes(&arr(&v["refereeSeed"]));
    let pk: [u8; 32] = arr(&v["refereePk"]);
    let box_sk: [u8; 32] = arr(&v["recipientSk"]);
    for s in v["signed"].as_array().unwrap() {
        let name = s["name"].as_str().unwrap();
        let ctx = s["context"].as_str().unwrap().as_bytes();
        let signed = bytes(&s["signed"]);
        let digest: Hash = arr(&s["digest"]);
        assert_eq!(sk.sign(&digest).to_bytes(), arr::<64>(&s["sig"]), "{name}");
        assert!(verify::ed25519(&pk, &digest, &arr(&s["sig"])));
        assert_eq!(
            open(&box_sk, &bytes(&s["sealed"]), ctx).unwrap(),
            signed,
            "{name}"
        );
        match name {
            "hud" => {
                assert_eq!(ctx, tail_protocol::domain::HUD);
                let h = SignedHud::try_from_slice(&signed).unwrap();
                assert_eq!(hud_sig_digest(&h.hud), digest);
                assert!(verify::signed_hud(&h, &pk));
                let mut forged = h;
                forged.hud.head += 1;
                assert!(!verify::signed_hud(&forged, &pk));
            }
            "keys" => {
                assert_eq!(ctx, tail_protocol::domain::KEYS);
                let k = SignedPlayerKeys::try_from_slice(&signed).unwrap();
                assert_eq!(keys_sig_digest(&k.keys), digest);
                assert!(verify::signed_keys(&k, &pk));
            }
            "voice" => {
                assert_eq!(ctx, tail_protocol::domain::VOICE);
                let l = SignedVoiceLine::try_from_slice(&signed).unwrap();
                assert_eq!(voice_sig_digest(&l.line), digest);
                assert!(verify::signed_voice(&l, &pk));
                assert_eq!(l.line.text, "Your mark drifts east. Mind the café. ☕");
            }
            other => panic!("unexpected signed message {other}"),
        }
    }
}
