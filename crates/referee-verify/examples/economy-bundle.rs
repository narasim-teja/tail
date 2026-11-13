//! Prints the replay bundle of a 12-player, 60-minute match on Boston Common, played through the
//! real `referee-core` engine, as the relay would serve it. The web replay's economy fixture
//! (`apps/web/scripts/economy-fixture.ts`) is this output; `tail-verify --strict` passes on it.
//!
//! `economy-bundle [--summary]`: `--summary` prints what happened instead of the bundle.
//!
//! The phones are `referee-sim`'s (real beacon tokens, borsh batches, hash chains and P-256 App
//! Attest assertions). Scripted walkers wander the park's real paths (OpenStreetMap, the web
//! fixture's `common-paths.json`), buy hints in four waves so hint demand rises and falls, and
//! hunt along the ring: a hunter closes on its target, shadows it until the lock fills, and
//! strikes. One phone goes dark and one player walks out of the zone; both forfeit.
//!
//! THE KEYS HERE ARE TEST FIXTURES. The referee, VRF and device keys derive from public strings
//! in this file. They never touched NEAR, and the Handler lines are templates no model signed.

// Positions are metres and seconds in a park; their f64 conversions are well inside 2^52.
#![allow(
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    clippy::cast_possible_wrap
)]

use base64::Engine as _;
use ed25519_dalek::{Signer as _, SigningKey};
use referee_core::{Circle, Device, HintIssued, HintReceipt, MatchConfig, TickInput};
use referee_sim::phone::{device_key, Phone};
use referee_verify::{
    Bundle, BundleCircle, BundleDevice, BundleMatch, BundleReferee, BundleRejected, BundleReveal,
    BundleVerdict,
};
use serde_json::{json, Value};
use std::cmp::Reverse;
use std::collections::{BTreeMap, BinaryHeap, VecDeque};
use tail_protocol::digest::{batch_hash, sha256, verdict_digest};
use tail_protocol::{
    hint_kind, merkle, ring, BatchEnvelope, Fix, HintFact, LogEntry, SignedVerdict, Verdict, VerdictPayload,
};

const NAMES: [&str; 12] = [
    "ana", "bo", "cy", "dee", "eli", "fay", "gus", "hal", "ivy", "jo", "kit", "lu",
];
const ACCOUNT_SUFFIX: &str = ".tail-fixture.testnet";
const APP_ID: &str = "SIMTEAM.dev.tail.sim";
/// Sunday 8 November 2026, 2:00 pm in Boston.
const START_MS: u64 = 1_794_164_400_000;
const DURATION_MS: u64 = 60 * 60_000;
/// 5.00 USDC (6 decimals).
const STAKE: u128 = 5_000_000;
/// Boston Common, as the web fixture draws it.
const ZONE: Circle = Circle {
    lat_e7: 423_550_500,
    lon_e7: -710_656_500,
    radius_m: 360,
};
const PATHS: &str = include_str!("../../../apps/web/scripts/data/common-paths.json");

/// When hunts start (minute of the match): the hunter closes in, shadows, strikes.
const HUNTS_MIN: [u64; 7] = [5, 10, 15, 21, 30, 36, 50];
/// When a phone dies in a pocket (it forfeits once dark long enough).
const DARK_MIN: u64 = 24;
/// When a player walks out of the zone (they forfeit the same way).
const LEAVE_MIN: u64 = 43;
/// Hint waves: `(from, to)` minute and how many hints the players still in buy in it, at random
/// moments. Hint prices follow demand over the last 5 minutes, so each wave lifts the price and
/// it falls back after; the third is a bidding war that reaches the cap.
const WAVES: [(u64, u64, usize); 4] = [(3, 8, 6), (17, 22, 10), (33, 39, 17), (52, 56, 5)];
/// Bluetooth range for the scripted radios.
const BLE_RANGE_M: f64 = 25.0;
/// How long a hunter shadows its target before striking: five 15 s epochs and a bit.
const SHADOW_S: u64 = 85;
const QUESTIONS: [&str; 4] = [
    "Are they close?",
    "Which way?",
    "Am I getting warmer?",
    "Still in the park?",
];

// ── geometry: metres east (x) and north (y) of the zone centre ─────────────────────

#[derive(Clone, Copy, Debug, PartialEq)]
struct P {
    x: f64,
    y: f64,
}

impl P {
    fn dist(self, o: P) -> f64 {
        (self.x - o.x).hypot(self.y - o.y)
    }
    /// One step of at most `d` metres towards `o`.
    fn toward(self, o: P, d: f64) -> P {
        let l = self.dist(o);
        if l <= d {
            return o;
        }
        P {
            x: self.x + (o.x - self.x) * d / l,
            y: self.y + (o.y - self.y) * d / l,
        }
    }
}

struct Plane {
    m_lat: f64,
    m_lon: f64,
}

impl Plane {
    fn new() -> Self {
        let lat0 = f64::from(ZONE.lat_e7) / 1e7;
        Self {
            m_lat: 111_132.954 - 559.822 * (2.0 * lat0).to_radians().cos(),
            m_lon: 111_412.84 * lat0.to_radians().cos(),
        }
    }
    fn p(&self, lon_e7: i64, lat_e7: i64) -> P {
        P {
            x: (lon_e7 - i64::from(ZONE.lon_e7)) as f64 / 1e7 * self.m_lon,
            y: (lat_e7 - i64::from(ZONE.lat_e7)) as f64 / 1e7 * self.m_lat,
        }
    }
    fn e7(&self, p: P) -> (i32, i32) {
        (
            ZONE.lat_e7 + (p.y / self.m_lat * 1e7).round() as i32,
            ZONE.lon_e7 + (p.x / self.m_lon * 1e7).round() as i32,
        )
    }
}

/// The park's walking paths as a graph, cut to its largest connected piece so every route exists.
struct Paths {
    nodes: Vec<P>,
    adj: Vec<Vec<(usize, f64)>>,
    walkable: Vec<usize>,
}

impl Paths {
    fn load(plane: &Plane) -> Self {
        let v: Value = serde_json::from_str(PATHS).expect("common-paths.json parses");
        let mut nodes = Vec::new();
        let mut index = BTreeMap::new();
        let mut adj: Vec<Vec<(usize, f64)>> = Vec::new();
        let mut node = |c: &Value, nodes: &mut Vec<P>, adj: &mut Vec<Vec<(usize, f64)>>| {
            let (lon, lat) = (c[0].as_i64().expect("lonE7"), c[1].as_i64().expect("latE7"));
            *index.entry((lon, lat)).or_insert_with(|| {
                nodes.push(plane.p(lon, lat));
                adj.push(Vec::new());
                nodes.len() - 1
            })
        };
        for way in v["paths"].as_array().expect("paths") {
            let pts = way.as_array().expect("a way");
            for w in pts.windows(2) {
                let a = node(&w[0], &mut nodes, &mut adj);
                let b = node(&w[1], &mut nodes, &mut adj);
                let d = nodes[a].dist(nodes[b]);
                // A way cut at the park edge would otherwise jump across a street.
                if a != b && d <= 60.0 {
                    adj[a].push((b, d));
                    adj[b].push((a, d));
                }
            }
        }
        let mut comp = vec![usize::MAX; nodes.len()];
        let mut best = (0, 0);
        for s in 0..nodes.len() {
            if comp[s] != usize::MAX {
                continue;
            }
            let (mut stack, mut size) = (vec![s], 0);
            comp[s] = s;
            while let Some(u) = stack.pop() {
                size += 1;
                for &(t, _) in &adj[u] {
                    if comp[t] == usize::MAX {
                        comp[t] = s;
                        stack.push(t);
                    }
                }
            }
            if size > best.1 {
                best = (s, size);
            }
        }
        // Nodes well inside the zone, so wandering never drifts out of it by accident.
        let walkable = (0..nodes.len())
            .filter(|&i| comp[i] == best.0 && nodes[i].dist(P { x: 0.0, y: 0.0 }) < 320.0)
            .collect();
        Self { nodes, adj, walkable }
    }

    fn nearest(&self, p: P) -> usize {
        *self
            .walkable
            .iter()
            .min_by(|&&a, &&b| self.nodes[a].dist(p).total_cmp(&self.nodes[b].dist(p)))
            .expect("the park has paths")
    }

    /// Shortest walk along the paths (Dijkstra), as the points to pass.
    fn route(&self, from: usize, to: usize) -> VecDeque<P> {
        let mut d = vec![f64::INFINITY; self.nodes.len()];
        let mut prev = vec![usize::MAX; self.nodes.len()];
        let mut heap = BinaryHeap::new();
        d[from] = 0.0;
        // Millimetres as integers, so the heap can order them.
        heap.push(Reverse((0u64, from)));
        while let Some(Reverse((dm, u))) = heap.pop() {
            if u == to {
                break;
            }
            if dm as f64 / 1000.0 > d[u] {
                continue;
            }
            for &(v, w) in &self.adj[u] {
                if d[u] + w < d[v] {
                    d[v] = d[u] + w;
                    prev[v] = u;
                    heap.push(Reverse(((d[v] * 1000.0) as u64, v)));
                }
            }
        }
        let mut out = VecDeque::new();
        let mut v = to;
        while v != usize::MAX {
            out.push_front(self.nodes[v]);
            v = prev[v];
        }
        out
    }
}

/// xorshift64*: a tiny deterministic PRNG, so the bundle is the same bytes on every run.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
}

// ── walkers ─────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq)]
enum Mode {
    Wander,
    /// Closing in on `target`, then shadowing it from `close_since`; strikes from then on.
    Hunt {
        target: usize,
        close_since: Option<u64>,
        last_strike: Option<u64>,
    },
    /// The phone is off: no fixes, no radio, no batches.
    Dark,
    /// Walking out of the zone, away from its centre.
    Leave,
    Out,
}

struct Walker {
    pos: P,
    speed: f64,
    route: VecDeque<P>,
    pause_until: u64,
    mode: Mode,
}

impl Walker {
    fn wander(&mut self, s: u64, paths: &Paths, rng: &mut Rng) {
        if s < self.pause_until {
            return;
        }
        if self.route.is_empty() {
            if rng.unit() < 0.3 {
                self.pause_until = s + 10 + rng.below(30);
                return;
            }
            let to = paths.walkable[rng.below(paths.walkable.len() as u64) as usize];
            self.route = paths.route(paths.nearest(self.pos), to);
        }
        self.walk(self.speed);
    }

    fn walk(&mut self, mut budget: f64) {
        while budget > 0.0 {
            let Some(&next) = self.route.front() else { break };
            let d = self.pos.dist(next);
            if d <= budget {
                self.pos = next;
                self.route.pop_front();
                budget -= d;
            } else {
                self.pos = self.pos.toward(next, budget);
                budget = 0.0;
            }
        }
    }
}

/// The moments (sim seconds) of the wave starting at `s`, sorted.
fn plan_wave(into: &mut VecDeque<u64>, s: u64, rng: &mut Rng) {
    let &(from, to, count) = WAVES.iter().find(|w| w.0 * 60 == s).expect("a wave starts now");
    let mut at: Vec<u64> = (0..count)
        .map(|_| from * 60 + rng.below((to - from) * 60))
        .collect();
    at.sort_unstable();
    into.extend(at);
}

fn template(f: HintFact) -> String {
    const DIRS: [&str; 8] = [
        "north",
        "north-east",
        "east",
        "south-east",
        "south",
        "south-west",
        "west",
        "north-west",
    ];
    match f.hint {
        hint_kind::NEAR if f.value == 1 => "Close. Within 150 metres.".into(),
        hint_kind::NEAR => "Not close. More than 150 metres off.".into(),
        hint_kind::BEARING => format!("Look {}.", DIRS[usize::from(f.value % 8)]),
        _ => [
            "Colder: they're farther than a minute ago.",
            "Warmer: you're closing.",
            "No change.",
        ][usize::from(f.value.min(2))]
        .into(),
    }
}

fn call_id(n: u32) -> [u8; 16] {
    let mut id: [u8; 16] = sha256(&[b"tail/economy-fixture/call", &n.to_le_bytes()])[..16]
        .try_into()
        .expect("16 bytes");
    // Shaped like a UUID v4, as OutLayer call ids are.
    id[6] = (id[6] & 0x0f) | 0x40;
    id[8] = (id[8] & 0x3f) | 0x80;
    id
}

struct Played {
    accounts: Vec<String>,
    match_id: [u8; 16],
    alpha: String,
    vrf_signature: [u8; 64],
    ring: Vec<String>,
    k_m: [u8; 32],
    referee: SigningKey,
    vrf: SigningKey,
    verdicts: Vec<VerdictPayload>,
    log: Vec<LogEntry>,
    sent: Vec<BatchEnvelope>,
    /// `(sim second, hint)`.
    hints: Vec<(u64, HintIssued)>,
    /// `(sim second, verdict)` for each Tag and Forfeit.
    moves: Vec<(u64, Verdict)>,
    refused: usize,
}

#[allow(clippy::too_many_lines)]
fn play() -> Played {
    let plane = Plane::new();
    let paths = Paths::load(&plane);
    let mut rng = Rng(0x07a1_1ec0_2026_1108);

    let mut accounts: Vec<String> = NAMES.iter().map(|n| format!("{n}{ACCOUNT_SUFFIX}")).collect();
    accounts.sort();
    let match_id: [u8; 16] = sha256(&[b"TAIL replay fixture: Boston Common economy, twelve players"])[..16]
        .try_into()
        .expect("16 bytes");
    let referee = SigningKey::from_bytes(&sha256(&[
        b"TAIL economy fixture referee key. Test only, public, never on NEAR.",
    ]));
    let vrf = SigningKey::from_bytes(&sha256(&[
        b"TAIL economy fixture VRF key. Test only, public, never on NEAR.",
    ]));
    let alpha = format!("vrf:1:tail-fixture.testnet:{}", hex::encode(match_id));
    let vrf_signature = vrf.sign(alpha.as_bytes()).to_bytes();
    let k_m = sha256(&[b"TAIL economy fixture match key"]);
    let ring_accounts = ring::build_ring(&accounts, &vrf_signature);
    let index_of = |a: &str| accounts.iter().position(|x| x == a).expect("a player");
    let n = accounts.len();
    let mut target: Vec<Option<usize>> = vec![None; n];
    for (k, a) in ring_accounts.iter().enumerate() {
        target[index_of(a)] = Some(index_of(&ring_accounts[(k + 1) % n]));
    }

    let cfg = MatchConfig {
        match_id,
        app_id: APP_ID.into(),
        stake: STAKE,
        duration_ms: DURATION_MS,
        zone: ZONE,
        safehouses: Vec::new(),
    };
    let devices = accounts
        .iter()
        .map(|a| Device {
            account_id: a.clone(),
            key: appattest::public_key_bytes(device_key(a).verifying_key()),
            counter: 0,
            attested: true,
        })
        .collect();
    let started = referee_core::init(cfg, devices, &k_m, &vrf_signature, START_MS, call_id(0))
        .expect("the match starts");
    let mut verdicts = started.verdicts;
    let mut log = started.log;
    let mut phones: Vec<Phone> = started
        .keys
        .into_iter()
        .map(|(i, k)| Phone::new(accounts[i as usize].clone(), i, k, APP_ID.into()))
        .collect();
    let mut state = started.state;

    let mut walkers: Vec<Walker> = (0..n)
        .map(|_| {
            let at = paths.walkable[rng.below(paths.walkable.len() as u64) as usize];
            Walker {
                pos: paths.nodes[at],
                speed: 1.1 + 0.4 * rng.unit(),
                route: VecDeque::new(),
                pause_until: rng.below(40),
                mode: Mode::Wander,
            }
        })
        .collect();
    // Hints each player bought about the target they hunt now; the keenest hunter goes first.
    let mut keen = vec![0u32; n];

    let mut wave_hints: VecDeque<u64> = VecDeque::new();
    let mut sent = Vec::new();
    let mut outbox: Vec<BatchEnvelope> = Vec::new();
    let mut receipts: Vec<HintReceipt> = Vec::new();
    let mut hints = Vec::new();
    let mut moves = Vec::new();
    let mut refused = 0;
    let hunted = |walkers: &[Walker], p: usize| {
        walkers
            .iter()
            .any(|w| matches!(w.mode, Mode::Hunt { target, .. } if target == p))
    };
    for s in 1u64.. {
        let t_ms = START_MS + s * 1000;
        let minute = s / 60;
        let on_minute = s.is_multiple_of(60);
        let alive = |w: &Walker| !matches!(w.mode, Mode::Out);

        // The script: hunts, a dead phone, a walk out of the zone.
        if on_minute && HUNTS_MIN.contains(&minute) {
            let pick = (0..n)
                .filter(|&h| {
                    walkers[h].mode == Mode::Wander
                        && target[h].is_some_and(|t| walkers[t].mode == Mode::Wander || hunted(&walkers, t))
                })
                .filter(|&h| target[h].is_some_and(|t| !matches!(walkers[t].mode, Mode::Dark | Mode::Leave)))
                .max_by_key(|&h| (keen[h], Reverse(h)));
            if let Some(h) = pick {
                walkers[h].mode = Mode::Hunt {
                    target: target[h].expect("checked"),
                    close_since: None,
                    last_strike: None,
                };
            }
        }
        if on_minute && (minute == DARK_MIN || minute == LEAVE_MIN) {
            let calm = (0..n)
                .filter(|&p| walkers[p].mode == Mode::Wander && !hunted(&walkers, p))
                .min_by_key(|&p| keen[p]);
            if let Some(p) = calm {
                walkers[p].mode = if minute == DARK_MIN {
                    Mode::Dark
                } else {
                    Mode::Leave
                };
            }
        }

        // Everyone moves.
        let positions: Vec<P> = walkers.iter().map(|w| w.pos).collect();
        for (i, w) in walkers.iter_mut().enumerate() {
            match w.mode {
                Mode::Wander => w.wander(s, &paths, &mut rng),
                Mode::Hunt {
                    target: t,
                    close_since,
                    last_strike,
                } => {
                    let tp = positions[t];
                    if w.pos.dist(tp) > 8.0 {
                        w.pos = w.pos.toward(tp, 2.2);
                    } else {
                        // Shadow a few metres behind and to the side.
                        w.pos = P {
                            x: tp.x + 3.0,
                            y: tp.y - 3.0,
                        };
                        let since = close_since.unwrap_or(s);
                        let strike = s >= since + SHADOW_S && last_strike.is_none_or(|l| s >= l + 20);
                        if strike {
                            phones[i].strike();
                        }
                        w.mode = Mode::Hunt {
                            target: t,
                            close_since: Some(since),
                            last_strike: if strike { Some(s) } else { last_strike },
                        };
                    }
                }
                Mode::Leave => {
                    let c = P { x: 0.0, y: 0.0 };
                    let far = if w.pos.dist(c) < 1.0 {
                        P { x: 600.0, y: 0.0 }
                    } else {
                        P {
                            x: w.pos.x * 600.0 / w.pos.dist(c),
                            y: w.pos.y * 600.0 / w.pos.dist(c),
                        }
                    };
                    w.pos = w.pos.toward(far, 1.4);
                }
                Mode::Dark | Mode::Out => {}
            }
        }

        // Phones that are on: a fix every 2 s, radios every second, hints in waves, a batch every 5 s.
        let on: Vec<usize> = (0..n)
            .filter(|&i| alive(&walkers[i]) && walkers[i].mode != Mode::Dark)
            .collect();
        if s.is_multiple_of(2) {
            for &i in &on {
                let (lat_e7, lon_e7) = plane.e7(walkers[i].pos);
                phones[i].fix(Fix {
                    t_ms,
                    lat_e7,
                    lon_e7,
                    acc_m: 5,
                    speed_cmps: (walkers[i].speed * 100.0) as u16,
                    flags: 0,
                });
            }
        }
        for &h in &on {
            for &o in &on {
                let d = walkers[h].pos.dist(walkers[o].pos);
                if h != o && d <= BLE_RANGE_M {
                    let tok = phones[o].token(t_ms).expect("inside the match");
                    phones[h].hear(t_ms, tok, (-50.0 - d).round() as i8);
                }
            }
        }
        // A wave's hints go to random players still in; a hunter on the approach asks once too.
        for &(from, _, _) in &WAVES {
            if s == from * 60 {
                plan_wave(&mut wave_hints, s, &mut rng);
            }
        }
        let mut askers: Vec<usize> = Vec::new();
        while wave_hints.front().is_some_and(|&t| t <= s) {
            wave_hints.pop_front();
            let free: Vec<usize> = on
                .iter()
                .copied()
                .filter(|&i| walkers[i].mode != Mode::Leave)
                .collect();
            if !free.is_empty() {
                askers.push(free[rng.below(free.len() as u64) as usize]);
            }
        }
        for &i in &on {
            if let Mode::Hunt {
                close_since: None, ..
            } = walkers[i].mode
            {
                if rng.below(90) == 0 {
                    askers.push(i);
                }
            }
        }
        for i in askers {
            let kind = [
                hint_kind::NEAR,
                hint_kind::NEAR,
                hint_kind::TREND,
                hint_kind::BEARING,
            ][rng.below(4) as usize];
            let text = (rng.unit() < 0.3).then(|| QUESTIONS[rng.below(4) as usize].to_owned());
            phones[i].hint(kind, text);
        }
        if s.is_multiple_of(5) {
            for &i in &on {
                outbox.push(phones[i].batch(t_ms));
            }
        }
        if !s.is_multiple_of(10) {
            continue;
        }

        let tick_no = (s / 10) as u32;
        let batches = std::mem::take(&mut outbox);
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
        .expect("the tick runs");
        log.extend(out.log);
        refused += out.refused.len();
        // Template lines: the receipt commits to the words, and no model signed them.
        receipts = out
            .hints
            .iter()
            .map(|h| HintReceipt {
                hint_id: h.hint_id,
                chat_id: String::new(),
                text_hash: sha256(&[template(h.fact).as_bytes()]),
                signature: Vec::new(),
                signing_address: String::new(),
            })
            .collect();
        for h in &out.hints {
            if target[usize::from(h.from)] == Some(usize::from(h.to)) {
                keen[usize::from(h.from)] += 1;
            }
        }
        hints.extend(out.hints.into_iter().map(|h| (s, h)));
        for v in &out.verdicts {
            let (loser, winner) = match v.body {
                Verdict::Tag { hunter, target, .. } => (target, hunter),
                Verdict::Forfeit { player, to, .. } => (player, to),
                _ => continue,
            };
            moves.push((s, v.body.clone()));
            let (l, w) = (usize::from(loser), usize::from(winner));
            walkers[l].mode = Mode::Out;
            target[w] = target[l].filter(|&x| x != w);
            target[l] = None;
            keen[w] = 0;
            if matches!(walkers[w].mode, Mode::Hunt { .. }) {
                walkers[w].mode = Mode::Wander;
                walkers[w].route.clear();
            }
            // Whoever was closing on the loser lost their quarry too.
            for x in &mut walkers {
                if matches!(x.mode, Mode::Hunt { target, .. } if target == l) {
                    x.mode = Mode::Wander;
                    x.route.clear();
                }
            }
        }
        verdicts.extend(out.verdicts);
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
                std::mem::take(&mut receipts),
            )
            .expect("the match ends");
            log.extend(fin.log);
            verdicts.extend(fin.verdicts);
            break;
        }
    }
    Played {
        accounts,
        match_id,
        alpha,
        vrf_signature,
        ring: ring_accounts,
        k_m,
        referee,
        vrf,
        verdicts,
        log,
        sent,
        hints,
        moves,
        refused,
    }
}

fn b64(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}

fn sign(p: &Played, v: &VerdictPayload) -> String {
    let signed = SignedVerdict {
        match_id: v.match_id,
        seq: v.seq,
        prev: v.prev,
        call_id: v.call_id,
        body: v.body.clone(),
        sig: p.referee.sign(&verdict_digest(v)).to_bytes(),
    };
    b64(&borsh::to_vec(&signed).expect("borsh"))
}

/// The bundle as the relay builds it (`Matches.declassifyTrails`): each accepted batch once in
/// `batches` with its assertion, each refused envelope in `rejected`, plus the fields only the web
/// replay reads (contract, token, Handler lines, transaction hashes).
fn bundle(p: &Played) -> Value {
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
    let (mut batches, mut assertions, mut rejected) = (Vec::new(), Vec::new(), Vec::new());
    let (mut trailed, mut envelopes) = (Vec::new(), Vec::new());
    for e in &p.sent {
        let h = batch_hash(&e.batch);
        let envelope = (h, e.assertion.clone());
        if envelopes.contains(&envelope) {
            continue;
        }
        let raw = b64(&borsh::to_vec(&e.batch).expect("borsh"));
        if accepted.contains(&h) && !trailed.contains(&h) {
            trailed.push(h);
            envelopes.push(envelope);
            batches.push(raw);
            assertions.push(Some(b64(&e.assertion)));
        } else if refused.contains(&h) {
            envelopes.push(envelope);
            rejected.push(BundleRejected {
                batch: raw,
                assertion: b64(&e.assertion),
            });
        }
    }
    let b = Bundle {
        version: 2,
        game: BundleMatch {
            id: hex::encode(p.match_id),
            stake: STAKE.to_string(),
            start_ms: START_MS,
            end_ms: START_MS + DURATION_MS,
            zone: BundleCircle {
                lat_e7: ZONE.lat_e7,
                lon_e7: ZONE.lon_e7,
                radius_m: ZONE.radius_m,
            },
            safehouses: Vec::new(),
            players: p.accounts.clone(),
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
        log: p
            .log
            .iter()
            .map(|e| b64(&borsh::to_vec(e).expect("borsh")))
            .collect(),
        batches,
        assertions: Some(assertions),
        rejected: Some(rejected),
        reveal: BundleReveal {
            vrf_alpha: p.alpha.clone(),
            vrf_signature: hex::encode(p.vrf_signature),
            k_m: hex::encode(p.k_m),
        },
        devices: p
            .accounts
            .iter()
            .map(|a| BundleDevice {
                account_id: a.clone(),
                app_attest_pk: Some(hex::encode(appattest::public_key_bytes(
                    device_key(a).verifying_key(),
                ))),
                counter: None,
            })
            .collect(),
    };
    let mut v = serde_json::to_value(&b).expect("a bundle serialises");
    add_web_fields(&mut v, p);
    v
}

/// What only the web replay reads, which the relay adds to the referee's release: the contract
/// and token, the ring as the relay copied it, transaction hashes (none: never on NEAR), device
/// kinds and the Handler lines.
fn add_web_fields(v: &mut Value, p: &Played) {
    let m = &mut v["match"];
    m["contract"] = json!("tail.tail-dev-a38d13.testnet");
    m["network"] = json!("testnet");
    m["token"] = json!("usdc.fakes.testnet");
    m["publicReplay"] = json!(true);
    v["referee"]["project"] = json!("tail-fixture/referee");
    v["referee"]["api"] = json!("https://testnet-api.outlayer.ai");
    v["reveal"]["ring"] = json!(p.ring);
    for x in v["verdicts"].as_array_mut().expect("verdicts") {
        x["txHash"] = Value::Null;
    }
    for d in v["devices"].as_array_mut().expect("devices") {
        d["kind"] = json!("phone");
        d["attested"] = json!(true);
    }
    // Template lines: nothing was signed, so there is no signed text.
    v["handler"] = p
        .hints
        .iter()
        .map(|(_, h)| json!({ "hintId": h.hint_id, "signedText": null }))
        .collect();
}

fn summary(p: &Played) -> Vec<String> {
    let short = |i: u16| {
        p.accounts[usize::from(i)]
            .split('.')
            .next()
            .unwrap_or_default()
            .to_owned()
    };
    let usdc = |x: u128| format!("{:.2}", x as f64 / 1e6);
    let mut lines = vec![format!(
        "ring: {}",
        p.ring
            .iter()
            .map(|a| a.split('.').next().unwrap_or_default())
            .collect::<Vec<_>>()
            .join(" → ")
    )];
    for (s, v) in &p.moves {
        let line = match v {
            Verdict::Tag {
                hunter,
                target,
                credit,
            } => {
                format!(
                    "Tag {} → {}, credit {}",
                    short(*hunter),
                    short(*target),
                    usdc(*credit)
                )
            }
            Verdict::Forfeit { player, to, credit } => {
                format!(
                    "Forfeit {} → {}, credit {}",
                    short(*player),
                    short(*to),
                    usdc(*credit)
                )
            }
            _ => continue,
        };
        lines.push(format!("{:>2}:{:02}  {line}", s / 60, s % 60));
    }
    let mut per5 = [0u32; 12];
    for (s, _) in &p.hints {
        per5[(*s / 300).min(11) as usize] += 1;
    }
    lines.push(format!("hints per 5 min: {per5:?}"));
    lines.push(format!(
        "verdicts {}, hints {}, refused actions {}, log {}, batches {}",
        p.verdicts.len(),
        p.hints.len(),
        p.refused,
        p.log.len(),
        p.sent.len()
    ));
    lines
}

fn main() {
    let p = play();
    if std::env::args().any(|a| a == "--summary") {
        for l in summary(&p) {
            println!("{l}");
        }
        return;
    }
    println!(
        "{}",
        serde_json::to_string(&bundle(&p)).expect("a bundle serialises")
    );
}
