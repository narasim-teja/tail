//! Plays a short scripted match through referee-core the way referee-wasi drives it, and builds
//! the v2 replay bundle the relay would serve for it. Shared by the tests and the
//! `demo-bundle` example.
//!
//! Three players stand a few metres apart in one zone and hear each other. Over the match the
//! log gets: a hint and its receipt, Checkpoints, a teleport (validity refusal), a resent
//! batch and an in-tick duplicate (SEQ), a batch first sent with a broken assertion
//! (ASSERTION, then accepted), and a three-way strike at 125 s that the VRF coin orders.

#![allow(dead_code)]

use base64::Engine as _;
use ed25519_dalek::{Signer as _, SigningKey};
use referee_core::{Circle, Device, HintReceipt, MatchConfig, TickInput};
use referee_sim::phone::{device_key, Phone};
use referee_sim::{APP_ID, START_MS};
use referee_verify::{
    Bundle, BundleCircle, BundleDevice, BundleMatch, BundleReferee, BundleRejected, BundleReveal,
    BundleVerdict,
};
use tail_protocol::digest::{batch_hash, sha256, verdict_digest};
use tail_protocol::{hint_kind, merkle, BatchEnvelope, Fix, LogEntry, SignedVerdict, VerdictPayload};

pub const NAMES: [&str; 3] = ["alice", "bob", "carol"];
pub const MATCH_ID: [u8; 16] = [0x7a; 16];
pub const DURATION_MS: u64 = 300_000;
pub const STAKE: u128 = 1_000_000;
const ZONE: Circle = Circle {
    lat_e7: 525_200_000,
    lon_e7: 134_050_000,
    radius_m: 1_000,
};
/// About one metre of latitude in 1e-7 degrees.
const M_E7: i32 = 90;

pub struct Played {
    pub cfg: MatchConfig,
    pub alpha: String,
    pub vrf_signature: [u8; 64],
    pub k_m: [u8; 32],
    pub referee: SigningKey,
    pub vrf: SigningKey,
    pub verdicts: Vec<VerdictPayload>,
    pub log: Vec<LogEntry>,
    /// Every envelope the referee was handed, in order (resends and duplicates included).
    pub sent: Vec<BatchEnvelope>,
}

fn call_id(n: u32) -> [u8; 16] {
    let mut id = [0xca; 16];
    id[..4].copy_from_slice(&n.to_le_bytes());
    id
}

/// One second of the match on every phone still in: a fix, a scan, the scripted actions, and
/// a batch every 5 s.
fn second(phones: &mut [Phone], s: u64, t_ms: u64, outbox: &mut Vec<BatchEnvelope>) {
    let live: Vec<usize> = (0..phones.len()).filter(|&i| !phones[i].out()).collect();
    for &i in &live {
        // carol's phone reports one fix 2 km away: the referee refuses that batch.
        let north_m = if i == 2 && s == 42 {
            2_000
        } else {
            3 * i32::from(phones[i].index)
        };
        phones[i].fix(Fix {
            t_ms,
            lat_e7: ZONE.lat_e7 + north_m * M_E7,
            lon_e7: ZONE.lon_e7,
            acc_m: 5,
            speed_cmps: 0,
            flags: 0,
        });
    }
    for &h in &live {
        for &o in &live {
            if h != o {
                let tok = phones[o].token(t_ms).unwrap();
                phones[h].hear(t_ms, tok, -60);
            }
        }
    }
    if s == 30 {
        phones[0].hint(hint_kind::NEAR, Some("close?".into()));
    }
    if s == 125 {
        for &i in &live {
            phones[i].strike();
        }
    }
    if s.is_multiple_of(5) {
        for &i in &live {
            outbox.push(phones[i].batch(t_ms));
        }
    }
}

/// What the network does to some ticks' batches before the referee sees them.
fn tamper(tick_no: u32, batches: &mut Vec<BatchEnvelope>, last_tick: &[BatchEnvelope]) {
    match tick_no {
        // The relay resends alice's batch from the tick before.
        7 => batches.extend(last_tick.iter().filter(|e| e.batch.player == 0).take(1).cloned()),
        // A duplicate inside one tick.
        8 => {
            let dup = batches.iter().find(|e| e.batch.player == 0).cloned().unwrap();
            batches.push(dup);
        }
        // bob's batch arrives first with a broken assertion, then intact.
        9 => {
            let i = batches.iter().position(|e| e.batch.player == 1).unwrap();
            let mut broken = batches[i].clone();
            let last = broken.assertion.len() - 1;
            broken.assertion[last] ^= 1;
            batches.insert(i, broken);
        }
        _ => {}
    }
}

pub fn play() -> Played {
    let referee = SigningKey::from_bytes(&[0x11; 32]);
    let vrf = SigningKey::from_bytes(&[0x22; 32]);
    let alpha = format!("vrf:1:tail.testnet:{}", hex::encode(MATCH_ID));
    let vrf_signature = vrf.sign(alpha.as_bytes()).to_bytes();
    let k_m = sha256(&[b"tail/verify-test/k_m"]);
    let cfg = MatchConfig {
        match_id: MATCH_ID,
        app_id: APP_ID.into(),
        stake: STAKE,
        duration_ms: DURATION_MS,
        zone: ZONE,
        safehouses: Vec::new(),
    };
    let devices = NAMES
        .iter()
        .map(|n| Device {
            account_id: (*n).into(),
            key: appattest::public_key_bytes(device_key(n).verifying_key()),
            counter: 0,
            attested: true,
        })
        .collect();
    let started =
        referee_core::init(cfg.clone(), devices, &k_m, &vrf_signature, START_MS, call_id(0)).unwrap();
    let mut verdicts = started.verdicts;
    let mut log = started.log;
    let mut phones: Vec<Phone> = started
        .keys
        .into_iter()
        .map(|(i, k)| Phone::new(NAMES[i as usize].into(), i, k, APP_ID.into()))
        .collect();
    let mut state = started.state;
    let mut sent = Vec::new();
    let mut outbox: Vec<BatchEnvelope> = Vec::new();
    let mut receipts = Vec::new();
    let mut last_tick_batches: Vec<BatchEnvelope> = Vec::new();
    for s in 1u64.. {
        let t_ms = START_MS + s * 1000;
        second(&mut phones, s, t_ms, &mut outbox);
        if !s.is_multiple_of(10) {
            continue;
        }
        let tick_no = (s / 10) as u32;
        let mut batches = std::mem::take(&mut outbox);
        tamper(tick_no, &mut batches, &last_tick_batches);
        last_tick_batches.clone_from(&batches);
        sent.extend(batches.iter().cloned());
        let out = referee_core::tick(
            state,
            TickInput {
                tick_no,
                now_ms: t_ms,
                call_id: call_id(tick_no),
                batches,
                receipts: std::mem::take(&mut receipts),
            },
        )
        .unwrap();
        log.extend(out.log);
        verdicts.extend(out.verdicts);
        receipts = out
            .hints
            .iter()
            .map(|h| HintReceipt {
                hint_id: h.hint_id,
                chat_id: format!("chat-{}", h.hint_id),
                text_hash: sha256(&[b"line", &h.hint_id.to_le_bytes()]),
                signature: vec![1; 65],
                signing_address: "0x00000000000000000000000000000000000000aa".into(),
            })
            .collect();
        for (p, hud) in out.huds {
            phones[p as usize].last_hud = Some(hud);
        }
        state = out.state;
        if out.over {
            let fin = referee_core::finish(
                state,
                alpha.clone(),
                &vrf_signature,
                call_id(tick_no + 1),
                receipts,
            )
            .unwrap();
            log.extend(fin.log);
            verdicts.extend(fin.verdicts);
            break;
        }
    }
    Played {
        cfg,
        alpha,
        vrf_signature,
        k_m,
        referee,
        vrf,
        verdicts,
        log,
        sent,
    }
}

pub fn b64(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}

pub fn sign(p: &Played, v: &VerdictPayload) -> String {
    let signed = SignedVerdict {
        match_id: v.match_id,
        seq: v.seq,
        prev: v.prev,
        call_id: v.call_id,
        body: v.body.clone(),
        sig: p.referee.sign(&verdict_digest(v)).to_bytes(),
    };
    b64(&borsh::to_vec(&signed).unwrap())
}

/// Which optional fields the bundle carries.
#[derive(Clone, Copy)]
pub struct Extras {
    /// `devices[].appAttestPk`.
    pub keys: bool,
    /// `assertions[]` and `rejected[]`.
    pub assertions: bool,
}

/// What the relay serves (apps/server `routes/replay.ts`).
pub const FULL: Extras = Extras {
    keys: true,
    assertions: true,
};
/// A bundle from a relay before it released keys, assertions and refused batches.
pub const OLDER_RELAY: Extras = Extras {
    keys: false,
    assertions: false,
};

/// Builds the bundle the way the relay does (`Matches.declassifyTrails`): each accepted batch
/// once in `batches`, and each other distinct (batch, assertion) envelope a `Rejected` entry
/// names in `rejected`.
pub fn bundle(p: &Played, x: Extras) -> Bundle {
    let logged = |rejected: bool| -> Vec<_> {
        p.log
            .iter()
            .filter_map(|e| match e {
                LogEntry::Batch { hash, .. } if !rejected => Some(*hash),
                LogEntry::Rejected { hash, .. } if rejected => Some(*hash),
                _ => None,
            })
            .collect()
    };
    let (accepted, refused) = (logged(false), logged(true));
    let mut batches = Vec::new();
    let mut assertions = Vec::new();
    let mut rejected = Vec::new();
    let mut trailed = Vec::new();
    let mut envelopes = Vec::new();
    for e in &p.sent {
        let h = batch_hash(&e.batch);
        let envelope = (h, e.assertion.clone());
        if envelopes.contains(&envelope) {
            continue;
        }
        let raw = b64(&borsh::to_vec(&e.batch).unwrap());
        if accepted.contains(&h) && !trailed.contains(&h) {
            trailed.push(h);
            envelopes.push(envelope);
            batches.push(raw);
            assertions.push(Some(b64(&e.assertion)));
        } else if refused.contains(&h) && x.assertions {
            envelopes.push(envelope);
            rejected.push(BundleRejected {
                batch: raw,
                assertion: b64(&e.assertion),
            });
        }
    }
    Bundle {
        version: 2,
        game: BundleMatch {
            id: hex::encode(MATCH_ID),
            stake: STAKE.to_string(),
            start_ms: START_MS,
            end_ms: START_MS + DURATION_MS,
            zone: BundleCircle {
                lat_e7: ZONE.lat_e7,
                lon_e7: ZONE.lon_e7,
                radius_m: ZONE.radius_m,
            },
            safehouses: Vec::new(),
            players: NAMES.iter().map(|n| (*n).into()).collect(),
            app_id: Some(APP_ID.into()),
        },
        referee: BundleReferee {
            referee_pk: hex::encode(p.referee.verifying_key().to_bytes()),
            vrf_pk: hex::encode(p.vrf.verifying_key().to_bytes()),
        },
        verdicts: p
            .verdicts
            .iter()
            .map(|v| BundleVerdict { signed: sign(p, v) })
            .collect(),
        leaves: p.log.iter().map(|e| hex::encode(merkle::leaf(e))).collect(),
        log: p.log.iter().map(|e| b64(&borsh::to_vec(e).unwrap())).collect(),
        batches,
        assertions: x.assertions.then_some(assertions),
        rejected: x.assertions.then_some(rejected),
        reveal: BundleReveal {
            vrf_alpha: p.alpha.clone(),
            vrf_signature: hex::encode(p.vrf_signature),
            k_m: hex::encode(p.k_m),
        },
        devices: NAMES
            .iter()
            .map(|n| BundleDevice {
                account_id: (*n).into(),
                app_attest_pk: x
                    .keys
                    .then(|| hex::encode(appattest::public_key_bytes(device_key(n).verifying_key()))),
                counter: None,
            })
            .collect(),
    }
}

// ── reading and rewriting a bundle, as a dishonest referee or relay would ────────────

pub fn entries(b: &Bundle) -> Vec<LogEntry> {
    b.log
        .iter()
        .map(|e| borsh::from_slice(&base64::engine::general_purpose::STANDARD.decode(e).unwrap()).unwrap())
        .collect()
}

/// Replaces log entry `i` and its leaf, so the log still matches its leaves.
pub fn set_entry(b: &mut Bundle, i: usize, e: &LogEntry) {
    b.log[i] = b64(&borsh::to_vec(e).unwrap());
    b.leaves[i] = hex::encode(merkle::leaf(e));
}

pub fn remove_entry(b: &mut Bundle, i: usize) {
    b.log.remove(i);
    b.leaves.remove(i);
}

/// The tick whose segment holds log index `i`.
pub fn tick_of(log: &[LogEntry], i: usize) -> u32 {
    log[..=i]
        .iter()
        .rev()
        .find_map(|e| match e {
            LogEntry::Tick { tick_no, .. } => Some(*tick_no),
            _ => None,
        })
        .unwrap()
}
