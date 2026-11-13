//! A scripted match (tests/driver) re-executes clean from its bundle, and each kind of
//! tampering is caught at the tick and entry where it first shows.

mod driver;

use driver::{bundle, entries, play, remove_entry, set_entry, sign, tick_of, Played, FULL, OLDER_RELAY};
use ed25519_dalek::{Signer as _, SigningKey};
use referee_sim::APP_ID;
use referee_verify::{verify, Bundle, BundleVerdict, Failure, Options, Stage, DEFAULT_APP_ID};
use std::sync::OnceLock;
use tail_protocol::digest::{batch_hash, verdict_digest};
use tail_protocol::{merkle, reject_code, Batch, LogEntry, SignedVerdict, Verdict, VerdictPayload};

fn played() -> &'static Played {
    static P: OnceLock<Played> = OnceLock::new();
    P.get_or_init(play)
}

fn failure(b: &Bundle) -> Failure {
    let o = verify(b, &Options::default());
    o.failure
        .unwrap_or_else(|| panic!("verified, but should not have:\n{}", o.lines.join("\n")))
}

fn index_of(log: &[LogEntry], f: impl Fn(&LogEntry) -> bool) -> usize {
    log.iter().position(f).expect("the match logs it")
}

fn decode_batch(s: &str) -> Batch {
    use base64::Engine as _;
    borsh::from_slice(&base64::engine::general_purpose::STANDARD.decode(s).unwrap()).unwrap()
}

#[test]
fn the_scripted_match_logs_what_the_tests_rely_on() {
    let p = played();
    let codes: Vec<u8> = p
        .log
        .iter()
        .filter_map(|e| match e {
            LogEntry::Rejected { code, .. } => Some(*code),
            _ => None,
        })
        .collect();
    for want in [reject_code::TELEPORT, reject_code::SEQ, reject_code::ASSERTION] {
        assert!(codes.contains(&want), "no Rejected with code {want}: {codes:?}");
    }
    let has = |f: fn(&Verdict) -> bool| p.verdicts.iter().any(|v| f(&v.body));
    assert!(has(|v| matches!(v, Verdict::Hint { .. })));
    assert!(has(|v| matches!(v, Verdict::Tag { .. })));
    assert!(has(|v| matches!(v, Verdict::Checkpoint { .. })));
    assert!(has(|v| matches!(v, Verdict::End { .. })));
    assert!(p.log.iter().any(|e| matches!(e, LogEntry::HintReceipt { .. })));
    assert!(p.log.iter().any(|e| matches!(e, LogEntry::Evidence { .. })));
}

#[test]
fn a_full_bundle_re_executes_byte_for_byte_with_app_attest() {
    let o = verify(&bundle(played(), FULL), &Options::default());
    assert!(o.passed(), "{:?}\n{}", o.failure, o.lines.join("\n"));
    assert!(o.trusted.is_empty(), "{:?}", o.trusted);
    assert!(
        o.notes.iter().any(|n| n.contains("re-checked with App Attest")),
        "{:?}",
        o.notes
    );
    let ticks = played()
        .log
        .iter()
        .filter(|e| matches!(e, LogEntry::Tick { .. }))
        .count();
    assert_eq!(o.lines.len(), ticks + 2, "start, one line per tick, end");
}

#[test]
fn an_older_relay_bundle_passes_and_says_what_it_took_from_the_log() {
    let o = verify(&bundle(played(), OLDER_RELAY), &Options::default());
    assert!(o.passed(), "{:?}\n{}", o.failure, o.lines.join("\n"));
    let trusted = o.trusted.join("\n");
    assert!(trusted.contains("no App Attest key"), "{trusted}");
    assert!(trusted.contains("without App Attest"), "{trusted}");
    // The resend, the duplicate and the broken-assertion copy hash to accepted batches, which
    // the relay keeps; only the teleport batch is gone.
    assert!(
        trusted.contains("1 refused batches were not released"),
        "{trusted}"
    );
    assert!(trusted.contains("TELEPORT"), "{trusted}");
}

#[test]
fn a_changed_batch_no_longer_matches_its_logged_hash() {
    let mut b = bundle(played(), FULL);
    let log = entries(&b);
    let i = b
        .batches
        .iter()
        .position(|s| !decode_batch(s).fixes.is_empty())
        .unwrap();
    let mut batch = decode_batch(&b.batches[i]);
    let at = index_of(
        &log,
        |e| matches!(e, LogEntry::Batch { hash, .. } if *hash == batch_hash(&batch)),
    );
    batch.fixes[0].lat_e7 += 1;
    b.batches[i] = driver::b64(&borsh::to_vec(&batch).unwrap());
    let f = failure(&b);
    assert_eq!(
        (f.stage, f.log_index),
        (Stage::Tick(tick_of(&log, at)), Some(at)),
        "{f:?}"
    );
}

#[test]
fn a_changed_batch_with_the_log_rewritten_to_match_fails_its_assertion_at_that_entry() {
    let mut b = bundle(played(), FULL);
    let log = entries(&b);
    let i = b
        .batches
        .iter()
        .position(|s| !decode_batch(s).fixes.is_empty())
        .unwrap();
    let mut batch = decode_batch(&b.batches[i]);
    let at = index_of(
        &log,
        |e| matches!(e, LogEntry::Batch { hash, .. } if *hash == batch_hash(&batch)),
    );
    batch.fixes[0].lat_e7 += 1;
    b.batches[i] = driver::b64(&borsh::to_vec(&batch).unwrap());
    let LogEntry::Batch { player, seq, .. } = log[at] else {
        unreachable!()
    };
    set_entry(
        &mut b,
        at,
        &LogEntry::Batch {
            player,
            seq,
            hash: batch_hash(&batch),
        },
    );
    let f = failure(&b);
    assert_eq!(
        (f.stage, f.log_index),
        (Stage::Tick(tick_of(&log, at)), Some(at)),
        "{f:?}"
    );
    assert!(f.what.contains("ASSERTION"), "{f:?}");
}

#[test]
fn a_verdict_changed_after_signing_fails_its_signature() {
    let mut b = bundle(played(), FULL);
    let (k, tag) = played()
        .verdicts
        .iter()
        .enumerate()
        .find(|(_, v)| matches!(v.body, Verdict::Tag { .. }))
        .unwrap();
    let mut v = tag.clone();
    let Verdict::Tag { hunter, target, .. } = &mut v.body else {
        unreachable!()
    };
    std::mem::swap(hunter, target);
    let mut signed: SignedVerdict = {
        use base64::Engine as _;
        borsh::from_slice(
            &base64::engine::general_purpose::STANDARD
                .decode(&b.verdicts[k].signed)
                .unwrap(),
        )
        .unwrap()
    };
    signed.body = v.body.clone();
    b.verdicts[k].signed = driver::b64(&borsh::to_vec(&signed).unwrap());
    let f = failure(&b);
    assert_eq!(
        (f.stage, f.verdict_seq),
        (Stage::Signatures, Some(v.seq)),
        "{f:?}"
    );
}

#[test]
fn a_signed_verdict_the_rules_do_not_give_fails_at_its_tick() {
    let game = played();
    let mut forged = bundle(game, FULL);
    let (k, tag) = game
        .verdicts
        .iter()
        .enumerate()
        .find(|(_, v)| matches!(v.body, Verdict::Tag { .. }))
        .unwrap();
    let mut v = tag.clone();
    let Verdict::Tag { hunter, target, .. } = &mut v.body else {
        unreachable!()
    };
    std::mem::swap(hunter, target);
    // The referee key signed it: only re-execution can tell.
    forged.verdicts[k].signed = sign(game, &v);
    let log = entries(&forged);
    let at = index_of(
        &log,
        |e| matches!(e, LogEntry::Verdict { seq, .. } if *seq == v.seq),
    );
    let f = failure(&forged);
    assert_eq!(
        (f.stage, f.verdict_seq),
        (Stage::Tick(tick_of(&log, at)), Some(v.seq)),
        "{f:?}"
    );
}

#[test]
fn a_changed_tick_time_fails_at_that_tick_and_without_its_leaf_at_the_leaves() {
    let mut b = bundle(played(), FULL);
    let log = entries(&b);
    let at = index_of(&log, |e| matches!(e, LogEntry::Tick { tick_no: 3, .. }));
    let LogEntry::Tick {
        tick_no,
        now_ms,
        call_id,
    } = log[at]
    else {
        unreachable!()
    };
    // A minute later: a Checkpoint falls due that the referee never signed.
    let moved = LogEntry::Tick {
        tick_no,
        now_ms: now_ms + 60_000,
        call_id,
    };

    let mut only_log = b.clone();
    only_log.log[at] = driver::b64(&borsh::to_vec(&moved).unwrap());
    let f = failure(&only_log);
    assert_eq!((f.stage, f.log_index), (Stage::Leaves, Some(at)), "{f:?}");

    set_entry(&mut b, at, &moved);
    let f = failure(&b);
    assert_eq!(f.stage, Stage::Tick(3), "{f:?}");
    assert!(
        f.log_index.is_some_and(|i| i > at) || f.verdict_seq.is_some(),
        "{f:?}"
    );
}

#[test]
fn a_dropped_validity_refusal_shows_at_the_players_next_batch() {
    let mut b = bundle(played(), FULL);
    let log = entries(&b);
    let at = index_of(&log, |e| {
        matches!(
            e,
            LogEntry::Rejected {
                code: reject_code::TELEPORT,
                ..
            }
        )
    });
    let LogEntry::Rejected { player, seq, .. } = log[at] else {
        unreachable!()
    };
    let next = index_of(
        &log,
        |e| matches!(e, LogEntry::Batch { player: p, seq: s, .. } if *p == player && *s == seq + 1),
    );
    remove_entry(&mut b, at);
    let f = failure(&b);
    // The player's chain never moved past `seq`, so its next batch is out of order.
    assert_eq!(f.stage, Stage::Tick(tick_of(&log, next)), "{f:?}");
    assert!(f.what.contains("SEQ"), "{f:?}");
}

#[test]
fn a_dropped_authenticity_refusal_shifts_every_later_salt_and_root() {
    let mut b = bundle(played(), FULL);
    let log = entries(&b);
    let at = index_of(&log, |e| {
        matches!(
            e,
            LogEntry::Rejected {
                code: reject_code::SEQ,
                ..
            }
        )
    });
    remove_entry(&mut b, at);
    let f = failure(&b);
    let Stage::Tick(t) = f.stage else { panic!("{f:?}") };
    assert!(t >= tick_of(&log, at), "{f:?}");
}

#[test]
fn a_vrf_key_the_signature_does_not_verify_under_fails_the_vrf_check() {
    // The engine never reads vrf_pk: only this check ties the draw to the key NEAR holds.
    let mut b = bundle(played(), FULL);
    b.referee.vrf_pk = hex::encode(SigningKey::from_bytes(&[0x33; 32]).verifying_key().to_bytes());
    let f = failure(&b);
    assert_eq!(f.stage, Stage::Vrf, "{f:?}");
    assert!(f.what.contains("does not verify"), "{f:?}");

    let mut b = bundle(played(), FULL);
    let mut sig = hex::decode(&b.reveal.vrf_signature).unwrap();
    sig[63] ^= 1;
    b.reveal.vrf_signature = hex::encode(sig);
    assert_eq!(failure(&b).stage, Stage::Vrf);
}

#[test]
fn a_vrf_alpha_naming_another_match_fails_even_when_signed() {
    let game = played();
    let mut b = bundle(game, FULL);
    let alpha = format!("vrf:1:tail.testnet:{}", hex::encode([0x7b; 16]));
    b.reveal.vrf_alpha.clone_from(&alpha);
    b.reveal.vrf_signature = hex::encode(game.vrf.sign(alpha.as_bytes()).to_bytes());
    let f = failure(&b);
    assert_eq!(f.stage, Stage::Vrf, "{f:?}");
    assert!(f.what.contains("does not name this match"), "{f:?}");
}

#[test]
fn a_log_entry_after_end_fails() {
    let mut b = bundle(played(), FULL);
    let log = entries(&b);
    let n = log.len();
    let extra = log
        .iter()
        .find(|e| matches!(e, LogEntry::Contact { .. }))
        .unwrap()
        .clone();
    b.log.push(driver::b64(&borsh::to_vec(&extra).unwrap()));
    b.leaves.push(hex::encode(merkle::leaf(&extra)));
    let f = failure(&b);
    assert_eq!((f.stage, f.log_index), (Stage::End, Some(n)), "{f:?}");
    assert!(f.what.contains("after End"), "{f:?}");
}

#[test]
fn a_signed_verdict_after_end_fails() {
    let game = played();
    let mut b = bundle(game, FULL);
    let end = game.verdicts.last().unwrap();
    assert!(matches!(end.body, Verdict::End { .. }));
    let after = VerdictPayload {
        seq: end.seq + 1,
        prev: verdict_digest(end),
        ..end.clone()
    };
    b.verdicts.push(BundleVerdict {
        signed: sign(game, &after),
    });
    let f = failure(&b);
    assert_eq!((f.stage, f.verdict_seq), (Stage::End, Some(after.seq)), "{f:?}");
    assert!(f.what.contains("verdicts after End"), "{f:?}");
}

#[test]
fn pinned_keys_must_be_the_bundles_and_every_input_says_where_it_came_from() {
    let game = played();
    let b = bundle(game, FULL);
    let referee = game.referee.verifying_key().to_bytes();
    let vrf = game.vrf.verifying_key().to_bytes();
    let pinned = Options {
        app_id: APP_ID.into(),
        referee_pk: Some(referee),
        vrf_pk: Some(vrf),
    };
    let o = verify(&b, &pinned);
    assert!(o.passed(), "{:?}", o.failure);
    assert!(o.warnings.is_empty(), "{:?}", o.warnings);
    let inputs = o.inputs.join("\n");
    for want in [
        "referee_pk",
        "pinned by --referee-pk",
        "pinned by --vrf-pk",
        "app id SIMTEAM.dev.tail.sim from the bundle",
        "App Attest keys of 3 of 3 players",
        "stake 1000000",
        "zone",
    ] {
        assert!(inputs.contains(want), "{want}: {inputs}");
    }

    let other = [0x44; 32];
    for opts in [
        Options {
            referee_pk: Some(other),
            ..pinned.clone()
        },
        Options {
            vrf_pk: Some(other),
            ..pinned.clone()
        },
    ] {
        let f = verify(&b, &opts)
            .failure
            .expect("a key that is not the pinned one");
        assert_eq!(f.stage, Stage::Pins, "{f:?}");
    }

    // Unpinned, the keys are the bundle's own, and an App ID other than the expected one is said.
    let o = verify(&b, &Options::default());
    assert!(o.passed(), "{:?}", o.failure);
    assert!(
        o.inputs.iter().any(|i| i.contains("not pinned")),
        "{:?}",
        o.inputs
    );
    assert!(
        o.warnings.iter().any(|w| w.contains(DEFAULT_APP_ID)),
        "{:?}",
        o.warnings
    );
}

#[test]
fn the_binary_exits_0_clean_1_forged_or_unpinned_2_bad_args_and_3_when_it_had_to_trust() {
    let dir = std::env::temp_dir().join(format!("tail-verify-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("bundle.json");
    let run = |b: &Bundle, args: &[&str]| {
        std::fs::write(&path, serde_json::to_string(b).unwrap()).unwrap();
        let out = std::process::Command::new(env!("CARGO_BIN_EXE_tail-verify"))
            .arg(&path)
            .args(args)
            .output()
            .unwrap();
        (
            out.status.code(),
            String::from_utf8_lossy(&out.stdout).into_owned(),
        )
    };
    let game = played();
    let referee = hex::encode(game.referee.verifying_key().to_bytes());
    let vrf = hex::encode(game.vrf.verifying_key().to_bytes());
    let pins = ["--referee-pk", &referee, "--vrf-pk", &vrf, "--app-id", APP_ID];

    let (code, out) = run(&bundle(game, FULL), &pins);
    assert_eq!(code, Some(0), "{out}");
    assert!(out.contains("tick    1") && out.contains("PASS"), "{out}");
    assert!(out.contains("under the pinned referee and VRF keys"), "{out}");
    assert!(!out.contains("warning") && !out.contains("trusted"), "{out}");

    // Unpinned it still passes, and says the keys and the App ID were the bundle's.
    let (code, out) = run(&bundle(game, FULL), &[]);
    assert_eq!(code, Some(0), "{out}");
    assert!(out.contains("not pinned") && out.contains("warning"), "{out}");

    let mut forged = bundle(game, FULL);
    forged.verdicts.swap(1, 2);
    assert_eq!(run(&forged, &pins).0, Some(1));

    let other = hex::encode([0x44; 32]);
    let (code, out) = run(&bundle(game, FULL), &["--referee-pk", &other]);
    assert_eq!(code, Some(1), "{out}");
    assert!(out.contains("FAIL      pins"), "{out}");
    assert_eq!(run(&bundle(game, FULL), &["--vrf-pk", "abcd"]).0, Some(2));

    // An older relay's bundle needs the log's word: exit 3, unless that is accepted.
    for args in [&[][..], &["--strict"][..]] {
        let (code, out) = run(&bundle(game, OLDER_RELAY), args);
        assert_eq!(code, Some(3), "{out}");
        assert!(
            out.contains("trusted   ") && out.contains("--allow-trusted"),
            "{out}"
        );
    }
    let (code, out) = run(&bundle(game, OLDER_RELAY), &["--allow-trusted"]);
    assert_eq!(code, Some(0), "{out}");
    assert!(out.contains("TELEPORT"), "{out}");
    std::fs::remove_dir_all(&dir).unwrap();
}
