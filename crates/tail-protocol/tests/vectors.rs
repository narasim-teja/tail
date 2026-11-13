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
    rebind_digest, verdict_digest, voice_sig_digest,
};
use tail_protocol::presence::{verify_presence, Presence, PresenceError};
use tail_protocol::seal::{
    is_low_order, open, open_on_phone, pad, public_key, seal_to_phone_with, seal_with, unpad, SealError,
    ToPhone,
};
use tail_protocol::{
    hint_bps, hint_kind, hint_price, merkle, price_reason, recent_hints, reject_code, ring, verify, Action,
    Batch, BatchEnvelope, Hash, Hud, LogEntry, PlayerKeys, PresenceProof, SignedHud, SignedPlayerKeys,
    SignedVerdict, SignedVoiceLine, Verdict, VoiceLine, PHONE_PAD, PRICE_CAP_BPS, PRICE_STEP_BPS,
    PRICE_WINDOW_MS, VOICE_TEXT_MAX,
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

    let r = &v["rebind"];
    let digest = rebind_digest(
        r["accountId"].as_str().unwrap(),
        &arr(&r["appAttestPk"]),
        &arr(&r["playerBoxPk"]),
        &arr(&r["nearPk"]),
    );
    assert_eq!(digest, arr::<32>(&r["digest"]));
    let old = SigningKey::from_bytes(&arr(&r["oldNearSeed"]));
    assert_eq!(old.verifying_key().to_bytes(), arr::<32>(&r["oldNearPk"]));
    assert_eq!(old.sign(&digest).to_bytes(), arr::<64>(&r["sig"]));
    assert!(verify::ed25519(&arr(&r["oldNearPk"]), &digest, &arr(&r["sig"])));
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
            hint: hint_kind::NEAR,
            t_ms: 1_794_514_120_000,
        }
    );
    assert_eq!(hint_price(1_000_000, hint_kind::NEAR, 0), Some(20_000));
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
    let priced: Vec<_> = [hint_kind::NEAR, hint_kind::BEARING, hint_kind::TREND]
        .iter()
        .map(|&k| hint_price(1_000_000, k, full.hint_recent).unwrap())
        .collect();
    assert_eq!(full.hint_prices.to_vec(), priced);
    assert_eq!(full.hint_recent, 3);
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
        let sealed = bytes(&s["sealed"]);
        assert_eq!(sealed.len(), 32 + PHONE_PAD + 16, "{name}");
        assert_eq!(pad(&signed).unwrap(), bytes(&s["padded"]), "{name}");
        assert_eq!(
            open(&box_sk, &sealed, ctx).unwrap(),
            bytes(&s["padded"]),
            "{name}"
        );
        let eph: [u8; 32] = arr(&s["ephSk"]);
        let recipient = public_key(&box_sk);
        match name {
            "hud" => {
                assert_eq!(ctx, SignedHud::CONTEXT);
                let h: SignedHud = open_on_phone(&box_sk, &sealed).unwrap();
                assert_eq!(borsh::to_vec(&h).unwrap(), signed);
                assert_eq!(seal_to_phone_with(&eph, &recipient, &h).unwrap(), sealed);
                assert_eq!(hud_sig_digest(&h.hud), digest);
                assert!(verify::signed_hud(&h, &pk));
                let mut forged = h;
                forged.hud.head += 1;
                assert!(!verify::signed_hud(&forged, &pk));
            }
            "keys" => {
                assert_eq!(ctx, SignedPlayerKeys::CONTEXT);
                let k: SignedPlayerKeys = open_on_phone(&box_sk, &sealed).unwrap();
                assert_eq!(borsh::to_vec(&k).unwrap(), signed);
                assert_eq!(seal_to_phone_with(&eph, &recipient, &k).unwrap(), sealed);
                // Under another type's context it does not open.
                assert_eq!(
                    open_on_phone::<SignedHud>(&box_sk, &sealed),
                    Err(SealError::Decrypt)
                );
                assert_eq!(keys_sig_digest(&k.keys), digest);
                assert!(verify::signed_keys(&k, &pk));
            }
            "voice" => {
                assert_eq!(ctx, SignedVoiceLine::CONTEXT);
                let l: SignedVoiceLine = open_on_phone(&box_sk, &sealed).unwrap();
                assert_eq!(borsh::to_vec(&l).unwrap(), signed);
                assert_eq!(seal_to_phone_with(&eph, &recipient, &l).unwrap(), sealed);
                assert_eq!(voice_sig_digest(&l.line), digest);
                assert!(verify::signed_voice(&l, &pk));
                assert_eq!(l.line.text, "Your mark drifts east. Mind the café. ☕");
            }
            other => panic!("unexpected signed message {other}"),
        }
    }
}

#[test]
fn phone_messages_seal_to_one_length_whatever_they_hold() {
    let v = load("hud");
    assert_eq!(num(&v["phonePad"]) as usize, PHONE_PAD);
    assert_eq!(num(&v["voiceTextMax"]) as usize, VOICE_TEXT_MAX);
    let box_sk: [u8; 32] = arr(&v["recipientSk"]);
    let pk = public_key(&box_sk);
    let eph = [7; 32];
    let want = 32 + PHONE_PAD + 16;
    let longest = format!("{}.testnet", "a".repeat(56));
    assert_eq!(longest.len(), 64, "NEAR's longest account id");

    let keys = PlayerKeys::try_from_slice(&bytes(&v["signed"][1]["borsh"])).unwrap();
    for target in ["bo.testnet", "alice.tail.testnet", longest.as_str()] {
        let k = SignedPlayerKeys {
            keys: PlayerKeys {
                target: target.into(),
                ..keys.clone()
            },
            sig: [1; 64],
        };
        assert_eq!(seal_to_phone_with(&eph, &pk, &k).unwrap().len(), want, "{target}");
    }

    let hud = Hud::try_from_slice(&bytes(&v["hud"]["borsh"])).unwrap();
    let bare = Hud::try_from_slice(&bytes(&v["hudNoOptions"]["borsh"])).unwrap();
    let largest = Hud {
        target: longest.clone(),
        tagged_by: Some(longest.clone()),
        hint_prices: [u128::MAX; 3],
        ..hud.clone()
    };
    for h in [bare, hud, largest.clone()] {
        let s = SignedHud { hud: h, sig: [1; 64] };
        assert_eq!(seal_to_phone_with(&eph, &pk, &s).unwrap().len(), want);
    }
    let largest = borsh::to_vec(&SignedHud {
        hud: largest,
        sig: [1; 64],
    })
    .unwrap();
    assert_eq!(largest.len(), 401, "the largest HUD, as PHONE_PAD's comment says");

    let line = |text: String| SignedVoiceLine {
        line: VoiceLine {
            match_id: [1; 16],
            player: 2,
            hint_id: 3,
            text,
        },
        sig: [1; 64],
    };
    for text in [
        "Warmer. You're closing in.".to_owned(),
        "x".repeat(VOICE_TEXT_MAX),
    ] {
        let sealed = seal_to_phone_with(&eph, &pk, &line(text.clone())).unwrap();
        assert_eq!(sealed.len(), want);
        assert_eq!(
            open_on_phone::<SignedVoiceLine>(&box_sk, &sealed)
                .unwrap()
                .line
                .text,
            text
        );
    }
    assert_eq!(
        seal_to_phone_with(&eph, &pk, &line("x".repeat(VOICE_TEXT_MAX + 1))),
        Err(SealError::TooLong)
    );
}

#[test]
fn phone_padding_is_strict() {
    assert_eq!(unpad(&pad(b"abc").unwrap()).unwrap(), b"abc");
    assert_eq!(pad(&[0; PHONE_PAD - 4]).unwrap().len(), PHONE_PAD);
    assert_eq!(pad(&[0; PHONE_PAD - 3]), Err(SealError::TooLong));
    let mut dirty = pad(b"abc").unwrap();
    dirty[PHONE_PAD - 1] = 1;
    assert_eq!(unpad(&dirty), Err(SealError::Padding));
    let mut long = pad(b"abc").unwrap();
    long[..4].copy_from_slice(&(PHONE_PAD as u32 - 3).to_le_bytes());
    assert_eq!(unpad(&long), Err(SealError::Padding));
    assert_eq!(
        unpad(&pad(b"abc").unwrap()[..PHONE_PAD - 1]),
        Err(SealError::Padding)
    );
    // A message sealed without padding, as before, does not open as one to a phone.
    let sk = [5; 32];
    let unpadded = seal_with(&[6; 32], &public_key(&sk), b"abc", SignedHud::CONTEXT).unwrap();
    assert_eq!(
        open_on_phone::<SignedHud>(&sk, &unpadded),
        Err(SealError::Padding)
    );
    // Padding that holds no SignedHud.
    let junk = seal_with(
        &[6; 32],
        &public_key(&sk),
        &pad(b"abc").unwrap(),
        SignedHud::CONTEXT,
    )
    .unwrap();
    assert_eq!(open_on_phone::<SignedHud>(&sk, &junk), Err(SealError::Decode));
}

fn big(v: &Value) -> u128 {
    v.as_str().expect("decimal string").parse().expect("u128")
}

#[test]
fn hint_prices_match() {
    let v = load("pricing");
    assert_eq!(num(&v["windowMs"]), PRICE_WINDOW_MS);
    assert_eq!(u128::from(num(&v["stepBps"])), PRICE_STEP_BPS);
    assert_eq!(u128::from(num(&v["capBps"])), PRICE_CAP_BPS);
    for (k, bps) in v["hintBps"].as_array().unwrap().iter().enumerate() {
        assert_eq!(hint_bps(k as u8), Some(u128::from(num(bps))));
    }
    let cases = v["prices"].as_array().unwrap();
    assert!(cases.len() > 300);
    for c in cases {
        let (stake, kind, recent) = (big(&c["stake"]), num(&c["kind"]) as u8, num(&c["recent"]) as u32);
        let want = (!c["price"].is_null()).then(|| big(&c["price"]));
        assert_eq!(hint_price(stake, kind, recent), want, "{c}");
    }
    for c in v["recent"].as_array().unwrap() {
        let times: Vec<u64> = c["times"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| big(t) as u64)
            .collect();
        assert_eq!(
            recent_hints(&times, big(&c["now"]) as u64),
            num(&c["recent"]) as u32,
            "{c}"
        );
    }
    for c in v["reasons"].as_array().unwrap() {
        let reason = price_reason(num(&c["kind"]) as u8, num(&c["recent"]) as u32);
        assert_eq!(reason.as_deref(), c["reason"].as_str(), "{c}");
    }
}
