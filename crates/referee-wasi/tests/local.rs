//! The local test referee end to end: the built binary, one process per command, in a fresh
//! key directory. Offline; only the keys and ids are random, and every check holds for any.
#![cfg(not(target_family = "wasm"))]

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use p256::ecdsa::SigningKey as DeviceKey;
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};
use tail_protocol::digest::{sha256, verdict_digest};
use tail_protocol::ring::{build_ring, players_hash, ring_commit};
use tail_protocol::{SignedVerdict, Verdict};

const BIN: &str = env!("CARGO_BIN_EXE_tail-referee");
const OWNER: &str = "relay.test.near";

/// A key directory that is removed when the test ends, pass or fail.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!(
            "tail-local-referee-{name}-{}-{nanos}",
            std::process::id()
        ));
        Self(path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn spawn(dir: Option<&Path>, input: &Value) -> std::process::Child {
    let mut cmd = Command::new(BIN);
    cmd.env_remove("TAIL_LOCAL_REFEREE_DIR")
        .env("TAIL_LOCAL_REFEREE_OWNER", OWNER)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    if let Some(dir) = dir {
        cmd.env("TAIL_LOCAL_REFEREE_DIR", dir);
    }
    let mut child = cmd.spawn().expect("the referee binary runs");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(input).unwrap())
        .unwrap();
    child
}

fn answer(child: std::process::Child) -> Value {
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "referee exited with {}", out.status);
    serde_json::from_slice(&out.stdout).expect("stdout is one JSON answer")
}

fn call(dir: &Path, input: &Value) -> Value {
    let a = answer(spawn(Some(dir), input));
    assert_eq!(a["ok"], true, "{input}: {a}");
    a["result"].clone()
}

fn refused(dir: Option<&Path>, input: &Value) -> String {
    let a = answer(spawn(dir, input));
    assert_eq!(a["ok"], false, "{input} should be refused: {a}");
    a["error"].as_str().unwrap().to_owned()
}

fn b64(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

fn unb64(v: &Value) -> Vec<u8> {
    STANDARD.decode(v.as_str().expect("a base64 string")).unwrap()
}

fn fixed<const N: usize>(v: &Value) -> [u8; N] {
    unb64(v).try_into().unwrap()
}

fn verdict(v: &Value) -> SignedVerdict {
    borsh::from_slice(&unb64(v)).unwrap()
}

fn verifies(pk: &VerifyingKey, msg: &[u8], sig: &[u8; 64]) -> bool {
    pk.verify_strict(msg, &Signature::from_bytes(sig)).is_ok()
}

fn device_key(name: &str) -> DeviceKey {
    (0u32..)
        .find_map(|i| {
            DeviceKey::from_slice(&sha256(&[b"tail/test/device", name.as_bytes(), &i.to_le_bytes()])).ok()
        })
        .unwrap()
}

fn wall_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64
}

/// `pubkeys` in a fresh directory: the answer, the verdict key and the VRF key.
fn pubkeys(dir: &Path) -> (Value, VerifyingKey, VerifyingKey) {
    let keys = call(dir, &json!({ "cmd": "pubkeys" }));
    let referee_pk = VerifyingKey::from_bytes(&fixed(&keys["referee_pk"])).unwrap();
    assert_eq!(keys["referee_pk_hex"], hex::encode(referee_pk.to_bytes()));
    let box_pk: [u8; 32] = fixed(&keys["referee_box_pk"]);
    let box_digest = sha256(&[b"tail/referee-box/v1", &box_pk]);
    assert!(
        verifies(&referee_pk, &box_digest, &fixed(&keys["box_pk_sig"])),
        "box_pk_sig"
    );
    let mut vrf_pk = [0u8; 32];
    hex::decode_to_slice(keys["vrf_pk"].as_str().unwrap(), &mut vrf_pk).unwrap();
    let vrf_pk = VerifyingKey::from_bytes(&vrf_pk).unwrap();
    assert_ne!(vrf_pk, referee_pk, "the VRF key is its own key");
    (keys, referee_pk, vrf_pk)
}

fn enroll_all(dir: &Path, referee_pk: &VerifyingKey, accounts: &[&str]) {
    for (n, account) in accounts.iter().enumerate() {
        let key = device_key(account);
        let pk = appattest::public_key_bytes(key.verifying_key());
        let r = call(
            dir,
            &json!({
                "cmd": "enroll",
                "account_id": account,
                "app_attest_pk": b64(&pk),
                "player_box_pk": b64(&[n as u8 + 1; 32]),
                "near_pk": b64(&[n as u8 + 10; 32]),
            }),
        );
        let receipt = unb64(&r["receipt"]);
        let digest = sha256(&[b"tail/enroll-receipt/v1", &receipt]);
        assert!(
            verifies(referee_pk, &digest, &fixed(&r["sig"])),
            "{account}: receipt"
        );
        let call_id = r["call_id"].as_str().unwrap();
        let groups: Vec<usize> = call_id.split('-').map(str::len).collect();
        assert_eq!(groups, [8, 4, 4, 4, 12], "call id {call_id} is a UUID");
        assert_eq!(&call_id[14..15], "4", "call id {call_id} is a v4 UUID");
    }
}

/// Two `end`s racing on one blob: the compare-and-swap on the match record lets one through.
fn end_once(dir: &Path, input: &Value) -> Value {
    let racers: Vec<_> = (0..2).map(|_| spawn(Some(dir), input)).collect();
    let mut answers: Vec<Value> = racers.into_iter().map(answer).collect();
    answers.sort_by_key(|a| a["ok"] != true);
    assert_eq!(answers[0]["ok"], true, "{}", answers[0]);
    assert_eq!(answers[1]["ok"], false, "only one End: {}", answers[1]);
    answers[0]["result"].clone()
}

/// Every secret and record is a 0600 file in a 0700 directory, and no staging file is left.
fn check_modes(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    for d in [dir.to_path_buf(), dir.join("storage"), dir.join("tmp")] {
        assert_eq!(mode(&d), 0o700, "{}", d.display());
    }
    let records = std::fs::read_dir(dir.join("storage"))
        .unwrap()
        .map(|e| e.unwrap().path());
    let keys = ["verdict.key", "vrf.key", "state.key"].map(|f| dir.join(f));
    for f in keys.into_iter().chain(records) {
        assert_eq!(mode(&f), 0o600, "{}", f.display());
    }
    assert_eq!(
        std::fs::read_dir(dir.join("tmp")).unwrap().count(),
        0,
        "no staging file is left"
    );
}

/// The Start verdict verifies under `referee_pk` over the protocol's verdict digest and says
/// what was asked; returns its ring commit.
fn check_start(
    started: &Value,
    referee_pk: &VerifyingKey,
    match_id: [u8; 16],
    accounts: &[&str],
    window: (u64, u64),
) -> [u8; 32] {
    assert_eq!(started["seq"], 1);
    let start = verdict(&started["verdicts"][0]);
    assert!(
        verifies(referee_pk, &verdict_digest(&start.payload()), &start.sig),
        "Start is signed by referee_pk over the verdict digest"
    );
    assert_eq!(start.match_id, match_id);
    assert_eq!(start.call_id, uuid(&started["call_id"]));
    let Verdict::Start {
        players_hash: ph,
        ring_commit: rc,
        start_ms: s,
        end_ms: e,
    } = start.body
    else {
        panic!("first verdict is not Start")
    };
    assert_eq!((s, e), window);
    assert_eq!(ph, players_hash(accounts));
    assert_eq!(started["keys"].as_array().unwrap().len(), 3);
    rc
}

/// No network here, so the template line, saying why.
fn check_voice(dir: &Path) {
    let v = call(
        dir,
        &json!({ "cmd": "voice", "hint_id": 0, "hint": 0, "value": 0 }),
    );
    assert_eq!(v["source"], "template");
    assert!(
        v["fallback_reason"]
            .as_str()
            .unwrap()
            .contains("local test referee"),
        "{}",
        v["fallback_reason"]
    );
}

#[test]
fn plays_a_match_with_keys_on_disk() {
    let tmp = TempDir::new("match");
    let dir = tmp.0.as_path();
    let (keys, referee_pk, vrf_pk) = pubkeys(dir);
    let accounts = ["carol.test.near", "alice.test.near", "bob.test.near"];
    enroll_all(dir, &referee_pk, &accounts);

    // ── start: two minutes ago, one minute long, so a tick at end_ms ends it ──
    let match_id = [7u8; 16];
    let start_ms = wall_ms() - 120_000;
    let end_ms = start_ms + 60_000;
    let started = call(
        dir,
        &json!({
            "cmd": "start",
            "match_id": b64(&match_id),
            "players": accounts,
            "start_ms": start_ms,
            "duration_ms": 60_000,
            "stake": "1000000",
            "zone": { "lat_e7": 423_601_000, "lon_e7": -710_589_000, "radius_m": 500 },
        }),
    );
    let rc = check_start(&started, &referee_pk, match_id, &accounts, (start_ms, end_ms));
    let twice = refused(
        Some(dir),
        &json!({ "cmd": "start", "match_id": b64(&match_id), "players": accounts, "duration_ms": 60_000,
                 "stake": "1", "zone": { "lat_e7": 0, "lon_e7": 0, "radius_m": 500 } }),
    );
    assert!(twice.contains("already started"), "{twice}");

    // ── tick with no batches, then at end_ms ──
    let t1 = call(
        dir,
        &json!({ "cmd": "tick", "match_id": b64(&match_id), "state": started["state"], "last_seq": 1,
                 "now_ms": start_ms + 10_000, "batches": [] }),
    );
    assert_eq!(t1["tick_no"], 1);
    assert_eq!(t1["over"], false);
    assert_eq!(t1["opened"], 0);
    assert_eq!(t1["huds"].as_array().unwrap().len(), 3);
    let stale = refused(
        Some(dir),
        &json!({ "cmd": "tick", "match_id": b64(&[8u8; 16]), "state": t1["state"], "last_seq": t1["seq"] }),
    );
    assert!(stale.contains("does not open"), "{stale}");
    let t2 = call(
        dir,
        &json!({ "cmd": "tick", "match_id": b64(&match_id), "state": t1["state"], "last_seq": t1["seq"],
                 "now_ms": end_ms }),
    );
    assert_eq!(t2["over"], true);

    check_voice(dir);

    // ── end: the VRF reveal verifies under vrf_pk and opens the ring commit ──
    let ended = end_once(
        dir,
        &json!({ "cmd": "end", "match_id": b64(&match_id), "state": t2["state"], "last_seq": t2["seq"] }),
    );
    let end = verdict(&ended["verdicts"][0]);
    assert!(
        verifies(&referee_pk, &verdict_digest(&end.payload()), &end.sig),
        "End signature"
    );
    let Verdict::End {
        alpha, vrf_signature, ..
    } = end.body
    else {
        panic!("end verdict is not End")
    };
    assert!(
        verifies(&vrf_pk, alpha.as_bytes(), &vrf_signature),
        "VRF signature over alpha"
    );
    let start_call = started["call_id"].as_str().unwrap();
    assert_eq!(
        alpha,
        format!("vrf:{start_call}:{OWNER}:{}", hex::encode(match_id))
    );
    // What the contract checks: the seed after the last ':' is the match id, and the length.
    assert_eq!(
        alpha.rsplit_once(':').map(|(_, s)| s),
        Some(hex::encode(match_id).as_str())
    );
    assert!(alpha.len() <= 192);
    assert_eq!(rc, ring_commit(&vrf_signature));

    let d = call(dir, &json!({ "cmd": "declassify", "match_id": b64(&match_id) }));
    assert_eq!(d["vrf_alpha"], alpha);
    let ring: Vec<String> = serde_json::from_value(d["ring"].clone()).unwrap();
    assert_eq!(ring, build_ring(&accounts, &vrf_signature));
    let again = refused(
        Some(dir),
        &json!({ "cmd": "end", "match_id": b64(&match_id), "state": ended["state"], "last_seq": end.seq }),
    );
    assert!(again.contains("already ended"), "{again}");

    check_modes(dir);

    // ── a second process with the same directory has the same keys ──
    // ed25519 signatures are deterministic, so even `box_pk_sig` is byte for byte the same.
    assert_eq!(call(dir, &json!({ "cmd": "pubkeys" })), keys);
}

fn uuid(v: &Value) -> [u8; 16] {
    let mut out = [0u8; 16];
    hex::decode_to_slice(v.as_str().unwrap().replace('-', ""), &mut out).unwrap();
    out
}

#[test]
fn concurrent_first_calls_agree_on_one_set_of_keys() {
    let tmp = TempDir::new("race");
    let children: Vec<_> = (0..8)
        .map(|_| spawn(Some(&tmp.0), &json!({ "cmd": "pubkeys" })))
        .collect();
    let answers: Vec<Value> = children.into_iter().map(answer).collect();
    for a in &answers {
        assert_eq!(a["ok"], true, "{a}");
        assert_eq!(a["result"], answers[0]["result"]);
    }
}

#[test]
fn refuses_to_run_without_a_key_directory() {
    let err = refused(None, &json!({ "cmd": "pubkeys" }));
    assert!(err.contains("TAIL_LOCAL_REFEREE_DIR"), "{err}");
}
