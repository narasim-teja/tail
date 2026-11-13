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
use tail_protocol::beacon::check_log_salts;
use tail_protocol::digest::{
    batch_client_data_hash, batch_hash, hud_sig_digest, keys_sig_digest, sha256, verdict_digest,
    voice_sig_digest,
};
use tail_protocol::ring::{build_ring, players_hash, ring_commit};
use tail_protocol::{
    domain, merkle, reject_code, seal, Action, Batch, BatchEnvelope, Fix, Hash, Hud, LogEntry, PlayerKeys,
    SignedHud, SignedPlayerKeys, SignedVerdict, SignedVoiceLine, Verdict, VoiceLine,
};

const BIN: &str = env!("CARGO_BIN_EXE_tail-referee");
const OWNER: &str = "relay.test.near";
const APP_ID: &str = "LKABS9RZAC.com.lkabs9rzac.tail";
const ZONE: (i32, i32) = (423_601_000, -710_589_000);
/// Every message the referee seals to a phone: ephemeral key, padded plaintext, tag.
const SEALED_TO_PHONE: usize = 32 + tail_protocol::PHONE_PAD + 16;

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
        // The test enrols software P-256 keys, which only a referee taking ghosts accepts.
        .env("ALLOW_UNATTESTED", "1")
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

fn box_sk(name: &str) -> [u8; 32] {
    sha256(&[b"tail/test/box", name.as_bytes()])
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
                "player_box_pk": b64(&seal::public_key(&box_sk(account))),
                "near_pk": b64(&[n as u8 + 10; 32]),
            }),
        );
        assert_eq!(
            r["attested"], false,
            "{account}: a software key is never attested"
        );
        assert_eq!(
            unb64(&r["referee_pk"]),
            referee_pk.to_bytes(),
            "{account}: the receipt names its referee"
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

/// Two `end`s racing on one blob: the compare-and-swap on the match record records one End. The
/// other is refused if it lost the race, or, if it read the record after, answered with that
/// same End; never with another.
fn end_once(dir: &Path, input: &Value) -> Value {
    let racers: Vec<_> = (0..2).map(|_| spawn(Some(dir), input)).collect();
    let mut answers: Vec<Value> = racers.into_iter().map(answer).collect();
    answers.sort_by_key(|a| a["ok"] != true);
    assert_eq!(answers[0]["ok"], true, "{}", answers[0]);
    if answers[1]["ok"] == true {
        assert_eq!(
            answers[1]["result"]["verdicts"], answers[0]["result"]["verdicts"],
            "one End"
        );
    } else {
        assert!(
            answers[1]["error"]
                .as_str()
                .unwrap()
                .contains("match record changed"),
            "{}",
            answers[1]
        );
    }
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
    assert_eq!(start.prev, [0; 32], "Start has no predecessor");
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
    assert!(
        started.get("log").is_none(),
        "no plaintext log leaves the referee"
    );
    rc
}

/// A phone: its index, keys and batch chain.
struct Phone {
    account: String,
    index: u16,
    keys: PlayerKeys,
    seq: u32,
    prev: Hash,
}

impl Phone {
    /// Opens this player's sealed, signed keys from the `start` answer.
    fn open(started: &Value, account: &str, referee_pk: &VerifyingKey) -> Self {
        let entry = started["keys"]
            .as_array()
            .unwrap()
            .iter()
            .find(|k| k["account_id"] == account)
            .unwrap();
        let sealed = unb64(&entry["sealed"]);
        assert_eq!(sealed.len(), SEALED_TO_PHONE, "{account}: keys padded");
        let signed: SignedPlayerKeys = seal::open_on_phone(&box_sk(account), &sealed).unwrap();
        assert!(
            verifies(referee_pk, &keys_sig_digest(&signed.keys), &signed.sig),
            "{account}: keys signed by referee_pk"
        );
        Self {
            account: account.into(),
            index: signed.keys.player,
            keys: signed.keys,
            seq: 0,
            prev: [0; 32],
        }
    }

    /// One batch with a fix in the zone, sealed to the referee box key; returns it and its hash.
    fn batch(&mut self, box_pk: &[u8; 32], t_ms: u64, actions: Vec<Action>, counter: u32) -> (String, Hash) {
        let batch = Batch {
            match_id: self.keys.match_id,
            player: self.index,
            seq: self.seq,
            prev: self.prev,
            t_ms,
            fixes: vec![Fix {
                t_ms: t_ms - 1_000,
                lat_e7: ZONE.0 + i32::from(self.index) * 100,
                lon_e7: ZONE.1,
                acc_m: 5,
                speed_cmps: 0,
                flags: 0,
            }],
            sightings: Vec::new(),
            actions,
        };
        let assertion = appattest::sign_assertion(
            &device_key(&self.account),
            &batch_client_data_hash(&batch),
            APP_ID,
            counter,
        );
        self.seq += 1;
        self.prev = batch_hash(&batch);
        let hash = self.prev;
        let env = BatchEnvelope { batch, assertion };
        let sealed = seal::seal_with(
            &[self.index as u8 + 1; 32],
            box_pk,
            &borsh::to_vec(&env).unwrap(),
            domain::BATCH,
        )
        .unwrap();
        (b64(&sealed), hash)
    }

    fn hud(&self, out: &Value, referee_pk: &VerifyingKey) -> Hud {
        let entry = out["huds"]
            .as_array()
            .unwrap()
            .iter()
            .find(|h| h["player"] == self.index)
            .unwrap();
        let sealed = unb64(&entry["sealed"]);
        assert_eq!(sealed.len(), SEALED_TO_PHONE, "{}: HUD padded", self.account);
        let signed: SignedHud = seal::open_on_phone(&box_sk(&self.account), &sealed).unwrap();
        assert!(
            verifies(referee_pk, &hud_sig_digest(&signed.hud), &signed.sig),
            "{}: HUD signed by referee_pk",
            self.account
        );
        signed.hud
    }
}

/// What the relay keeps of every call: the leaf hashes and the sealed log blobs, in order, and
/// each anchored `(size, root)` with the proof that came with it.
#[derive(Default)]
struct Kept {
    leaves: Vec<Hash>,
    sealed: Vec<String>,
    anchored: Vec<(u64, Hash)>,
    proofs: Vec<(u64, u64, Vec<Hash>)>,
}

impl Kept {
    /// Each proof leads from the root anchored before to its own, as the contract checks it.
    fn check_proofs(&self) {
        let mut prev = (0u64, merkle::empty_root());
        for ((from, size, path), (s, root)) in self.proofs.iter().zip(&self.anchored) {
            assert_eq!((*from, *size), (prev.0, *s));
            assert_eq!(merkle::root(&self.leaves[..*s as usize]), *root);
            assert!(merkle::verify_consistency(*from, *size, &prev.1, root, path));
            prev = (*size, *root);
        }
    }

    fn take(&mut self, out: &Value) {
        assert!(out.get("log").is_none(), "no plaintext log during play");
        self.leaves
            .extend(out["leaves"].as_array().unwrap().iter().map(fixed::<32>));
        self.sealed.push(out["log_sealed"].as_str().unwrap().to_owned());
        // `start` and `tick` name the log after the call; `end` names the End verdict's.
        if let Some(root) = out.get("log_root") {
            assert_eq!(
                out["log_size"],
                self.leaves.len(),
                "log_size counts every leaf so far"
            );
            assert_eq!(root.as_str().unwrap(), hex::encode(merkle::root(&self.leaves)));
        }
        for v in out["verdicts"].as_array().unwrap() {
            let v = verdict(v);
            if let Verdict::Checkpoint { log_size, root } | Verdict::End { log_size, root, .. } = v.body {
                let p = out["proofs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|p| p["seq"] == v.seq)
                    .expect("a proof for every anchored root");
                let from = p["from_size"].as_u64().unwrap();
                let path: Vec<Hash> = p["path"].as_array().unwrap().iter().map(fixed::<32>).collect();
                self.proofs.push((from, log_size, path));
                self.anchored.push((log_size, root));
            }
        }
    }
}

/// `voice` on the tick's sealed hint: the line comes back signed and sealed to the asker, and
/// nothing the relay sees names the fact or the words. Returns the answer.
fn check_voice(
    dir: &Path,
    referee_pk: &VerifyingKey,
    t1: &Value,
    asker: &Phone,
    match_id: [u8; 16],
) -> Value {
    let hints = t1["hints"].as_array().unwrap();
    let v = call(
        dir,
        &json!({ "cmd": "voice", "state": t1["state"], "blob": hints[0]["blob"] }),
    );
    // Only what the relay needs: nothing names the fact, the words, or whether the model or a
    // template spoke beyond `signed_text` (null: no model signature).
    let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, ["hint_id", "player", "receipt", "sealed", "signed_text"]);
    assert!(v["signed_text"].is_null(), "no model, so nothing NEAR AI signed");
    let sealed = unb64(&v["sealed"]);
    assert_eq!(sealed.len(), SEALED_TO_PHONE, "the line is padded");
    // The receipt names its hint and this sealed line, in the clear.
    let receipt = unb64(&v["receipt"]);
    assert_eq!(receipt[..4], 0u32.to_le_bytes());
    assert_eq!(receipt[4..36], sha256(&[&sealed]));
    let line: SignedVoiceLine = seal::open_on_phone(&box_sk(&asker.account), &sealed).unwrap();
    assert!(verifies(referee_pk, &voice_sig_digest(&line.line), &line.sig));
    assert_eq!(
        line.line,
        VoiceLine {
            match_id,
            player: 0,
            hint_id: 0,
            text: line.line.text.clone()
        }
    );
    assert!(!line.line.text.is_empty());
    let forged_blob = refused(
        Some(dir),
        &json!({ "cmd": "voice", "state": t1["state"], "blob": b64(&[match_id.as_slice(), &[0; 60]].concat()) }),
    );
    assert!(forged_blob.contains("not made by this referee"), "{forged_blob}");

    v
}

/// The declassified log is exactly what the leaves committed to: one `Enrolled` per player, a
/// `Tick` per tick, the forged batch as `Rejected`, and the hint's receipt.
fn check_log(d: &Value, kept: &Kept, phones: &[Phone], forger: u16, forged_hash: Hash) {
    let log: Vec<LogEntry> = d["log"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| borsh::from_slice(&unb64(e)).unwrap())
        .collect();
    assert_eq!(log.iter().map(merkle::leaf).collect::<Vec<_>>(), kept.leaves);
    for (i, p) in phones.iter().enumerate() {
        let pk = appattest::public_key_bytes(device_key(&p.account).verifying_key());
        assert_eq!(
            log[i],
            LogEntry::Enrolled {
                player: p.index,
                account: p.account.clone(),
                key_hash: sha256(&[&pk]),
                attested: false
            }
        );
    }
    let ticks: Vec<u32> = log
        .iter()
        .filter_map(|e| match e {
            LogEntry::Tick { tick_no, .. } => Some(*tick_no),
            _ => None,
        })
        .collect();
    assert_eq!(ticks, [1, 2, 3]);
    assert!(log.contains(&LogEntry::Rejected {
        player: forger,
        seq: 0,
        hash: forged_hash,
        code: reject_code::ASSERTION
    }));
    assert_eq!(
        log.iter()
            .filter(|e| matches!(e, LogEntry::HintReceipt { hint_id: 0, .. }))
            .count(),
        1,
        "one receipt per hint, however often the relay passes it"
    );
    // K_m comes out with the log, so anyone can check every salt is the one its index gets.
    let k_m: [u8; 32] = hex::decode(d["k_m"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    assert_eq!(check_log_salts(&k_m, &log), Ok(()));
    assert!(
        log.iter().any(|e| e.salt().is_some()),
        "the receipt at least is salted"
    );
}

/// Tick 1: the hint is charged and handed out as an opaque blob, the forged batch is refused
/// with its code, and the hunter's signed HUD names the log and its chain. Returns the digest
/// of the Hint verdict.
fn check_tick1(
    t1: &Value,
    kept: &Kept,
    phones: &[Phone],
    other: usize,
    referee_pk: &VerifyingKey,
    start_digest: Hash,
) -> Hash {
    let (hunter, match_id) = (0, phones[0].keys.match_id);
    assert_eq!(
        (t1["tick_no"].as_u64(), t1["opened"].as_u64()),
        (Some(1), Some(3))
    );
    assert_eq!(
        t1["rejected"],
        json!([{ "player": other, "seq": 0, "reason": reject_code::ASSERTION }])
    );
    let hint_v = verdict(&t1["verdicts"][0]);
    assert_eq!(hint_v.prev, start_digest, "the Hint verdict chains to Start");
    assert!(matches!(
        hint_v.body,
        Verdict::Hint {
            from: 0,
            hint: 0,
            hint_id: 0,
            ..
        }
    ));
    let hints = t1["hints"].as_array().unwrap();
    assert_eq!(hints.len(), 1);
    assert_eq!(hints[0]["player"], 0);
    assert_eq!(
        hints[0].as_object().unwrap().len(),
        2,
        "only who asked, and an opaque blob"
    );
    let hud = phones[hunter].hud(t1, referee_pk);
    assert_eq!((hud.match_id, hud.player, hud.next_seq), (match_id, 0, 1));
    assert_eq!(
        (hud.chain_tip, hud.log_size),
        (phones[hunter].prev, kept.leaves.len() as u64)
    );
    assert_eq!(hud.root, merkle::root(&kept.leaves));
    assert!(hud.hint_fact.is_some_and(|f| f.hint == 0));
    assert_eq!(
        phones[other].hud(t1, referee_pk).rejected,
        None,
        "a forgery is not the player's"
    );

    verdict_digest(&hint_v.payload())
}

/// The End verdict chains to `prev` and is signed, and its VRF reveal verifies under `vrf_pk`
/// with the alpha the contract checks. Returns it with its alpha and VRF signature.
fn check_end(
    ended: &Value,
    started: &Value,
    (referee_pk, vrf_pk): (&VerifyingKey, &VerifyingKey),
    prev: Hash,
) -> (SignedVerdict, String, [u8; 64]) {
    let digest = prev;
    let match_id = verdict(&started["verdicts"][0]).match_id;
    let end = verdict(&ended["verdicts"][0]);
    assert_eq!(
        end.prev, digest,
        "End chains to the last checkpoint (no verdict since)"
    );
    assert!(
        verifies(referee_pk, &verdict_digest(&end.payload()), &end.sig),
        "End signature"
    );
    let Verdict::End {
        alpha, vrf_signature, ..
    } = end.body.clone()
    else {
        panic!("end verdict is not End")
    };
    assert!(
        verifies(vrf_pk, alpha.as_bytes(), &vrf_signature),
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

    (end, alpha, vrf_signature)
}

/// `declassify_batches` returns every batch sent, each with its assertion.
fn check_trails(dir: &Path, match_id: [u8; 16], sent: &[String]) {
    let trails = call(
        dir,
        &json!({ "cmd": "declassify_batches", "match_id": b64(&match_id), "sealed": sent }),
    );
    assert_eq!(trails["batches"].as_array().unwrap().len(), sent.len());
    for (b, a) in trails["batches"]
        .as_array()
        .unwrap()
        .iter()
        .zip(trails["assertions"].as_array().unwrap())
    {
        let batch: Batch = borsh::from_slice(&unb64(b)).unwrap();
        assert!(!unb64(a).is_empty(), "seq {} has its assertion", batch.seq);
    }
}

/// `start` of a two-minute match that is over by now, so ticks can run its whole time; a
/// second `start` of the same id is refused. Returns the answer, the window and the ring commit.
fn start_match(
    dir: &Path,
    referee_pk: &VerifyingKey,
    accounts: &[&str],
    match_id: [u8; 16],
) -> (Value, u64, u64, [u8; 32]) {
    let start_ms = wall_ms() - 200_000;
    let end_ms = start_ms + 120_000;
    let started = call(
        dir,
        &json!({
            "cmd": "start",
            "match_id": b64(&match_id),
            "players": accounts,
            "start_ms": start_ms,
            "duration_ms": 120_000,
            "stake": "1000000",
            "zone": { "lat_e7": ZONE.0, "lon_e7": ZONE.1, "radius_m": 500 },
        }),
    );
    let rc = check_start(&started, referee_pk, match_id, accounts, (start_ms, end_ms));
    let twice = refused(
        Some(dir),
        &json!({ "cmd": "start", "match_id": b64(&match_id), "players": accounts, "duration_ms": 60_000,
                 "stake": "1", "zone": { "lat_e7": 0, "lon_e7": 0, "radius_m": 500 } }),
    );
    assert!(twice.contains("already started"), "{twice}");
    (started, start_ms, end_ms, rc)
}

/// A receipt is bound to its hint and its sealed line: renamed for another line, it is refused
/// (and the refused tick changes nothing).
fn refuse_moved_receipt(dir: &Path, match_id: [u8; 16], t1: &Value, batch: &str, v: &Value) {
    let mut moved = unb64(&v["receipt"]);
    moved[4] ^= 1;
    let err = refused(
        Some(dir),
        &json!({ "cmd": "tick", "match_id": b64(&match_id), "state": t1["state"], "last_seq": t1["seq"],
                 "now_ms": t1["now_ms"].as_u64().unwrap() + 50_000, "batches": [batch],
                 "receipts": [b64(&moved)] }),
    );
    assert!(err.contains("receipt 0"), "{err}");
}

#[test]
fn an_enrolled_account_moves_only_with_its_devices_consent() {
    let tmp = TempDir::new("rebind");
    let dir = tmp.0.as_path();
    let account = "dana.test.near";
    let near = |n: u8| ed25519_dalek::SigningKey::from_bytes(&[n; 32]);
    let input = |box_seed: u8, near_seed: u8| {
        json!({
            "cmd": "enroll",
            "account_id": account,
            "app_attest_pk": b64(&appattest::public_key_bytes(device_key(&format!("{account}/{box_seed}")).verifying_key())),
            "player_box_pk": b64(&seal::public_key(&[box_seed; 32])),
            "near_pk": b64(&near(near_seed).verifying_key().to_bytes()),
        })
    };
    // With nothing stored, a rebind_sig (a phone unsure whether this referee knows it) is ignored.
    let mut fresh = input(1, 1);
    fresh["rebind_sig"] = json!(b64(&[0; 64]));
    let first = call(dir, &fresh);
    // The same keys again (a retry after a lost answer): the stored receipt, unchanged.
    let again = call(dir, &input(1, 1));
    assert_eq!(again["receipt"], first["receipt"]);
    assert_eq!(again["call_id"], first["call_id"]);
    // Other keys, as a relay with a phone of its own would send: refused.
    let err = refused(Some(dir), &input(2, 2));
    assert!(err.contains("rebind_sig"), "{err}");
    // Signed by the new NEAR key rather than the enrolled one: refused.
    let rebind = |signer: u8| {
        let mut i = input(2, 2);
        let new_attest: [u8; 65] = unb64(&i["app_attest_pk"]).try_into().unwrap();
        let digest = tail_protocol::digest::rebind_digest(
            account,
            &new_attest,
            &fixed(&i["player_box_pk"]),
            &fixed(&i["near_pk"]),
        );
        i["rebind_sig"] = json!(b64(
            &ed25519_dalek::Signer::sign(&near(signer), &digest).to_bytes()
        ));
        i
    };
    let err = refused(Some(dir), &rebind(2));
    assert!(err.contains("not the enrolled device"), "{err}");
    // The enrolled device's consent moves it.
    let moved = call(dir, &rebind(1));
    assert_ne!(moved["receipt"], first["receipt"]);
    let device: [u8; 32] = unb64(&moved["receipt"])[account.len() + 4 + 65 + 1..][..32]
        .try_into()
        .unwrap();
    assert_eq!(device, seal::public_key(&[2; 32]));
    // And the old keys cannot come back without the new device's consent.
    assert!(refused(Some(dir), &input(1, 1)).contains("rebind_sig"));
}

#[test]
fn plays_a_match_with_keys_on_disk() {
    let tmp = TempDir::new("match");
    let dir = tmp.0.as_path();
    let (keys, referee_pk, vrf_pk) = pubkeys(dir);
    let box_pk: [u8; 32] = fixed(&keys["referee_box_pk"]);
    let accounts = ["carol.test.near", "alice.test.near", "bob.test.near"];
    enroll_all(dir, &referee_pk, &accounts);

    // ── start ──
    let match_id = [7u8; 16];
    let (started, start_ms, end_ms, rc) = start_match(dir, &referee_pk, &accounts, match_id);
    let mut kept = Kept::default();
    kept.take(&started);
    let mut phones: Vec<Phone> = accounts
        .iter()
        .map(|a| Phone::open(&started, a, &referee_pk))
        .collect();
    phones.sort_by_key(|p| p.index);
    let hunter = 0usize;
    let target = phones
        .iter()
        .position(|p| p.account == phones[0].keys.target)
        .unwrap();
    let other = 3 - hunter - target;
    let mut digest = verdict_digest(&verdict(&started["verdicts"][0]).payload());

    // ── tick 1: the hunter asks a hint; the third phone's batch is forged ──
    let t1_ms = start_ms + 10_000;
    let hint = vec![Action::Hint {
        hint: 0,
        nonce: 1,
        text: Some("close?".into()),
    }];
    let (hb, _) = phones[hunter].batch(&box_pk, t1_ms - 1_000, hint, 1);
    let (tb, _) = phones[target].batch(&box_pk, t1_ms - 1_000, Vec::new(), 1);
    // Signed with another device key than the one this player enrolled: a forgery.
    let mut forger = Phone::open(&started, &phones[other].account, &referee_pk);
    forger.account = phones[hunter].account.clone();
    let (fb, forged_hash) = forger.batch(&box_pk, t1_ms - 1_000, Vec::new(), 1);
    let mut sent = vec![hb.clone(), tb.clone(), fb.clone()];
    let t1 = call(
        dir,
        &json!({ "cmd": "tick", "match_id": b64(&match_id), "state": started["state"], "last_seq": 1,
                 "now_ms": t1_ms, "batches": [hb, tb, fb] }),
    );
    kept.take(&t1);
    digest = check_tick1(&t1, &kept, &phones, other, &referee_pk, digest);

    // ── voice: the line comes back sealed to the asker and signed ──
    let v = check_voice(dir, &referee_pk, &t1, &phones[hunter], match_id);

    // ── tick 2 at one minute: the receipt joins the log, and a checkpoint lands ──
    let t2_ms = start_ms + 60_000;
    let (hb2, _) = phones[hunter].batch(&box_pk, t2_ms - 1_000, Vec::new(), 2);
    sent.push(hb2.clone());
    refuse_moved_receipt(dir, match_id, &t1, &hb2, &v);
    // Passed twice, it is logged once (check_log counts).
    let t2 = call(
        dir,
        &json!({ "cmd": "tick", "match_id": b64(&match_id), "state": t1["state"], "last_seq": t1["seq"],
                 "now_ms": t2_ms, "batches": [hb2], "receipts": [v["receipt"], v["receipt"]] }),
    );
    kept.take(&t2);
    let cp = verdict(&t2["verdicts"][0]);
    assert!(matches!(cp.body, Verdict::Checkpoint { .. }) && cp.prev == digest);
    digest = verdict_digest(&cp.payload());
    let stale = refused(
        Some(dir),
        &json!({ "cmd": "tick", "match_id": b64(&[8u8; 16]), "state": t2["state"], "last_seq": t2["seq"] }),
    );
    assert!(stale.contains("does not open"), "{stale}");
    let t3 = call(
        dir,
        &json!({ "cmd": "tick", "match_id": b64(&match_id), "state": t2["state"], "last_seq": t2["seq"],
                 "now_ms": end_ms }),
    );
    kept.take(&t3);
    assert_eq!(t3["over"], true);

    // ── end: the VRF reveal verifies under vrf_pk and opens the ring commit ──
    let ended = end_once(
        dir,
        &json!({ "cmd": "end", "match_id": b64(&match_id), "state": t3["state"], "last_seq": t3["seq"] }),
    );
    kept.take(&ended);
    let (end, alpha, vrf_signature) = check_end(&ended, &started, (&referee_pk, &vrf_pk), digest);
    assert_eq!(rc, ring_commit(&vrf_signature));

    // ── every anchored root is consistent with the one before, as the contract checks ──
    assert_eq!(kept.proofs.len(), 2, "one Checkpoint and End");
    kept.check_proofs();

    // ── declassify: the plaintext log, checked against the leaves and the End root ──
    let short = refused(
        Some(dir),
        &json!({ "cmd": "declassify", "match_id": b64(&match_id), "log_sealed": kept.sealed[1..] }),
    );
    assert!(short.contains("log index 0"), "{short}");
    let d = call(
        dir,
        &json!({ "cmd": "declassify", "match_id": b64(&match_id), "log_sealed": kept.sealed }),
    );
    assert_eq!(d["vrf_alpha"], alpha);
    let ring: Vec<String> = serde_json::from_value(d["ring"].clone()).unwrap();
    assert_eq!(ring, build_ring(&accounts, &vrf_signature));
    check_log(&d, &kept, &phones, other as u16, forged_hash);

    // ── declassify_batches: every batch with its assertion ──
    check_trails(dir, match_id, &sent);

    let again = refused(
        Some(dir),
        &json!({ "cmd": "end", "match_id": b64(&match_id), "state": ended["state"], "last_seq": end.seq }),
    );
    assert!(again.contains("AlreadyEnded"), "{again}");

    check_modes(dir);

    // ── a second process with the same directory has the same keys ──
    // ed25519 signatures are deterministic, so even `box_pk_sig` is byte for byte the same.
    assert_eq!(call(dir, &json!({ "cmd": "pubkeys" })), keys);
}

#[test]
fn end_answers_a_repeat_with_the_recorded_end_and_refuses_any_other() {
    let tmp = TempDir::new("end-again");
    let dir = tmp.0.as_path();
    let (keys, referee_pk, _) = pubkeys(dir);
    let box_pk: [u8; 32] = fixed(&keys["referee_box_pk"]);
    let accounts = ["carol.test.near", "alice.test.near", "bob.test.near"];
    enroll_all(dir, &referee_pk, &accounts);
    let match_id = [9u8; 16];
    let (started, start_ms, end_ms, _) = start_match(dir, &referee_pk, &accounts, match_id);
    let mut phones: Vec<Phone> = accounts
        .iter()
        .map(|a| Phone::open(&started, a, &referee_pk))
        .collect();
    phones.sort_by_key(|p| p.index);
    // Tick 1: everyone reports, and player 0 asks a hint. Its receipt is not passed on, as when
    // `voice` failed before End.
    let t1_ms = start_ms + 10_000;
    let batches: Vec<String> = phones
        .iter_mut()
        .map(|p| {
            let actions = if p.index == 0 {
                vec![Action::Hint {
                    hint: 0,
                    nonce: 1,
                    text: Some("close?".into()),
                }]
            } else {
                Vec::new()
            };
            p.batch(&box_pk, t1_ms - 1_000, actions, 1).0
        })
        .collect();
    let t1 = call(
        dir,
        &json!({ "cmd": "tick", "match_id": b64(&match_id), "state": started["state"], "last_seq": 1,
                 "now_ms": t1_ms, "batches": batches }),
    );
    assert_eq!(t1["hints"].as_array().map(Vec::len), Some(1), "{t1}");
    let v = call(
        dir,
        &json!({ "cmd": "voice", "state": t1["state"], "blob": t1["hints"][0]["blob"] }),
    );
    let t2 = call(
        dir,
        &json!({ "cmd": "tick", "match_id": b64(&match_id), "state": t1["state"], "last_seq": t1["seq"],
                 "now_ms": end_ms }),
    );
    assert_eq!(t2["over"], true);
    let end = |receipts: &[&Value]| {
        json!({ "cmd": "end", "match_id": b64(&match_id), "state": t2["state"], "last_seq": t2["seq"],
                "receipts": receipts })
    };
    let first = call(dir, &end(&[]));
    // The answer was lost: the same call again gets the same End, signature and proof included.
    let again = call(dir, &end(&[]));
    for k in [
        "call_id", "seq", "verdicts", "proofs", "log_size", "root", "leaves",
    ] {
        assert_eq!(again[k], first[k], "{k}");
    }
    // A repeat that would end the match another way (here with the receipt the first left out)
    // is refused: the match keeps the End it recorded.
    let other = refused(Some(dir), &end(&[&v["receipt"]]));
    assert!(other.contains("another End"), "{other}");
    assert_eq!(call(dir, &end(&[]))["verdicts"], first["verdicts"]);
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
