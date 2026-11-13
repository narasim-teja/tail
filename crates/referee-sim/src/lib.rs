//! Runs scripted TAIL matches through `referee-core` with simulated phones.
//!
//! The loop advances one second at a time: phones take fixes and scan, every `BATCH_MS` they
//! send a real batch (tokens, borsh, hash chain, P-256 App Attest assertion), and every
//! `TICK_MS` the referee ticks. Between ticks the state goes through borsh exactly as the relay
//! round-trips it sealed. After every call the simulator checks the invariants: the sum of
//! heads never changes; verdict seqs are contiguous and each verdict's `prev` is the digest of
//! the one before; every Checkpoint / End root is the RFC 6962 root of the log so far and comes
//! with a consistency proof from the previous anchor that verifies and equals the full-log
//! proof; every tick's log starts with its `Tick`; every refused batch has a `Rejected` entry
//! with its hash and code; every Tag follows an `Evidence` entry whose epochs justify the lock;
//! every HUD names the log as it stands after its tick; and the verdicts, applied the way the
//! contract applies them, pass the contract's End replay (`settle::replay`) and pay out exactly
//! the heads the referee holds.
// Sim positions are metres and seconds; their f64 conversions are well inside 2^52.
#![allow(
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    clippy::cast_possible_wrap
)]

pub mod phone;
pub mod scenario;

use phone::{device_key, Phone};
use referee_core::{
    Circle, ConsistencyProof, Device, HintIssued, HintReceipt, MatchConfig, Refusal, Rejection, State,
    TickInput,
};
use scenario::{BotMode, Dir, Event, Expect, Scenario};
use std::collections::BTreeMap;
use std::f64::consts::PI;
use std::time::Instant;
use tail_protocol::digest::{batch_hash, sha256, verdict_digest};
use tail_protocol::settle::{self, PlayEvent};
use tail_protocol::{
    constants::hint_kind, hint_price, merkle, recent_hints, ring, target_status, CallId, Fix, Hash, Hud,
    LogEntry, Verdict, VerdictPayload, LOCK_EPOCHS, WINDOW_EPOCHS,
};

/// Sim matches start at a fixed instant so runs are reproducible.
pub const START_MS: u64 = 1_800_000_000_000;
pub const APP_ID: &str = "SIMTEAM.dev.tail.sim";

const M_PER_DEG: f64 = 6_371_008.8 * PI / 180.0;
const BOT_SPEED_MPS: f64 = 1.4;
const BPS_F: f64 = 10_000.0;

/// Everything a run produced, timestamped in sim seconds.
#[derive(Debug, Default)]
pub struct Report {
    pub name: String,
    /// Player names by referee index (sorted account ids).
    pub names: Vec<String>,
    pub vrf_signature: Vec<u8>,
    /// `(t_s, tick_no, verdict)`.
    pub verdicts: Vec<(u64, u32, VerdictPayload)>,
    pub rejections: Vec<(u64, Rejection)>,
    pub refusals: Vec<(u64, Refusal)>,
    pub hints: Vec<(u64, HintIssued)>,
    pub huds: Vec<(u64, u16, Hud)>,
    pub log: Vec<LogEntry>,
    pub final_heads: Vec<u128>,
    pub batches_sent: usize,
    /// Borsh size of the state after each tick.
    pub state_bytes: Vec<usize>,
    /// Wall time of `tick` itself, microseconds.
    pub tick_us: Vec<u128>,
    /// Wall time of the borsh round trip of the state, microseconds.
    pub roundtrip_us: Vec<u128>,
}

impl Report {
    pub fn index(&self, name: &str) -> Option<u16> {
        self.names.iter().position(|n| n == name).map(|i| i as u16)
    }

    pub fn name(&self, i: u16) -> &str {
        &self.names[i as usize]
    }

    /// `Start`, `Hint alice 20000` (the asker and the price: the verdict names nobody else),
    /// `Tag alice bob`, `Forfeit bob alice`, each with ` +credit` when it credits hint money,
    /// `Checkpoint`, and `End` followed by whom each hint was about, in hint order.
    pub fn verdict_text(&self, v: &Verdict) -> String {
        let credited = |credit: u128| {
            if credit == 0 {
                String::new()
            } else {
                format!(" +{credit}")
            }
        };
        match v {
            Verdict::Start { .. } => "Start".into(),
            Verdict::Hint { from, amount, .. } => format!("Hint {} {amount}", self.name(*from)),
            Verdict::Tag {
                hunter,
                target,
                credit,
            } => format!(
                "Tag {} {}{}",
                self.name(*hunter),
                self.name(*target),
                credited(*credit)
            ),
            Verdict::Forfeit { player, to, credit } => format!(
                "Forfeit {} {}{}",
                self.name(*player),
                self.name(*to),
                credited(*credit)
            ),
            Verdict::Checkpoint { .. } => "Checkpoint".into(),
            Verdict::End { hint_targets, .. } => std::iter::once("End")
                .chain(hint_targets.iter().map(|&t| self.name(t)))
                .collect::<Vec<_>>()
                .join(" "),
        }
    }

    pub fn verdict_texts(&self, checkpoints: bool) -> Vec<String> {
        self.verdicts
            .iter()
            .filter(|(_, _, v)| checkpoints || !matches!(v.body, Verdict::Checkpoint { .. }))
            .map(|(_, _, v)| self.verdict_text(&v.body))
            .collect()
    }

    pub fn hud(&self, t: u64, player: &str) -> Option<&Hud> {
        let i = self.index(player)?;
        self.huds
            .iter()
            .find(|(ts, p, _)| *ts == t && *p == i)
            .map(|(_, _, h)| h)
    }

    pub fn head(&self, player: &str) -> u128 {
        self.final_heads[self.index(player).expect("known player") as usize]
    }
}

/// The variant name of a Debug-printed enum value (`Teleport { cmps: 1 }` → `Teleport`).
pub fn variant<T: std::fmt::Debug>(v: &T) -> String {
    let s = format!("{v:?}");
    s.split([' ', '(', '{']).next().unwrap_or_default().to_owned()
}

struct Geo {
    lat0_e7: i32,
    lon0_e7: i32,
    m_per_e7_lat: f64,
    m_per_e7_lon: f64,
}

impl Geo {
    fn new(lat: f64, lon: f64) -> Self {
        Self {
            lat0_e7: (lat * 1e7).round() as i32,
            lon0_e7: (lon * 1e7).round() as i32,
            m_per_e7_lat: M_PER_DEG / 1e7,
            m_per_e7_lon: M_PER_DEG / 1e7 * (lat * PI / 180.0).cos(),
        }
    }
    fn e7(&self, x: f64, y: f64) -> (i32, i32) {
        (
            self.lat0_e7 + (y / self.m_per_e7_lat).round() as i32,
            self.lon0_e7 + (x / self.m_per_e7_lon).round() as i32,
        )
    }
}

/// xorshift64*: a tiny deterministic PRNG for the bots.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
}

fn path_at(path: &[[f64; 3]], t: f64) -> ((f64, f64), f64) {
    let Some(first) = path.first() else {
        return ((0.0, 0.0), 0.0);
    };
    if t <= first[0] {
        return ((first[1], first[2]), 0.0);
    }
    for w in path.windows(2) {
        let (a, b) = (w[0], w[1]);
        if t <= b[0] {
            let span = (b[0] - a[0]).max(1e-9);
            let f = (t - a[0]) / span;
            let speed = (b[1] - a[1]).hypot(b[2] - a[2]) / span;
            return ((a[1] + f * (b[1] - a[1]), a[2] + f * (b[2] - a[2])), speed);
        }
    }
    let last = path.last().expect("non-empty");
    ((last[1], last[2]), 0.0)
}

fn match_id(name: &str) -> [u8; 16] {
    sha256(&[b"tail/sim/match", name.as_bytes()])[..16]
        .try_into()
        .expect("16 bytes")
}

fn vrf_candidate(name: &str, i: u32) -> [u8; 64] {
    let a = sha256(&[b"tail/sim/vrf/a", name.as_bytes(), &i.to_le_bytes()]);
    let b = sha256(&[b"tail/sim/vrf/b", name.as_bytes(), &i.to_le_bytes()]);
    let mut sig = [0u8; 64];
    sig[..32].copy_from_slice(&a);
    sig[32..].copy_from_slice(&b);
    sig
}

fn same_cycle(a: &[String], b: &[String]) -> bool {
    a.len() == b.len()
        && b.iter()
            .position(|x| x == &a[0])
            .is_some_and(|k| (0..a.len()).all(|i| a[i] == b[(k + i) % b.len()]))
}

/// A VRF signature whose ring is `want` (as a cycle). The real one comes from OutLayer.
fn vrf_for(name: &str, accounts: &[String], want: Option<&[String]>) -> Result<[u8; 64], String> {
    for i in 0..200_000 {
        let sig = vrf_candidate(name, i);
        if want.is_none_or(|w| same_cycle(w, &ring::build_ring(accounts, &sig))) {
            return Ok(sig);
        }
    }
    Err(format!("no VRF signature gives ring {want:?}"))
}

fn hint_code(kind: &str) -> Result<u8, String> {
    match kind {
        "near" => Ok(hint_kind::NEAR),
        "bearing" => Ok(hint_kind::BEARING),
        "trend" => Ok(hint_kind::TREND),
        other => other.parse().map_err(|_| format!("unknown hint kind {other}")),
    }
}

struct Sim<'a> {
    sc: &'a Scenario,
    geo: Geo,
    phones: Vec<Phone>,
    /// Scenario player spec index per referee index.
    spec: Vec<usize>,
    pos: Vec<(f64, f64)>,
    speed: Vec<f64>,
    rng: Rng,
    report: Report,
    leaves: Vec<Hash>,
    next_seq: u32,
    /// Digest of the last verdict (the next one's `prev`).
    last_digest: Hash,
    /// `(log_size, root)` of the last Checkpoint, as the contract holds it.
    anchored: (u64, Hash),
    /// Tags each player has made, by referee index.
    tags: Vec<u8>,
    /// The match as the contract holds it: heads, hint pool and play events, applied verdict by
    /// verdict, and the heads its End credits.
    chain: Chain,
    /// `derive_log_key(K_m)`, to check every salt as a verifier does after declassify.
    k_log: Hash,
}

/// The contract's money rules, verdict by verdict (`contracts/tail`): a Hint is charged at the
/// price its time and the match's earlier hints set (`pricing`) and pays into the pool, a Tag or
/// Forfeit credits the loser from it and moves the loser's head, and End replays the match and
/// credits each survivor what they are owed.
struct Chain {
    stake: u128,
    /// `(start_ms, end_ms)` from Start.
    span: Option<(u64, u64)>,
    heads: Vec<u128>,
    pool: u128,
    events: Vec<PlayEvent>,
}

impl Chain {
    fn hint_times(&self) -> Vec<u64> {
        self.events.iter().filter_map(PlayEvent::hint_t_ms).collect()
    }

    /// `(recent, price per kind)` for a hint charged at `now_ms` (clamped to `end_ms`, as the
    /// referee charges in a tick that runs past it).
    fn board(&self, now_ms: u64) -> Result<(u32, [u128; 3]), String> {
        let (_, end_ms) = self.span.ok_or("a HUD before Start")?;
        let recent = recent_hints(&self.hint_times(), now_ms.min(end_ms));
        let prices = std::array::from_fn(|k| hint_price(self.stake, k as u8, recent).expect("known kind"));
        Ok((recent, prices))
    }

    fn apply(&mut self, v: &Verdict, ring: impl FnOnce() -> Vec<u16>) -> Result<(), String> {
        match *v {
            Verdict::Start { start_ms, end_ms, .. } => self.span = Some((start_ms, end_ms)),
            Verdict::Hint {
                from,
                amount,
                hint,
                t_ms,
                ..
            } => {
                let (start_ms, end_ms) = self.span.ok_or("a hint before Start")?;
                let earlier = self.hint_times();
                if t_ms < start_ms || t_ms > end_ms || earlier.last().is_some_and(|&last| t_ms < last) {
                    return Err(format!(
                        "hint t_ms {t_ms} is outside the match or before an earlier hint"
                    ));
                }
                let price = hint_price(self.stake, hint, recent_hints(&earlier, t_ms));
                if price != Some(amount) {
                    return Err(format!("hint amount {amount} is not its price {price:?}"));
                }
                let head = &mut self.heads[usize::from(from)];
                *head = head
                    .checked_sub(amount)
                    .ok_or("a hint costs more than the head")?;
                self.pool += amount;
                self.events.push(PlayEvent::Hint { from, amount, t_ms });
            }
            Verdict::Tag {
                hunter: w,
                target: l,
                credit,
            }
            | Verdict::Forfeit {
                player: l,
                to: w,
                credit,
            } => {
                self.pool = self.pool.checked_sub(credit).ok_or("a credit beyond the pool")?;
                let head = std::mem::take(&mut self.heads[usize::from(l)]) + credit;
                self.heads[usize::from(w)] += head;
                self.events.push(match *v {
                    Verdict::Tag { .. } => PlayEvent::Tag {
                        hunter: w,
                        target: l,
                        credit,
                    },
                    _ => PlayEvent::Forfeit {
                        player: l,
                        to: w,
                        credit,
                    },
                });
            }
            Verdict::End { ref hint_targets, .. } => {
                let owed = settle::replay(&ring(), &self.events, hint_targets, self.pool)
                    .map_err(|v| format!("the contract would refund the match: {}", v.describe()))?;
                for (h, o) in self.heads.iter_mut().zip(owed) {
                    *h += o;
                }
                self.pool = 0;
            }
            Verdict::Checkpoint { .. } => {}
        }
        Ok(())
    }
}

/// Which call produced a batch of verdicts and log entries.
#[derive(Clone, Copy)]
enum Call {
    Start,
    Tick {
        tick_no: u32,
        now_ms: u64,
        call_id: CallId,
    },
    /// `finish`, reported under the tick number after the last tick.
    End {
        tick_no: u32,
    },
}

/// Runs a scenario to its end and checks the invariants after every tick.
pub fn run(sc: &Scenario) -> Result<Report, String> {
    run_seeded(sc, 1)
}

pub fn run_seeded(sc: &Scenario, seed: u64) -> Result<Report, String> {
    let mut names: Vec<String> = sc.players.iter().map(|p| p.name.clone()).collect();
    names.sort();
    let vrf = vrf_for(&sc.name, &names, sc.ring.as_deref())?;
    let cfg = MatchConfig {
        match_id: match_id(&sc.name),
        app_id: APP_ID.into(),
        stake: u128::from(sc.stake),
        duration_ms: sc.duration_s * 1000,
        zone: Circle {
            lat_e7: (sc.zone.lat * 1e7).round() as i32,
            lon_e7: (sc.zone.lon * 1e7).round() as i32,
            radius_m: sc.zone.radius_m,
        },
        safehouses: Vec::new(),
    };
    let geo = Geo::new(sc.zone.lat, sc.zone.lon);
    let cfg = MatchConfig {
        safehouses: sc
            .safehouses
            .iter()
            .map(|s| {
                let (lat_e7, lon_e7) = geo.e7(s.x, s.y);
                Circle {
                    lat_e7,
                    lon_e7,
                    radius_m: s.radius_m,
                }
            })
            .collect(),
        ..cfg
    };
    let devices = sc
        .players
        .iter()
        .map(|p| Device {
            account_id: p.name.clone(),
            key: appattest::public_key_bytes(device_key(&p.name).verifying_key()),
            counter: 0,
            attested: true,
        })
        .collect();
    let k_m = sha256(&[b"tail/sim/k_m", sc.name.as_bytes()]);
    let started =
        referee_core::init(cfg, devices, &k_m, &vrf, START_MS, [0; 16]).map_err(|e| format!("{e:?}"))?;

    let spec: Vec<usize> = names
        .iter()
        .map(|n| sc.players.iter().position(|p| &p.name == n).expect("same names"))
        .collect();
    let phones = started
        .keys
        .iter()
        .map(|(i, k)| {
            let s = &sc.players[spec[*i as usize]];
            let mut ph = Phone::new(names[*i as usize].clone(), *i, k.clone(), APP_ID.into());
            ph.clock_offset_ms = s.clock_offset_ms;
            ph.batch_phase_s = s.batch_phase_s;
            ph
        })
        .collect();
    let n = names.len();
    let mut sim = Sim {
        sc,
        geo,
        phones,
        spec,
        pos: vec![(0.0, 0.0); n],
        speed: vec![0.0; n],
        rng: Rng(seed | 1),
        report: Report {
            name: sc.name.clone(),
            names,
            vrf_signature: vrf.to_vec(),
            ..Report::default()
        },
        leaves: Vec::new(),
        next_seq: 1,
        last_digest: [0; 32],
        anchored: (0, merkle::empty_root()),
        tags: vec![0; n],
        chain: Chain {
            stake: u128::from(sc.stake),
            span: None,
            heads: vec![u128::from(sc.stake); n],
            pool: 0,
            events: Vec::new(),
        },
        k_log: tail_protocol::beacon::derive_log_key(&k_m),
    };
    sim.check_enrolled(&started.log)?;
    sim.record(0, Call::Start, &started.verdicts, &[], &started.log)?;
    sim.run(started.state, &vrf)?;
    Ok(sim.report)
}

impl Sim<'_> {
    fn idx(&self, name: &str) -> Result<usize, String> {
        self.report
            .index(name)
            .map(usize::from)
            .ok_or_else(|| format!("unknown player {name}"))
    }

    fn dark(&self, i: usize, s: u64) -> bool {
        let name = &self.report.names[i];
        self.sc.events.iter().any(
            |e| matches!(e, Event::Dark { player, from, to } if player == name && (*from..*to).contains(&s)),
        )
    }

    fn active(&self, i: usize, s: u64) -> bool {
        !self.phones[i].out() && !self.dark(i, s)
    }

    fn held(&self, i: usize, s: u64) -> bool {
        let name = &self.report.names[i];
        self.sc.events.iter().any(
            |e| matches!(e, Event::Hold { player, from, to } if player == name && (*from..*to).contains(&s)),
        )
    }

    fn copies(&self, i: usize, s: u64) -> u8 {
        let name = &self.report.names[i];
        self.sc
            .events
            .iter()
            .find_map(|e| match e {
                Event::Copies {
                    player,
                    from,
                    to,
                    copies,
                } if player == name && (*from..*to).contains(&s) => Some(*copies),
                _ => None,
            })
            .unwrap_or(1)
    }

    /// Clock changes that take effect at second `s`.
    fn set_clocks(&mut self, s: u64) {
        for e in &self.sc.events {
            if let Event::Clock { player, t, offset_ms } = e {
                if *t == s {
                    if let Some(i) = self.report.index(player) {
                        self.phones[i as usize].clock_offset_ms = *offset_ms;
                    }
                }
            }
        }
    }

    fn flags(&self, i: usize, s: u64) -> u8 {
        let name = &self.report.names[i];
        self.sc.events.iter().fold(0, |acc, e| match e {
            Event::Flags {
                player,
                from,
                to,
                flags,
            } if player == name && (*from..*to).contains(&s) => acc | flags,
            _ => acc,
        })
    }

    /// Explicit windows first; else the auto range. Returns the RSSI `h` hears `o` at.
    fn audible(&self, h: usize, o: usize, s: u64) -> Option<i8> {
        let (hn, on) = (&self.report.names[h], &self.report.names[o]);
        for r in &self.sc.radio {
            if !(r.from..r.to).contains(&s) {
                continue;
            }
            let hears = match r.dir {
                Dir::Both => (&r.a == hn && &r.b == on) || (&r.a == on && &r.b == hn),
                Dir::AHearsB => &r.a == hn && &r.b == on,
                Dir::BHearsA => &r.b == hn && &r.a == on,
            };
            if hears {
                return Some(r.rssi);
            }
        }
        let range = self.sc.radio_auto_m?;
        let d = (self.pos[h].0 - self.pos[o].0).hypot(self.pos[h].1 - self.pos[o].1);
        (d <= range).then(|| (-50.0 - d).round() as i8)
    }

    fn move_players(&mut self, s: u64) {
        for i in 0..self.phones.len() {
            let spec = &self.sc.players[self.spec[i]];
            if spec.bot && s == 1 {
                // Bots start scattered across the zone (or a few metres apart in a clump).
                let spread = if self.sc.bots == BotMode::Clump {
                    5.0
                } else {
                    f64::from(self.sc.zone.radius_m) * 0.8
                };
                let r = spread * self.rng.unit().sqrt();
                let angle = self.rng.unit() * 2.0 * PI;
                self.pos[i] = (r * angle.cos(), r * angle.sin());
            } else if spec.bot && self.sc.bots != BotMode::Clump {
                self.bot_step(i);
            } else {
                let (p, v) = path_at(&spec.path, s as f64);
                self.pos[i] = p;
                self.speed[i] = v;
            }
        }
    }

    /// Bots walk toward their target (with the simulator's god view) part of the time and
    /// wander otherwise, staying inside the zone.
    fn bot_step(&mut self, me: usize) {
        if self.phones[me].out() {
            self.speed[me] = 0.0;
            return;
        }
        let target = self.phones[me]
            .last_hud
            .as_ref()
            .map_or(self.phones[me].keys.target.clone(), |h| h.target.clone());
        let target_pos = self.report.index(&target).map(|t| self.pos[t as usize]);
        let here = self.pos[me];
        let chase = self.rng.unit() < 0.35;
        let dir = match target_pos {
            Some(there) if chase => {
                let gap = (there.0 - here.0).hypot(there.1 - here.1);
                if gap < 6.0 {
                    (0.0, 0.0)
                } else {
                    ((there.0 - here.0) / gap, (there.1 - here.1) / gap)
                }
            }
            _ => {
                let angle = self.rng.unit() * 2.0 * PI;
                (angle.cos(), angle.sin())
            }
        };
        let limit = f64::from(self.sc.zone.radius_m) * 0.8;
        let mut next = (here.0 + dir.0 * BOT_SPEED_MPS, here.1 + dir.1 * BOT_SPEED_MPS);
        let from_centre = next.0.hypot(next.1);
        if from_centre > limit {
            next = (next.0 * limit / from_centre, next.1 * limit / from_centre);
        }
        self.speed[me] = (next.0 - here.0).hypot(next.1 - here.1);
        self.pos[me] = next;
    }

    fn sense(&mut self, s: u64, t_ms: u64) {
        let n = self.phones.len();
        for i in 0..n {
            if !self.active(i, s) {
                continue;
            }
            let (lat_e7, lon_e7) = self.geo.e7(self.pos[i].0, self.pos[i].1);
            let acc_m = self.sc.players[self.spec[i]].acc_m;
            let fix = Fix {
                t_ms: self.phones[i].device_ms(t_ms),
                lat_e7,
                lon_e7,
                acc_m,
                speed_cmps: (self.speed[i] * 100.0).round().min(f64::from(u16::MAX)) as u16,
                flags: self.flags(i, s),
            };
            self.phones[i].fix(fix);
        }
        for h in 0..n {
            for o in 0..n {
                if h == o || !self.active(h, s) || !self.active(o, s) {
                    continue;
                }
                if let (Some(rssi), Some(tok)) = (self.audible(h, o, s), self.phones[o].token(t_ms)) {
                    self.phones[h].hear(t_ms, tok, rssi);
                }
            }
        }
    }

    fn scripted_actions(&mut self, s: u64, t_ms: u64) -> Result<(), String> {
        for e in &self.sc.events {
            match e {
                Event::Strike { t, player } if *t == s => {
                    let i = self.idx(player)?;
                    if self.active(i, s) {
                        self.phones[i].strike();
                    }
                }
                Event::Hint {
                    t,
                    player,
                    kind,
                    text,
                    every,
                    count,
                } if s >= *t && (0..*count).any(|k| *t + u64::from(k) * every == s) => {
                    let i = self.idx(player)?;
                    if self.active(i, s) {
                        self.phones[i].hint(hint_code(kind)?, text.clone());
                    }
                }
                Event::Inject {
                    hearer,
                    of,
                    from,
                    to,
                    epoch_offset,
                    rssi,
                } if (*from..*to).contains(&s) => {
                    let (h, o) = (self.idx(hearer)?, self.idx(of)?);
                    if self.active(h, s) {
                        let now_e = tail_protocol::beacon::epoch_at(self.phones[o].device_ms(t_ms), START_MS)
                            .ok_or("inject before start")?;
                        let e =
                            u32::try_from(i64::from(now_e) + epoch_offset).map_err(|_| "inject epoch < 0")?;
                        let tok = self.phones[o].token_at_epoch(e);
                        self.phones[h].hear_unfiltered(t_ms, tok, *rssi);
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }

    /// Bots strike whenever their last HUD showed a full lock, and now and then buy a hint.
    fn bot_actions(&mut self, s: u64) {
        for i in 0..self.phones.len() {
            if !self.sc.players[self.spec[i]].bot || !self.active(i, s) {
                continue;
            }
            let lock = self.phones[i].last_hud.as_ref().map_or(0, |h| h.lock);
            let hunting = self.sc.bots == BotMode::Hunt;
            if hunting && u32::from(lock) >= tail_protocol::LOCK_EPOCHS && self.rng.unit() < 0.05 {
                self.phones[i].strike();
            }
            // Demand reacts to the price board: at 2x a bot asks half as often, and never when
            // the price would take more than a quarter of its head.
            let board = self.phones[i]
                .last_hud
                .as_ref()
                .map_or((0, [0; 3], u128::MAX), |h| (h.hint_recent, h.hint_prices, h.head));
            let (recent, prices, head) = board;
            let eagerness = BPS_F / tail_protocol::demand_bps(recent) as f64;
            if self.rng.unit() < eagerness / 240.0 {
                let kind = (self.rng.next() % 3) as u8;
                if prices[usize::from(kind)].saturating_mul(4) <= head {
                    self.phones[i].hint(kind, Some("where are they?".into()));
                }
            }
        }
    }

    fn run(&mut self, mut state: State, vrf: &[u8; 64]) -> Result<(), String> {
        let mut outbox = Vec::new();
        let mut held: Vec<Vec<_>> = vec![Vec::new(); self.phones.len()];
        let mut receipts = Vec::new();
        let mut s = 0;
        loop {
            s += 1;
            if s > self.sc.duration_s + 60 {
                return Err("the match never ended".into());
            }
            let t_ms = START_MS + s * 1000;
            self.set_clocks(s);
            self.move_players(s);
            self.sense(s, t_ms);
            self.scripted_actions(s, t_ms)?;
            self.bot_actions(s);
            for i in 0..self.phones.len() {
                if self.active(i, s) && self.phones[i].batches_at(s) {
                    self.phones[i].sighting_copies = self.copies(i, s);
                    held[i].push(self.phones[i].batch(t_ms));
                    if !self.held(i, s) {
                        outbox.append(&mut held[i]);
                    }
                }
            }
            if s % (tail_protocol::TICK_MS / 1000) != 0 {
                continue;
            }
            let tick_no = (s / 10) as u32;
            self.report.batches_sent += outbox.len();
            let sent: Vec<Hash> = outbox.iter().map(|e| batch_hash(&e.batch)).collect();
            let call = Call::Tick {
                tick_no,
                now_ms: t_ms,
                call_id: call_id(tick_no),
            };
            let input = TickInput {
                tick_no,
                now_ms: t_ms,
                call_id: call_id(tick_no),
                batches: std::mem::take(&mut outbox),
                receipts: std::mem::take(&mut receipts),
            };
            let t0 = Instant::now();
            let out = referee_core::tick(state, input).map_err(|e| format!("tick {tick_no}: {e:?}"))?;
            self.report.tick_us.push(t0.elapsed().as_micros());
            self.record(s, call, &out.verdicts, &out.proofs, &out.log)?;
            check_rejected(&out.log, &out.rejected, &sent).map_err(|e| format!("tick {tick_no}: {e}"))?;
            self.check_huds(&out.huds, t_ms)
                .map_err(|e| format!("tick {tick_no}: {e}"))?;
            self.report
                .rejections
                .extend(out.rejected.into_iter().map(|r| (s, r)));
            self.report
                .refusals
                .extend(out.refused.into_iter().map(|r| (s, r)));
            // The voice call answers each hint before the next tick, as `voice` would.
            receipts.extend(out.hints.iter().map(|h| HintReceipt {
                hint_id: h.hint_id,
                chat_id: format!("chat-{}", h.hint_id),
                text_hash: sha256(&[b"handler line", &h.hint_id.to_le_bytes()]),
                signature: vec![0; 65],
                signing_address: "0x0000000000000000000000000000000000000000".into(),
            }));
            self.report.hints.extend(out.hints.into_iter().map(|h| (s, h)));
            for (p, hud) in out.huds {
                self.phones[p as usize].last_hud = Some(hud.clone());
                self.report.huds.push((s, p, hud));
            }
            state = self.roundtrip(&out.state)?;
            self.check_heads(&state)?;
            if out.over {
                let fin = referee_core::finish(
                    state,
                    format!("vrf:1:sim.testnet:{}", hex(&match_id(&self.sc.name))),
                    vrf,
                    call_id(tick_no + 1),
                    std::mem::take(&mut receipts),
                )
                .map_err(|e| format!("finish: {e:?}"))?;
                self.record(
                    s,
                    Call::End { tick_no: tick_no + 1 },
                    &fin.verdicts,
                    &fin.proofs,
                    &fin.log,
                )?;
                self.check_heads(&fin.state)?;
                self.report.final_heads = fin.state.players().iter().map(|p| p.head).collect();
                if self.chain.heads != self.report.final_heads {
                    return Err(format!(
                        "the contract would pay {:?}, the referee holds {:?}",
                        self.chain.heads, self.report.final_heads
                    ));
                }
                return Ok(());
            }
        }
    }

    /// The relay round trip: the state leaves as bytes and comes back as bytes.
    fn roundtrip(&mut self, state: &State) -> Result<State, String> {
        let t0 = Instant::now();
        let bytes = borsh::to_vec(state).map_err(|e| e.to_string())?;
        let back: State = borsh::from_slice(&bytes).map_err(|e| e.to_string())?;
        self.report.roundtrip_us.push(t0.elapsed().as_micros());
        self.report.state_bytes.push(bytes.len());
        if &back != state {
            return Err("state changed across its borsh round trip".into());
        }
        Ok(back)
    }

    fn check_heads(&self, state: &State) -> Result<(), String> {
        let want = u128::from(self.sc.stake) * self.phones.len() as u128;
        if state.total_heads() == want {
            Ok(())
        } else {
            Err(format!("sum of heads {} != {want}", state.total_heads()))
        }
    }

    /// One `Enrolled` per player, in index order, before anything else.
    fn check_enrolled(&self, log: &[LogEntry]) -> Result<(), String> {
        for (i, name) in self.report.names.iter().enumerate() {
            let want = LogEntry::Enrolled {
                player: i as u16,
                account: name.clone(),
                key_hash: sha256(&[&appattest::public_key_bytes(device_key(name).verifying_key())]),
                attested: true,
            };
            if log.get(i) != Some(&want) {
                return Err(format!("start log entry {i} is {:?}, want {want:?}", log.get(i)));
            }
        }
        Ok(())
    }

    /// Verdict seqs are contiguous and chained by `prev`, each verdict's log entry carries its
    /// digest, every Checkpoint / End root is the RFC 6962 root of the log before it with a
    /// consistency proof from the previous anchor, and every Tag follows its `Evidence`.
    fn record(
        &mut self,
        s: u64,
        call: Call,
        verdicts: &[VerdictPayload],
        proofs: &[ConsistencyProof],
        log: &[LogEntry],
    ) -> Result<(), String> {
        let tick_no = match call {
            Call::Tick {
                tick_no,
                now_ms,
                call_id,
            } => {
                let want = LogEntry::Tick {
                    tick_no,
                    now_ms,
                    call_id,
                };
                if log.first() != Some(&want) {
                    return Err(format!("tick {tick_no} log starts with {:?}", log.first()));
                }
                tick_no
            }
            Call::Start => 0,
            Call::End { tick_no } => tick_no,
        };
        let mut by_seq = BTreeMap::new();
        for e in log {
            if let LogEntry::Verdict { seq, digest } = e {
                by_seq.insert(*seq, (*digest, self.leaves.len()));
            }
            let index = self.leaves.len() as u64;
            if e.salt()
                .is_some_and(|s| *s != tail_protocol::beacon::log_salt(&self.k_log, index))
            {
                return Err(format!("log entry {index} has a salt K_log did not give it"));
            }
            self.leaves.push(merkle::leaf(e));
            self.report.log.push(e.clone());
        }
        let mut proofs = proofs.iter();
        for v in verdicts {
            if v.seq != self.next_seq {
                return Err(format!("verdict seq {} after {}", v.seq, self.next_seq - 1));
            }
            if v.prev != self.last_digest {
                return Err(format!("verdict {} does not chain to the one before", v.seq));
            }
            self.next_seq += 1;
            self.last_digest = verdict_digest(v);
            let (digest, at) = *by_seq.get(&v.seq).ok_or("verdict missing from the log")?;
            if digest != self.last_digest {
                return Err("log digest differs from the verdict".into());
            }
            match &v.body {
                Verdict::Checkpoint { log_size, root } | Verdict::End { log_size, root, .. } => {
                    let size = usize::try_from(*log_size).map_err(|e| e.to_string())?;
                    if size != at || merkle::root(&self.leaves[..size]) != *root {
                        return Err(format!("root at log size {log_size} does not match the log"));
                    }
                    let p = proofs.next().ok_or(format!("verdict {} has no proof", v.seq))?;
                    self.check_proof(v.seq, *log_size, root, p)?;
                }
                _ => {}
            }
            if let Verdict::Tag { hunter, target, .. } = &v.body {
                self.check_evidence(*hunter, *target, at)?;
                self.tags[*hunter as usize] += 1;
            }
            let names = &self.report.names;
            let vrf: [u8; 64] = self
                .report
                .vrf_signature
                .as_slice()
                .try_into()
                .map_err(|_| "vrf length")?;
            self.chain
                .apply(&v.body, || ring::ring_order(names, &vrf))
                .map_err(|e| format!("verdict {}: {e}", v.seq))?;
            self.report.verdicts.push((s, tick_no, v.clone()));
        }
        if proofs.next().is_some() {
            return Err("a proof without its Checkpoint or End".into());
        }
        Ok(())
    }

    /// What the contract checks before it anchors a root, and that the referee's frontier proof
    /// is the one the full log gives.
    fn check_proof(&mut self, seq: u32, size: u64, root: &Hash, p: &ConsistencyProof) -> Result<(), String> {
        let (from, old_root) = self.anchored;
        if p.seq != seq || p.from_size != from {
            return Err(format!(
                "proof for seq {} from {}, want seq {seq} from {from}",
                p.seq, p.from_size
            ));
        }
        if size <= from {
            return Err(format!("log size {size} does not grow past the anchor {from}"));
        }
        if !merkle::verify_consistency(from, size, &old_root, root, &p.path) {
            return Err(format!("consistency proof {from} → {size} does not verify"));
        }
        let full = merkle::consistency_proof(&self.leaves[..size as usize], from as usize);
        if p.path != full {
            return Err(format!(
                "frontier proof {from} → {size} differs from the full-log proof"
            ));
        }
        self.anchored = (size, *root);
        Ok(())
    }

    /// The entry before a Tag's verdict entry is its `Evidence`: at least `LOCK_EPOCHS` contact
    /// epochs of this pair in the window ending at the strike's epoch, every one of them a
    /// logged `Contact`, one of them the strike's epoch or the one before, and the strike's
    /// batch logged for the hunter.
    fn check_evidence(&self, hunter: u16, target: u16, verdict_at: usize) -> Result<(), String> {
        let log = &self.report.log;
        let Some(LogEntry::Evidence {
            hunter: ev_hunter,
            target: ev_target,
            strike_seq,
            strike_epoch,
            epochs,
            ..
        }) = verdict_at.checked_sub(1).map(|i| &log[i])
        else {
            return Err(format!("Tag {hunter} → {target} has no Evidence before it"));
        };
        let pair = (hunter.min(target), hunter.max(target));
        let logged = |epoch: u32| {
            log[..verdict_at].iter().any(
                |x| matches!(*x, LogEntry::Contact { a, b, epoch: e, .. } if (a, b) == pair && e == epoch),
            )
        };
        let justified = (*ev_hunter, *ev_target) == (hunter, target)
            && epochs.len() as u32 >= LOCK_EPOCHS
            && epochs.windows(2).all(|w| w[0] < w[1])
            && epochs
                .iter()
                .all(|x| x <= strike_epoch && strike_epoch - x < WINDOW_EPOCHS)
            && epochs.iter().all(|x| logged(*x))
            && (epochs.contains(strike_epoch) || epochs.contains(&strike_epoch.wrapping_sub(1)))
            && log[..verdict_at]
                .iter()
                .any(|x| matches!(x, LogEntry::Batch { player, seq, .. } if *player == hunter && seq == strike_seq));
        if justified {
            Ok(())
        } else {
            Err(format!(
                "Evidence for Tag {hunter} → {target} does not justify it: {:?}",
                log[verdict_at - 1]
            ))
        }
    }

    /// HUD v2: the log at the end of the tick, the tags each player made, and the price board
    /// the contract would charge at `now_ms`.
    fn check_huds(&self, huds: &[(u16, Hud)], now_ms: u64) -> Result<(), String> {
        let root = merkle::root(&self.leaves);
        let board = self.chain.board(now_ms)?;
        for (p, h) in huds {
            if (h.hint_recent, h.hint_prices) != board {
                return Err(format!(
                    "HUD of player {p} prices hints {:?} at demand {}, the contract {board:?}",
                    h.hint_prices, h.hint_recent
                ));
            }
            if h.player != *p || h.log_size != self.leaves.len() as u64 || h.root != root {
                return Err(format!("HUD of player {p} names another log or player"));
            }
            if h.tags != self.tags[*p as usize] {
                return Err(format!(
                    "HUD of player {p} says {} tags, not {}",
                    h.tags, self.tags[*p as usize]
                ));
            }
        }
        Ok(())
    }
}

/// Every refused batch is logged, in the order refused, with its code and the hash of a batch
/// that was sent this tick.
fn check_rejected(log: &[LogEntry], rejected: &[Rejection], sent: &[Hash]) -> Result<(), String> {
    let logged: Vec<(u16, u32, Hash, u8)> = log
        .iter()
        .filter_map(|e| match e {
            LogEntry::Rejected {
                player,
                seq,
                hash,
                code,
            } => Some((*player, *seq, *hash, *code)),
            _ => None,
        })
        .collect();
    if logged.len() != rejected.len() {
        return Err(format!(
            "{} Rejected entries for {} rejections",
            logged.len(),
            rejected.len()
        ));
    }
    for ((player, seq, hash, code), r) in logged.iter().zip(rejected) {
        if (*player, *seq, *code) != (r.player, r.seq, r.reason.code()) || !sent.contains(hash) {
            return Err(format!(
                "Rejected entry {player}/{seq} code {code} does not match {r:?}"
            ));
        }
    }
    Ok(())
}

fn call_id(tick_no: u32) -> [u8; 16] {
    let mut id = [0u8; 16];
    id[..4].copy_from_slice(&tick_no.to_le_bytes());
    id
}

fn hex(b: &[u8]) -> String {
    use std::fmt::Write;
    b.iter().fold(String::new(), |mut s, x| {
        let _ = write!(s, "{x:02x}");
        s
    })
}

fn status_name(s: u8) -> &'static str {
    match s {
        target_status::HUNTING => "hunting",
        target_status::OUT => "out",
        target_status::WON => "won",
        _ => "?",
    }
}

fn occurs(spec: &scenario::Occurs, r: &Report, player: u16, t: u64, reason: &str, code: Option<u8>) -> bool {
    r.index(&spec.player) == Some(player)
        && spec.reason == reason
        && spec.code.is_none_or(|c| Some(c) == code)
        && (spec.from..=spec.to).contains(&t)
}

fn check_huds(e: &Expect, r: &Report, bad: &mut Vec<String>) {
    for c in &e.huds {
        let Some(h) = r.hud(c.t, &c.player) else {
            bad.push(format!("no HUD for {} at {}s", c.player, c.t));
            continue;
        };
        let mut diff = |field: &str, ok: bool, got: String| {
            if !ok {
                bad.push(format!("HUD {} at {}s: {field} = {got}", c.player, c.t));
            }
        };
        if let Some(v) = c.lock {
            diff("lock", h.lock == v, h.lock.to_string());
        }
        if let Some(v) = c.heat {
            diff("heat", h.heat == v, h.heat.to_string());
        }
        if let Some(v) = c.head {
            diff("head", h.head == u128::from(v), h.head.to_string());
        }
        if let Some(v) = c.leak {
            diff("leak", h.leak.is_some() == v, format!("{:?}", h.leak));
        }
        if let Some([kind, value]) = c.hint {
            let ok = h.hint_fact.is_some_and(|f| f.hint == kind && f.value == value);
            diff("hint", ok, format!("{:?}", h.hint_fact));
        }
        if let Some(v) = &c.status {
            diff("status", status_name(h.status) == v, status_name(h.status).into());
        }
        if let Some(v) = &c.target {
            diff("target", &h.target == v, h.target.clone());
        }
        if let Some(v) = c.tags {
            diff("tags", h.tags == v, h.tags.to_string());
        }
        if let Some(v) = c.rejected {
            let code = h.rejected.map_or(0, |(_, code)| code);
            diff("rejected", code == v, format!("{:?}", h.rejected));
        }
        if let Some(v) = c.hint_recent {
            diff("hint_recent", h.hint_recent == v, h.hint_recent.to_string());
        }
        if let Some(v) = c.hint_prices {
            diff(
                "hint_prices",
                h.hint_prices == v.map(u128::from),
                format!("{:?}", h.hint_prices),
            );
        }
    }
}

fn check_evidence(e: &Expect, r: &Report, bad: &mut Vec<String>) {
    for ev in &e.evidence {
        let (Some(h), Some(t)) = (r.index(&ev.hunter), r.index(&ev.target)) else {
            bad.push(format!("evidence: unknown player in {ev:?}"));
            continue;
        };
        let found = r.log.iter().any(|x| {
            matches!(x, LogEntry::Evidence { hunter, target, strike_epoch, epochs, .. }
                if (*hunter, *target, *strike_epoch) == (h, t, ev.strike_epoch) && *epochs == ev.epochs)
        });
        if !found {
            let logged: Vec<&LogEntry> = r
                .log
                .iter()
                .filter(|x| matches!(x, LogEntry::Evidence { .. }))
                .collect();
            bad.push(format!("missing {ev:?}; logged {logged:?}"));
        }
    }
}

/// Every way the report differs from what the scenario expects.
pub fn check(e: &Expect, r: &Report) -> Vec<String> {
    let mut bad = Vec::new();
    if let Some(want) = &e.verdicts {
        let got = r.verdict_texts(e.checkpoints);
        if &got != want {
            bad.push(format!("verdicts: got {got:?}, want {want:?}"));
        }
    }
    let rej: Vec<(u64, u16, String, Option<u8>)> = r
        .rejections
        .iter()
        .map(|(t, x)| (*t, x.player, variant(&x.reason), Some(x.reason.code())))
        .collect();
    let refu: Vec<(u64, u16, String, Option<u8>)> = r
        .refusals
        .iter()
        .map(|(t, x)| (*t, x.player, variant(&x.reason), None))
        .collect();
    for (what, specs, got, only) in [
        ("rejection", &e.rejections, &rej, e.only_listed_rejections),
        ("refusal", &e.refusals, &refu, e.only_listed_refusals),
    ] {
        for spec in specs {
            if !got
                .iter()
                .any(|(t, p, why, code)| occurs(spec, r, *p, *t, why, *code))
            {
                bad.push(format!("missing {what} {spec:?}"));
            }
        }
        if only {
            for (t, p, why, code) in got {
                if !specs.iter().any(|spec| occurs(spec, r, *p, *t, why, *code)) {
                    bad.push(format!("unexpected {what} at {t}s: {} {why}", r.name(*p)));
                }
            }
        }
    }
    for (name, want) in &e.heads {
        if r.index(name).is_none() {
            bad.push(format!("heads: unknown player {name}"));
        } else if r.head(name) != u128::from(*want) {
            bad.push(format!("head of {name}: got {}, want {want}", r.head(name)));
        }
    }
    check_huds(e, r, &mut bad);
    check_evidence(e, r, &mut bad);
    for vt in &e.verdict_times {
        let hit = r
            .verdicts
            .iter()
            .any(|(t, _, v)| r.verdict_text(&v.body) == vt.verdict && (vt.from..=vt.to).contains(t));
        if !hit {
            let at: Vec<u64> = r
                .verdicts
                .iter()
                .filter(|(_, _, v)| r.verdict_text(&v.body) == vt.verdict)
                .map(|(t, _, _)| *t)
                .collect();
            bad.push(format!(
                "{} not within [{}, {}]s (at {at:?})",
                vt.verdict, vt.from, vt.to
            ));
        }
    }
    bad
}

/// Loads a scenario file.
pub fn load(path: &std::path::Path) -> Result<Scenario, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))
}

/// The performance match: `n` bots, `minutes` long, inside a zone of `radius_m`, radio range
/// 15 m.
pub fn random_walk(n: usize, minutes: u64, radius_m: u32, bots: BotMode) -> Scenario {
    Scenario {
        name: format!("random-walk-{n}x{minutes}m-{bots:?}"),
        about: None,
        stake: 1_000_000,
        duration_s: minutes * 60,
        zone: scenario::Zone {
            radius_m,
            ..scenario::Zone::default()
        },
        safehouses: Vec::new(),
        ring: None,
        players: (0..n)
            .map(|i| scenario::PlayerSpec {
                name: format!("p{i:02}"),
                path: Vec::new(),
                acc_m: 8,
                clock_offset_ms: (i as i64 % 3 - 1) * 300,
                batch_phase_s: (i as u64) % 5,
                bot: true,
            })
            .collect(),
        radio: Vec::new(),
        radio_auto_m: Some(15.0),
        events: Vec::new(),
        bots,
        expect: Expect::default(),
    }
}

/// Summary statistics of a run, for the performance report.
#[derive(Debug)]
pub struct Stats {
    pub ticks: usize,
    pub batches: usize,
    pub state_bytes_max: usize,
    pub state_bytes_mean: usize,
    pub state_bytes_last: usize,
    pub tick_us_mean: u128,
    pub tick_us_p95: u128,
    pub tick_us_max: u128,
    pub roundtrip_us_mean: u128,
    pub tags: usize,
    pub forfeits: usize,
    pub hints: usize,
    pub contacts: usize,
    pub log_entries: usize,
    /// The hint price index (the demand multiplier on every base price, in basis points) per
    /// `PRICE_WINDOW_MS` of the match: `(minute it starts, mean, max)` over the ticks in it.
    pub price_index: Vec<(u64, u128, u128)>,
}

pub fn stats(r: &Report) -> Stats {
    let mut us = r.tick_us.clone();
    us.sort_unstable();
    let ticks = us.len().max(1);
    let count = |f: fn(&Verdict) -> bool| r.verdicts.iter().filter(|(_, _, v)| f(&v.body)).count();
    Stats {
        ticks: r.tick_us.len(),
        batches: r.batches_sent,
        state_bytes_max: r.state_bytes.iter().copied().max().unwrap_or(0),
        state_bytes_mean: r.state_bytes.iter().sum::<usize>() / ticks,
        state_bytes_last: r.state_bytes.last().copied().unwrap_or(0),
        tick_us_mean: us.iter().sum::<u128>() / ticks as u128,
        tick_us_p95: us.get(us.len() * 95 / 100).copied().unwrap_or(0),
        tick_us_max: us.last().copied().unwrap_or(0),
        roundtrip_us_mean: r.roundtrip_us.iter().sum::<u128>() / ticks as u128,
        tags: count(|v| matches!(v, Verdict::Tag { .. })),
        forfeits: count(|v| matches!(v, Verdict::Forfeit { .. })),
        hints: count(|v| matches!(v, Verdict::Hint { .. })),
        contacts: r
            .log
            .iter()
            .filter(|e| matches!(e, LogEntry::Contact { .. }))
            .count(),
        log_entries: r.log.len(),
        price_index: price_index(r),
    }
}

fn price_index(r: &Report) -> Vec<(u64, u128, u128)> {
    let window_s = tail_protocol::PRICE_WINDOW_MS / 1000;
    let mut buckets: BTreeMap<u64, Vec<u128>> = BTreeMap::new();
    // Every HUD of a tick shows the same board; player 0's stands for it.
    for (t, _, h) in r.huds.iter().filter(|(_, p, _)| *p == 0) {
        buckets
            .entry(t / window_s)
            .or_default()
            .push(tail_protocol::demand_bps(h.hint_recent));
    }
    buckets
        .into_iter()
        .map(|(k, v)| {
            let mean = v.iter().sum::<u128>() / v.len() as u128;
            (k * window_s / 60, mean, v.iter().copied().max().unwrap_or(0))
        })
        .collect()
}
