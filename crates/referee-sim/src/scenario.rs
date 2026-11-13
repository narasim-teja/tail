//! The JSON trace format. Positions are metres east (`x`) and north (`y`) of the zone centre,
//! times are whole seconds from the match start.

use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct Scenario {
    pub name: String,
    /// What the trace shows, and why its expectations are what they are.
    #[serde(default)]
    pub about: Option<String>,
    #[serde(default = "default_stake")]
    pub stake: u64,
    pub duration_s: u64,
    #[serde(default)]
    pub zone: Zone,
    #[serde(default)]
    pub safehouses: Vec<Place>,
    /// Who hunts whom (`ring[k]` hunts `ring[k+1]`); the simulator picks a VRF signature that
    /// yields it. Omitted: whatever the default signature gives.
    pub ring: Option<Vec<String>>,
    pub players: Vec<PlayerSpec>,
    /// Explicit radio contact windows.
    #[serde(default)]
    pub radio: Vec<Radio>,
    /// If set, any two live phones within this many metres hear each other.
    pub radio_auto_m: Option<f64>,
    #[serde(default)]
    pub events: Vec<Event>,
    /// How `bot` players behave.
    #[serde(default)]
    pub bots: BotMode,
    #[serde(default)]
    pub expect: Expect,
}

#[derive(Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BotMode {
    /// Chase the target part of the time, strike on a full lock, buy the odd hint.
    #[default]
    Hunt,
    /// Same walk, but never strike: everyone stays in for the whole match.
    Wander,
    /// Everyone stands within a few metres of everyone else and never strikes: the most
    /// contacts and sightings the state can hold.
    Clump,
}

fn default_stake() -> u64 {
    1_000_000
}

#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(deny_unknown_fields)]
pub struct Zone {
    pub lat: f64,
    pub lon: f64,
    pub radius_m: u32,
}

impl Default for Zone {
    /// Boston Common.
    fn default() -> Self {
        Self {
            lat: 42.355,
            lon: -71.066,
            radius_m: 5_000,
        }
    }
}

#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(deny_unknown_fields)]
pub struct Place {
    pub x: f64,
    pub y: f64,
    pub radius_m: u32,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct PlayerSpec {
    pub name: String,
    /// Waypoints `[t_s, x, y]`, linear in between, held before the first and after the last.
    #[serde(default)]
    pub path: Vec<[f64; 3]>,
    #[serde(default = "default_acc")]
    pub acc_m: u16,
    #[serde(default)]
    pub clock_offset_ms: i64,
    /// Batches go out at seconds `phase + 5k`.
    #[serde(default)]
    pub batch_phase_s: u64,
    /// Move by the random-walk bot instead of `path`.
    #[serde(default)]
    pub bot: bool,
}

fn default_acc() -> u16 {
    5
}

#[derive(Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Dir {
    #[default]
    Both,
    AHearsB,
    BHearsA,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct Radio {
    pub a: String,
    pub b: String,
    pub from: u64,
    pub to: u64,
    #[serde(default)]
    pub dir: Dir,
    #[serde(default = "default_rssi")]
    pub rssi: i8,
}

fn default_rssi() -> i8 {
    -60
}

#[derive(Deserialize, Clone, Debug)]
#[serde(tag = "do", rename_all = "snake_case", deny_unknown_fields)]
pub enum Event {
    Strike {
        t: u64,
        player: String,
    },
    /// A hint at `t`, repeated `count` times `every` seconds apart.
    Hint {
        t: u64,
        player: String,
        kind: String,
        text: Option<String>,
        #[serde(default)]
        every: u64,
        #[serde(default = "one_u32")]
        count: u32,
    },
    /// The phone is off: no fixes, no scanning, no advertising, no batches.
    Dark {
        player: String,
        from: u64,
        to: u64,
    },
    /// Fixes carry these `Fix.flags` (1 = simulated by software).
    Flags {
        player: String,
        from: u64,
        to: u64,
        #[serde(default = "one")]
        flags: u8,
    },
    /// The phone keeps batching but nothing reaches the relay: batches made in `[from, to)`
    /// are delivered together with its first batch from `to` on (a reconnect backlog).
    Hold {
        player: String,
        from: u64,
        to: u64,
    },
    /// From second `t` on, the phone's clock reads `offset_ms` off true time.
    Clock {
        player: String,
        t: u64,
        offset_ms: i64,
    },
    /// Batches made in `[from, to)` list every sighting `copies` times.
    Copies {
        player: String,
        from: u64,
        to: u64,
        copies: u8,
    },
    /// `hearer` records `of`'s token from `epoch_offset` epochs away, bypassing the tag filter.
    Inject {
        hearer: String,
        of: String,
        from: u64,
        to: u64,
        epoch_offset: i64,
        #[serde(default = "default_rssi")]
        rssi: i8,
    },
}

fn one() -> u8 {
    1
}

fn one_u32() -> u32 {
    1
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(deny_unknown_fields)]
pub struct Expect {
    /// Exact verdict sequence: `Start`, `Tag h t`, `Hint from to amount`, `Forfeit p to`,
    /// `Checkpoint` (only with `checkpoints`), `End`.
    pub verdicts: Option<Vec<String>>,
    #[serde(default)]
    pub checkpoints: bool,
    /// Every listed rejection must occur; with `only_listed_rejections`, nothing else may.
    #[serde(default)]
    pub rejections: Vec<Occurs>,
    #[serde(default = "yes")]
    pub only_listed_rejections: bool,
    #[serde(default)]
    pub refusals: Vec<Occurs>,
    #[serde(default = "yes")]
    pub only_listed_refusals: bool,
    #[serde(default)]
    pub heads: BTreeMap<String, u64>,
    #[serde(default)]
    pub huds: Vec<HudCheck>,
    /// Verdicts (by the same spelling) that must land within `[from, to]` seconds.
    #[serde(default)]
    pub verdict_times: Vec<VerdictTime>,
    /// `Evidence` log entries that must appear, exactly as listed.
    #[serde(default)]
    pub evidence: Vec<EvidenceCheck>,
}

/// The contact epochs a tag's `Evidence` entry must list.
#[derive(Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct EvidenceCheck {
    pub hunter: String,
    pub target: String,
    pub strike_epoch: u32,
    pub epochs: Vec<u32>,
}

fn yes() -> bool {
    true
}

/// A rejection or refusal: `reason` is the variant name (`Teleport`, `Lock`, `Cooldown`, …).
#[derive(Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct Occurs {
    pub player: String,
    pub reason: String,
    /// Rejections only: the `reject_code` its `Rejected` log entry and the HUD carry.
    #[serde(default)]
    pub code: Option<u8>,
    #[serde(default)]
    pub from: u64,
    #[serde(default = "forever")]
    pub to: u64,
}

fn forever() -> u64 {
    u64::MAX
}

#[derive(Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct HudCheck {
    pub t: u64,
    pub player: String,
    pub lock: Option<u8>,
    pub heat: Option<u8>,
    pub head: Option<u64>,
    /// Whether the HUD carries a leaked grid cell.
    pub leak: Option<bool>,
    /// `[kind, value]` of the hint fact on this HUD.
    pub hint: Option<[u8; 2]>,
    /// `hunting`, `out` or `won`.
    pub status: Option<String>,
    pub target: Option<String>,
    /// Tags this player has made.
    pub tags: Option<u8>,
    /// `reject_code` of the player's latest refused authentic batch, 0 for none.
    pub rejected: Option<u8>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct VerdictTime {
    pub verdict: String,
    pub from: u64,
    pub to: u64,
}
