//! Re-executes a finished TAIL match from its protocol v2 replay bundle (`GET /replay/:id`) and
//! checks that the referee's output follows from its inputs.
//!
//! The bundle holds the declassified log, the released batches, `K_m` and the VRF reveal. Those
//! are every input the engine had: the `Enrolled` entries and the Start verdict give `init`, each
//! `Tick { tick_no, now_ms, call_id }` entry gives one `tick`, the `Batch` and `Rejected` entries
//! after it name the batches that tick processed, its `HintReceipt` entries the receipts, and End
//! gives `finish`. Running `referee-core` on them must give back every log entry and every
//! verdict byte for byte. The first difference names the tick and the entry.
//!
//! What cannot be re-executed is taken from the log and listed in [`Outcome::trusted`]: App
//! Attest outcomes when the device keys or assertions are not in the bundle, and the reasons of
//! refused batches the relay did not keep. Signatures are not re-created (there is no referee
//! key here); each verdict's is checked against `referee_pk`.

use base64::Engine as _;
use referee_core::{
    finish, init_released, replay_tick, Circle, HintReceipt, MatchConfig, Reject, ReleasedDevice,
    ReleasedKey, ReplayBatch, ReplayTickInput, State,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use tail_protocol::digest::{batch_client_data_hash, batch_hash, verdict_digest};
use tail_protocol::{
    merkle, reject_code, Batch, BatchEnvelope, Hash, LogEntry, MatchId, SignedVerdict, Verdict,
    VerdictPayload,
};

/// The App ID the referee checks assertions against unless the match says otherwise
/// (`referee-wasi` `start`'s default).
pub const DEFAULT_APP_ID: &str = "LKABS9RZAC.com.lkabs9rzac.tail";

// ── bundle (packages/protocol/src/replay.ts `ReplayBundleV2`) ─────────────────────────

/// A version 2 replay bundle as the relay serves it. Fields the verifier does not use (the
/// Handler lines, transaction hashes) are ignored. `assertions`, `rejected`,
/// `devices[].appAttestPk`, `devices[].counter` and `match.appId` are optional (older bundles
/// lack them); without them App Attest outcomes and refusals are taken from the log.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bundle {
    pub version: u32,
    #[serde(rename = "match")]
    pub game: BundleMatch,
    pub referee: BundleReferee,
    pub verdicts: Vec<BundleVerdict>,
    /// Lowercase hex RFC 6962 leaf hashes.
    pub leaves: Vec<String>,
    /// b64 borsh `LogEntry`.
    pub log: Vec<String>,
    /// b64 borsh `Batch`, as `declassify_batches` returns them.
    pub batches: Vec<String>,
    /// b64 App Attest assertion of `batches[i]` (`declassify_batches` returns them).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assertions: Option<Vec<Option<String>>>,
    /// The batches the referee refused, each with its assertion. A batch here is found by hash
    /// like one in `batches`; the relay keeps them apart because they are not trails.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rejected: Option<Vec<BundleRejected>>,
    pub reveal: BundleReveal,
    #[serde(default)]
    pub devices: Vec<BundleDevice>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleRejected {
    /// b64 borsh `Batch`.
    pub batch: String,
    /// b64 App Attest assertion.
    pub assertion: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleMatch {
    /// 16 bytes, hex.
    pub id: String,
    /// u128 decimal.
    pub stake: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub zone: BundleCircle,
    #[serde(default)]
    pub safehouses: Vec<BundleCircle>,
    pub players: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleCircle {
    pub lat_e7: i32,
    pub lon_e7: i32,
    pub radius_m: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleReferee {
    /// ed25519 verdict key, hex.
    pub referee_pk: String,
    /// ed25519 VRF key, hex.
    pub vrf_pk: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleVerdict {
    /// b64 borsh `SignedVerdict`.
    pub signed: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleReveal {
    pub vrf_alpha: String,
    /// 64 bytes, hex.
    pub vrf_signature: String,
    /// K_m, 32 bytes, hex.
    pub k_m: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleDevice {
    pub account_id: String,
    /// SEC1 P-256 App Attest key, hex (65 bytes).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_attest_pk: Option<String>,
    /// Assertion counter at enrolment; `start` always uses 0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub counter: Option<u32>,
}

// ── outcome ───────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    /// The bundle does not decode.
    Bundle,
    /// A key the bundle names is not the one pinned in [`Options`].
    Pins,
    /// `leaves[i]` is not the leaf of `log[i]`.
    Leaves,
    Signatures,
    Vrf,
    Start,
    Tick(u32),
    End,
}

/// Where the re-execution first disagrees with the bundle, or which check failed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failure {
    pub stage: Stage,
    /// Log index of the first entry that differs (or is missing).
    pub log_index: Option<usize>,
    /// Seq of the first verdict that differs.
    pub verdict_seq: Option<u32>,
    pub what: String,
}

#[derive(Clone, Debug, Default)]
pub struct Outcome {
    /// One line per call (Start, every tick, End), in order, up to a failure.
    pub lines: Vec<String>,
    /// Which inputs the bundle supplied and whether anything outside it pinned them. A
    /// re-execution shows the verdicts follow from these; it cannot show these are the match's.
    pub inputs: Vec<String>,
    /// Inputs that differ from what the caller expects without failing a check.
    pub warnings: Vec<String>,
    /// What had to be taken from the log instead of re-executed, and why.
    pub trusted: Vec<String>,
    pub notes: Vec<String>,
    pub failure: Option<Failure>,
}

impl Outcome {
    pub fn passed(&self) -> bool {
        self.failure.is_none()
    }
}

#[derive(Clone, Debug, Default)]
pub struct Options {
    /// The App ID pinned by `--app-id`: a bundle naming another one fails at [`Stage::Pins`],
    /// and one naming none is checked against it. Without it, assertions are checked against
    /// the bundle's App ID (warned about when it is not [`DEFAULT_APP_ID`]), or the default
    /// when the bundle names none.
    pub app_id: Option<String>,
    /// The verdict key the match must use (the contract's `get_match` `referee_pk`). Without
    /// it, signatures are checked against the bundle's own key.
    pub referee_pk: Option<[u8; 32]>,
    /// The VRF key the match must use (`get_match` `vrf_pk`).
    pub vrf_pk: Option<[u8; 32]>,
}

pub fn verify_json(json: &str, opts: &Options) -> Outcome {
    match serde_json::from_str::<Bundle>(json) {
        Ok(b) => verify(&b, opts),
        Err(e) => Outcome {
            failure: Some(fail(Stage::Bundle, format!("not a replay bundle: {e}"))),
            ..Outcome::default()
        },
    }
}

pub fn verify(bundle: &Bundle, opts: &Options) -> Outcome {
    let mut o = Outcome::default();
    let d = match decode(bundle, opts) {
        Ok(d) => d,
        Err(e) => {
            o.failure = Some(fail(Stage::Bundle, e));
            return o;
        }
    };
    provenance(bundle, &d, opts, &mut o);
    if let Err(f) = pins(&d, opts)
        .and_then(|()| static_checks(&d, &mut o))
        .and_then(|()| Replay::new(&d).run(&mut o))
    {
        o.failure = Some(f);
    }
    o
}

/// Says which inputs the bundle supplied, so a pass is read as "follows from these", and warns
/// when the bundle names an App ID other than the expected one.
fn provenance(b: &Bundle, d: &Decoded, opts: &Options, o: &mut Outcome) {
    let key = |name: &str, have: &[u8; 32], pin: Option<[u8; 32]>, flag: &str| match pin {
        Some(_) => format!("{name} {} from the bundle, pinned by {flag}", hex::encode(have)),
        None => format!(
            "{name} {} from the bundle, not pinned: pass {flag} with the contract's get_match value",
            hex::encode(have)
        ),
    };
    o.inputs
        .push(key("referee_pk", &d.referee_pk, opts.referee_pk, "--referee-pk"));
    o.inputs.push(key("vrf_pk", &d.vrf_pk, opts.vrf_pk, "--vrf-pk"));
    match &b.game.app_id {
        Some(id) => {
            let pinned = if opts.app_id.is_some() {
                ", pinned by --app-id"
            } else {
                ""
            };
            o.inputs
                .push(format!("app id {id} from the bundle's match.appId{pinned}"));
            if opts.app_id.is_none() && id != DEFAULT_APP_ID {
                o.warnings.push(format!(
                    "the bundle's app id {id} is not the production {DEFAULT_APP_ID}: App Attest \
                     assertions were checked against the bundle's (pass --app-id to pin one)"
                ));
            }
        }
        None => o.inputs.push(format!(
            "app id {} from {}: the bundle names none",
            d.cfg.app_id,
            if opts.app_id.is_some() {
                "--app-id"
            } else {
                "the default"
            }
        )),
    }
    let keys = d.keys.iter().filter(|k| k.is_some()).count();
    o.inputs.push(format!(
        "App Attest keys of {keys} of {} players from the bundle's devices[]; re-execution \
         checks each against its Enrolled entry's key hash",
        d.players.len()
    ));
    o.inputs.push(
        "players, start and end times from the bundle's match, bound by Start's signed \
         players_hash and times"
            .into(),
    );
    o.inputs.push(
        "each Enrolled entry's attested flag is the referee's own record: Apple's attestation \
         is not in the bundle"
            .into(),
    );
    o.inputs.push(format!(
        "stake {}, zone and {} safehouses from the bundle's match; not compared with NEAR",
        d.cfg.stake,
        d.cfg.safehouses.len()
    ));
}

/// The bundle's keys and App ID must be the pinned ones: a match signed under any other key, or
/// played by phones of another app, re-executes just as cleanly.
fn pins(d: &Decoded, opts: &Options) -> Result<(), Failure> {
    if let Some(want) = opts.app_id.as_ref().filter(|w| **w != d.cfg.app_id) {
        return Err(fail(
            Stage::Pins,
            format!(
                "the bundle's app id is {}, the pinned one (--app-id) is {want}",
                d.cfg.app_id
            ),
        ));
    }
    for (name, have, pin) in [
        ("referee_pk", d.referee_pk, opts.referee_pk),
        ("vrf_pk", d.vrf_pk, opts.vrf_pk),
    ] {
        if let Some(want) = pin.filter(|w| *w != have) {
            return Err(fail(
                Stage::Pins,
                format!(
                    "the bundle's {name} is {}, the pinned one is {}",
                    hex::encode(have),
                    hex::encode(want)
                ),
            ));
        }
    }
    Ok(())
}

fn fail(stage: Stage, what: impl Into<String>) -> Failure {
    Failure {
        stage,
        log_index: None,
        verdict_seq: None,
        what: what.into(),
    }
}

// ── decoding ──────────────────────────────────────────────────────────────────────

struct Released {
    batch: Batch,
    /// Distinct assertions released for this batch (a resend may carry a new one).
    assertions: Vec<Vec<u8>>,
}

struct Decoded {
    cfg: MatchConfig,
    start_ms: u64,
    players: Vec<String>,
    referee_pk: [u8; 32],
    vrf_pk: [u8; 32],
    verdicts: Vec<SignedVerdict>,
    leaves: Vec<Hash>,
    log: Vec<LogEntry>,
    released: BTreeMap<Hash, Released>,
    /// Whether `assertions` was in the bundle at all.
    have_assertions: bool,
    alpha: String,
    vrf_signature: [u8; 64],
    k_m: [u8; 32],
    /// Per player index: the App Attest key, when released.
    keys: Vec<Option<[u8; 65]>>,
    counters: Vec<u32>,
}

fn unhex<const N: usize>(s: &str, what: &str) -> Result<[u8; N], String> {
    let v = hex::decode(s).map_err(|e| format!("{what}: {e}"))?;
    v.try_into()
        .map_err(|v: Vec<u8>| format!("{what}: {} bytes, want {N}", v.len()))
}

fn unb64(s: &str, what: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .map_err(|e| format!("{what}: {e}"))
}

fn circle(c: BundleCircle) -> Circle {
    Circle {
        lat_e7: c.lat_e7,
        lon_e7: c.lon_e7,
        radius_m: c.radius_m,
    }
}

fn decode(b: &Bundle, opts: &Options) -> Result<Decoded, String> {
    if b.version != 2 {
        return Err(format!(
            "bundle version {}; only protocol v2 matches can be re-executed",
            b.version
        ));
    }
    let g = &b.game;
    let match_id: MatchId = unhex(&g.id, "match.id")?;
    let stake = g.stake.parse::<u128>().map_err(|e| format!("match.stake: {e}"))?;
    let duration_ms = g
        .end_ms
        .checked_sub(g.start_ms)
        .ok_or("match.endMs is before match.startMs")?;
    let mut players = g.players.clone();
    players.sort();
    let cfg = MatchConfig {
        match_id,
        app_id: g
            .app_id
            .clone()
            .or_else(|| opts.app_id.clone())
            .unwrap_or_else(|| DEFAULT_APP_ID.into()),
        stake,
        duration_ms,
        zone: circle(g.zone),
        safehouses: g.safehouses.iter().copied().map(circle).collect(),
    };
    let verdicts = b
        .verdicts
        .iter()
        .enumerate()
        .map(|(i, v)| {
            borsh::from_slice::<SignedVerdict>(&unb64(&v.signed, "verdict")?)
                .map_err(|e| format!("verdicts[{i}]: {e}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let leaves = b
        .leaves
        .iter()
        .map(|l| unhex::<32>(l, "leaf"))
        .collect::<Result<Vec<_>, _>>()?;
    let log = b
        .log
        .iter()
        .enumerate()
        .map(|(i, e)| {
            borsh::from_slice::<LogEntry>(&unb64(e, "log entry")?).map_err(|e| format!("log[{i}]: {e}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let released = released(b)?;
    let device = |acc: &String| b.devices.iter().find(|d| &d.account_id == acc);
    let keys = players
        .iter()
        .map(|acc| match device(acc).and_then(|d| d.app_attest_pk.as_ref()) {
            Some(k) => unhex::<65>(k, "appAttestPk").map(Some),
            None => Ok(None),
        })
        .collect::<Result<Vec<_>, _>>()?;
    let counters = players
        .iter()
        .map(|acc| device(acc).and_then(|d| d.counter).unwrap_or(0))
        .collect();
    Ok(Decoded {
        cfg,
        start_ms: g.start_ms,
        players,
        referee_pk: unhex(&b.referee.referee_pk, "referee.refereePk")?,
        vrf_pk: unhex(&b.referee.vrf_pk, "referee.vrfPk")?,
        verdicts,
        leaves,
        log,
        released,
        have_assertions: b.assertions.is_some(),
        alpha: b.reveal.vrf_alpha.clone(),
        vrf_signature: unhex(&b.reveal.vrf_signature, "reveal.vrfSignature")?,
        k_m: unhex(&b.reveal.k_m, "reveal.kM")?,
        keys,
        counters,
    })
}

/// Every released batch by hash, from `batches` and `rejected`, with its distinct assertions.
fn released(b: &Bundle) -> Result<BTreeMap<Hash, Released>, String> {
    if let Some(a) = &b.assertions {
        if a.len() != b.batches.len() {
            return Err(format!("{} assertions for {} batches", a.len(), b.batches.len()));
        }
    }
    let accepted = b.batches.iter().enumerate().map(|(i, raw)| {
        let assertion = b.assertions.as_ref().and_then(|a| a[i].as_deref());
        (format!("batches[{i}]"), raw.as_str(), assertion)
    });
    let refused = b.rejected.iter().flatten().enumerate().map(|(i, r)| {
        (
            format!("rejected[{i}]"),
            r.batch.as_str(),
            Some(r.assertion.as_str()),
        )
    });
    let mut released: BTreeMap<Hash, Released> = BTreeMap::new();
    for (what, raw, assertion) in accepted.chain(refused) {
        let batch: Batch = borsh::from_slice(&unb64(raw, "batch")?).map_err(|e| format!("{what}: {e}"))?;
        let assertion = match assertion {
            Some(s) => Some(unb64(s, "assertion")?),
            None => None,
        };
        let r = released.entry(batch_hash(&batch)).or_insert(Released {
            batch,
            assertions: Vec::new(),
        });
        if let Some(a) = assertion.filter(|a| !r.assertions.contains(a)) {
            r.assertions.push(a);
        }
    }
    Ok(released)
}

// ── checks that need no re-execution ─────────────────────────────────────────────

fn static_checks(d: &Decoded, o: &mut Outcome) -> Result<(), Failure> {
    if d.leaves.len() != d.log.len() {
        return Err(fail(
            Stage::Leaves,
            format!("{} leaves for {} log entries", d.leaves.len(), d.log.len()),
        ));
    }
    if let Some(i) = (0..d.log.len()).find(|&i| merkle::leaf(&d.log[i]) != d.leaves[i]) {
        return Err(Failure {
            log_index: Some(i),
            ..fail(Stage::Leaves, format!("log[{i}] does not hash to leaves[{i}]"))
        });
    }
    for v in &d.verdicts {
        let bad = if v.match_id != d.cfg.match_id {
            Some("names another match")
        } else if !tail_protocol::verify::signed_verdict(v, &d.referee_pk) {
            Some("signature does not verify against referee_pk")
        } else {
            None
        };
        if let Some(why) = bad {
            return Err(Failure {
                verdict_seq: Some(v.seq),
                ..fail(Stage::Signatures, format!("verdict seq {}: {why}", v.seq))
            });
        }
    }
    o.notes.push(format!(
        "{} verdict signatures verify against referee_pk {}",
        d.verdicts.len(),
        short(&d.referee_pk)
    ));
    let suffix = format!(":{}", hex::encode(d.cfg.match_id));
    if !d.alpha.ends_with(&suffix) {
        return Err(fail(
            Stage::Vrf,
            format!("VRF alpha {:?} does not name this match", d.alpha),
        ));
    }
    let vrf_ok = ed25519_dalek::VerifyingKey::from_bytes(&d.vrf_pk).is_ok_and(|k| {
        k.verify_strict(
            d.alpha.as_bytes(),
            &ed25519_dalek::Signature::from_bytes(&d.vrf_signature),
        )
        .is_ok()
    });
    if !vrf_ok {
        return Err(fail(
            Stage::Vrf,
            "VRF signature does not verify over alpha against vrf_pk",
        ));
    }
    o.notes
        .push("VRF signature verifies over alpha; the ring and the action coin derive from it".into());
    Ok(())
}

// ── re-execution ──────────────────────────────────────────────────────────────────

/// One `Batch` or `Rejected` entry of a tick: a batch the engine processed.
#[derive(Clone, Copy)]
struct Occurrence {
    index: usize,
    player: u16,
    seq: u32,
    hash: Hash,
    /// `None` for `Batch`, the `reject_code` for `Rejected`.
    code: Option<u8>,
}

#[derive(Default)]
struct Tally {
    asserted: usize,
    no_key: usize,
    no_assertion: usize,
    withheld: Vec<String>,
}

struct Replay<'a> {
    d: &'a Decoded,
    pos: usize,
    vpos: usize,
    tally: Tally,
    used: BTreeSet<Hash>,
}

impl<'a> Replay<'a> {
    fn new(d: &'a Decoded) -> Self {
        Self {
            d,
            pos: 0,
            vpos: 0,
            tally: Tally::default(),
            used: BTreeSet::new(),
        }
    }

    fn run(mut self, o: &mut Outcome) -> Result<(), Failure> {
        let result = self.calls(o);
        self.report_trust(o);
        result
    }

    fn calls(&mut self, o: &mut Outcome) -> Result<(), Failure> {
        let d = self.d;
        let mut state = self.start(o)?;
        let mut over = false;
        while !over {
            let Some(&LogEntry::Tick {
                tick_no,
                now_ms,
                call_id,
            }) = d.log.get(self.pos)
            else {
                let what = match d.log.get(self.pos) {
                    Some(e) => format!("expected the next Tick, the log has {}", describe(e)),
                    None => "the log ends before a tick reported the match over".into(),
                };
                return Err(Failure {
                    log_index: Some(self.pos),
                    ..fail(Stage::End, what)
                });
            };
            let here = Stage::Tick(tick_no);
            let end = (self.pos + 1..d.log.len())
                .find(|&i| matches!(d.log[i], LogEntry::Tick { .. }))
                .unwrap_or(d.log.len());
            let receipts = receipts_from(&d.log[self.pos + 1..end]);
            let n_receipts = receipts.len();
            let (batches, counts) = self.batches_of(tick_no, self.pos..end)?;
            let input = ReplayTickInput {
                tick_no,
                now_ms,
                call_id,
                batches,
                receipts,
            };
            let at = self.pos;
            let out = replay_tick(state, input).map_err(|e| Failure {
                log_index: Some(at),
                ..fail(here, format!("the engine refuses this tick: {e:?}"))
            })?;
            let verdicts = self.compare(here, &out.log, &out.verdicts)?;
            o.lines.push(
                format!(
                    "tick {tick_no:>4}  +{:>5}.{}s  batches {counts}  rejected {}  receipts {n_receipts}  \
                 log {:>5}  root {}  {verdicts}",
                    now_ms.saturating_sub(d.start_ms) / 1000,
                    now_ms.saturating_sub(d.start_ms) % 1000 / 100,
                    out.rejected.len(),
                    out.state.log_size(),
                    short(&out.state.log_root()),
                )
                .trim_end()
                .to_owned(),
            );
            over = out.over;
            state = out.state;
        }
        self.end(state, o)
    }

    fn start(&mut self, o: &mut Outcome) -> Result<State, Failure> {
        let d = self.d;
        let n = d.players.len();
        let mut devices = Vec::with_capacity(n);
        for (i, acc) in d.players.iter().enumerate() {
            let Some(LogEntry::Enrolled {
                key_hash, attested, ..
            }) = d.log.get(i)
            else {
                return Err(Failure {
                    log_index: Some(i),
                    ..fail(
                        Stage::Start,
                        format!("log[{i}] is not player {i}'s Enrolled entry"),
                    )
                });
            };
            devices.push(ReleasedDevice {
                account_id: acc.clone(),
                key: d.keys[i].map_or(ReleasedKey::Hash(*key_hash), ReleasedKey::Key),
                counter: d.counters[i],
                // The referee's own record of the enrolment; nothing in the bundle can recheck it.
                attested: *attested,
            });
        }
        let call_id = d.verdicts.first().map(|v| v.call_id).ok_or_else(|| Failure {
            verdict_seq: Some(1),
            ..fail(Stage::Start, "the bundle has no verdicts")
        })?;
        let started = init_released(
            d.cfg.clone(),
            devices,
            &d.k_m,
            &d.vrf_signature,
            d.start_ms,
            call_id,
        )
        .map_err(|e| fail(Stage::Start, format!("the engine refuses the match: {e:?}")))?;
        let verdicts = self.compare(Stage::Start, &started.log, &started.verdicts)?;
        o.lines.push(
            format!(
                "start       {n} players  log {:>5}  root {}  {verdicts}",
                started.state.log_size(),
                short(&started.state.log_root()),
            )
            .trim_end()
            .to_owned(),
        );
        Ok(started.state)
    }

    fn end(&mut self, state: State, o: &mut Outcome) -> Result<(), Failure> {
        let d = self.d;
        let receipts = receipts_from(&d.log[self.pos..]);
        let call_id = match d.verdicts.get(self.vpos) {
            Some(v) if matches!(v.body, Verdict::End { .. }) => v.call_id,
            other => {
                return Err(Failure {
                    verdict_seq: other.map(|v| v.seq),
                    ..fail(Stage::End, "the match is over but the next verdict is not End")
                })
            }
        };
        let fin = finish(state, d.alpha.clone(), &d.vrf_signature, call_id, receipts)
            .map_err(|e| fail(Stage::End, format!("the engine refuses to finish: {e:?}")))?;
        let verdicts = self.compare(Stage::End, &fin.log, &fin.verdicts)?;
        if self.pos != d.log.len() {
            return Err(Failure {
                log_index: Some(self.pos),
                ..fail(
                    Stage::End,
                    format!("the log has {} entries after End", d.log.len() - self.pos),
                )
            });
        }
        if let Some(v) = d.verdicts.get(self.vpos) {
            return Err(Failure {
                verdict_seq: Some(v.seq),
                ..fail(Stage::End, "the bundle has verdicts after End")
            });
        }
        o.lines.push(format!(
            "end         log {:>5}  root {}  {verdicts}",
            d.log.len(),
            short(&merkle::root(&d.leaves)),
        ));
        o.notes.push(format!(
            "re-executed {} log entries and {} verdicts: all identical; final root {}",
            d.log.len(),
            d.verdicts.len(),
            hex::encode(merkle::root(&d.leaves)),
        ));
        let unused = d.released.keys().filter(|h| !self.used.contains(*h)).count();
        if unused > 0 {
            o.notes.push(format!(
                "{unused} released batches appear in no Batch or Rejected entry"
            ));
        }
        Ok(())
    }

    /// The engine's new entries and verdicts must be the bundle's next ones, byte for byte.
    fn compare(
        &mut self,
        stage: Stage,
        log: &[LogEntry],
        verdicts: &[VerdictPayload],
    ) -> Result<String, Failure> {
        let d = self.d;
        for e in log {
            match d.log.get(self.pos) {
                Some(have) if have == e => self.pos += 1,
                have => {
                    let what = match have {
                        Some(h) => format!(
                            "log[{}]: the bundle has {}, re-execution gives {}",
                            self.pos,
                            describe(h),
                            describe(e)
                        ),
                        None => format!(
                            "log[{}]: the bundle's log ends, re-execution gives {}",
                            self.pos,
                            describe(e)
                        ),
                    };
                    return Err(Failure {
                        log_index: Some(self.pos),
                        ..fail(stage, what)
                    });
                }
            }
        }
        let mut names = Vec::new();
        for v in verdicts {
            match d.verdicts.get(self.vpos) {
                Some(have) if verdict_digest(&have.payload()) == verdict_digest(v) => self.vpos += 1,
                have => {
                    let what = match have {
                        Some(h) => format!(
                            "verdict seq {}: the bundle has {}, re-execution gives {}",
                            v.seq,
                            describe_verdict(&h.payload(), &d.players),
                            describe_verdict(v, &d.players)
                        ),
                        None => format!("the bundle has no verdict seq {}", v.seq),
                    };
                    return Err(Failure {
                        verdict_seq: Some(v.seq),
                        ..fail(stage, what)
                    });
                }
            }
            names.push(describe_body(&v.body, &d.players));
        }
        Ok(if names.is_empty() {
            String::new()
        } else {
            format!("[{}]", names.join(", "))
        })
    }

    /// The batches one tick processed, in an input order that gives the logged results. The
    /// engine sorts by (player, seq) and keeps the input order within one pair, which matters
    /// only when one tick holds several batches with the same pair (a resend, a duplicate).
    /// Of those, at most one passes authentication; the others are logged in input order,
    /// before it with any code but `SEQ` and after it with `SEQ` (its seq is used up). So the one
    /// that passed goes right before the first `SEQ` refusal of its pair.
    fn batches_of(
        &mut self,
        tick_no: u32,
        range: std::ops::Range<usize>,
    ) -> Result<(Vec<ReplayBatch>, String), Failure> {
        let d = self.d;
        let mut groups: BTreeMap<(u16, u32), (Vec<Occurrence>, Vec<Occurrence>)> = BTreeMap::new();
        for index in range {
            let (player, seq, hash, code) = match d.log[index] {
                LogEntry::Batch { player, seq, hash } => (player, seq, hash, None),
                LogEntry::Rejected {
                    player,
                    seq,
                    hash,
                    code,
                } => (player, seq, hash, Some(code)),
                _ => continue,
            };
            let occ = Occurrence {
                index,
                player,
                seq,
                hash,
                code,
            };
            let g = groups.entry((player, seq)).or_default();
            if code.is_some_and(Reject::is_authenticity_code) {
                g.0.push(occ);
            } else {
                g.1.push(occ);
            }
        }
        let mut items = Vec::new();
        let (mut asserted, mut unasserted, mut withheld) = (0, 0, 0);
        for (refused, passed) in groups.into_values() {
            let cut = refused
                .iter()
                .position(|o| o.code == Some(reject_code::SEQ))
                .unwrap_or(refused.len());
            let ordered = refused[..cut].iter().chain(&passed).chain(&refused[cut..]);
            for occ in ordered {
                let item = self.item(tick_no, occ)?;
                match &item {
                    ReplayBatch::Asserted(_) => asserted += 1,
                    ReplayBatch::Unasserted { .. } => unasserted += 1,
                    ReplayBatch::Withheld { .. } => withheld += 1,
                }
                items.push(item);
            }
        }
        let counts = format!(
            "{:>3} ({asserted} asserted, {unasserted} unasserted, {withheld} withheld)",
            items.len()
        );
        Ok((items, counts))
    }

    fn item(&mut self, tick_no: u32, occ: &Occurrence) -> Result<ReplayBatch, Failure> {
        let d = self.d;
        let Some(r) = d.released.get(&occ.hash) else {
            return match occ.code {
                Some(code) => {
                    self.tally.withheld.push(format!(
                        "tick {tick_no} player {} seq {} {}",
                        occ.player,
                        occ.seq,
                        reject_name(code)
                    ));
                    Ok(ReplayBatch::Withheld {
                        player: occ.player,
                        seq: occ.seq,
                        hash: occ.hash,
                        code,
                    })
                }
                None => Err(Failure {
                    log_index: Some(occ.index),
                    ..fail(
                        Stage::Tick(tick_no),
                        format!(
                            "log[{}] accepts batch {} (player {} seq {}), and no released batch hashes to it",
                            occ.index,
                            short(&occ.hash),
                            occ.player,
                            occ.seq
                        ),
                    )
                }),
            };
        };
        self.used.insert(occ.hash);
        let assertion_ok = occ.code != Some(reject_code::ASSERTION);
        let key = d.keys.get(r.batch.player as usize).copied().flatten();
        let chosen =
            key.and_then(|k| pick_assertion(&r.batch, &r.assertions, &k, &d.cfg.app_id, assertion_ok));
        if let Some(assertion) = chosen {
            self.tally.asserted += 1;
            return Ok(ReplayBatch::Asserted(BatchEnvelope {
                batch: r.batch.clone(),
                assertion,
            }));
        }
        if key.is_none() {
            self.tally.no_key += 1;
        } else {
            self.tally.no_assertion += 1;
        }
        Ok(ReplayBatch::Unasserted {
            batch: r.batch.clone(),
            assertion_ok,
        })
    }

    fn report_trust(&self, o: &mut Outcome) {
        let d = self.d;
        let t = &self.tally;
        let missing_keys: Vec<&str> = d
            .players
            .iter()
            .zip(&d.keys)
            .filter(|(_, k)| k.is_none())
            .map(|(p, _)| p.as_str())
            .collect();
        if !missing_keys.is_empty() {
            o.trusted.push(format!(
                "no App Attest key (devices[].appAttestPk) for {}: their Enrolled key hashes come from the log",
                missing_keys.join(", ")
            ));
        }
        if t.no_key + t.no_assertion > 0 {
            let why = match (t.no_key > 0, d.have_assertions) {
                (true, false) => "no device key and no assertions[] in the bundle",
                (true, true) => "no device key for their player",
                (false, false) => "no assertions[] in the bundle",
                (false, true) => "no assertion released for them",
            };
            o.trusted.push(format!(
                "{} batch occurrences ran without App Attest ({why}): the assertion outcome is the \
                 log's; each batch still hashes to its logged entry and passes every other check",
                t.no_key + t.no_assertion
            ));
        }
        if !t.withheld.is_empty() {
            let shown: Vec<&str> = t.withheld.iter().take(8).map(String::as_str).collect();
            let more = t.withheld.len().saturating_sub(shown.len());
            o.trusted.push(format!(
                "{} refused batches were not released, so their logged reasons stand: {}{}",
                t.withheld.len(),
                shown.join("; "),
                if more > 0 {
                    format!("; and {more} more")
                } else {
                    String::new()
                }
            ));
        }
        if t.asserted > 0 {
            o.notes.push(format!(
                "{} batch occurrences re-checked with App Attest against the device keys (app id {})",
                t.asserted, d.cfg.app_id
            ));
        }
    }
}

/// The released assertion to re-check a batch with. With several (a resend that carried a new
/// one), the one whose signature and app id agree with the logged outcome; the counter is left
/// to the engine.
fn pick_assertion(
    b: &Batch,
    cands: &[Vec<u8>],
    key: &[u8; 65],
    app_id: &str,
    want_ok: bool,
) -> Option<Vec<u8>> {
    if cands.len() <= 1 {
        return cands.first().cloned();
    }
    let Ok(k) = appattest::public_key(key) else {
        return cands.first().cloned();
    };
    let cdh = batch_client_data_hash(b);
    cands
        .iter()
        .find(|a| appattest::verify_assertion(&k, a, &cdh, app_id, 0).is_ok() == want_ok)
        .or(cands.first())
        .cloned()
}

fn receipts_from(entries: &[LogEntry]) -> Vec<HintReceipt> {
    entries
        .iter()
        .map_while(|e| match e {
            LogEntry::HintReceipt {
                hint_id,
                chat_id,
                text_hash,
                signature,
                signing_address,
                ..
            } => Some(HintReceipt {
                hint_id: *hint_id,
                chat_id: chat_id.clone(),
                text_hash: *text_hash,
                signature: signature.clone(),
                signing_address: signing_address.clone(),
            }),
            _ => None,
        })
        .collect()
}

// ── text ──────────────────────────────────────────────────────────────────────────

fn short(h: &[u8]) -> String {
    hex::encode(&h[..h.len().min(6)])
}

fn reject_name(code: u8) -> String {
    let name = match code {
        reject_code::UNKNOWN_PLAYER => "UNKNOWN_PLAYER",
        reject_code::WRONG_MATCH => "WRONG_MATCH",
        reject_code::PLAYER_OUT => "PLAYER_OUT",
        reject_code::SEQ => "SEQ",
        reject_code::PREV => "PREV",
        reject_code::ASSERTION => "ASSERTION",
        reject_code::CLOCK_SKEW => "CLOCK_SKEW",
        reject_code::FIX_FLAGS => "FIX_FLAGS",
        reject_code::FIX_ORDER => "FIX_ORDER",
        reject_code::TELEPORT => "TELEPORT",
        reject_code::TIME_ORDER => "TIME_ORDER",
        reject_code::TOO_OLD => "TOO_OLD",
        _ => return format!("code {code}"),
    };
    name.into()
}

/// An entry for a person, with its leaf: two entries that differ only in their salt (which
/// follows the leaf index) show different leaves.
fn describe(e: &LogEntry) -> String {
    let text = match e {
        LogEntry::Batch { player, seq, hash } => {
            format!("Batch(player {player}, seq {seq}, {})", short(hash))
        }
        LogEntry::Contact { a, b, epoch, .. } => format!("Contact({a}-{b}, epoch {epoch})"),
        LogEntry::Verdict { seq, digest } => format!("Verdict(seq {seq}, {})", short(digest)),
        LogEntry::HintReceipt { hint_id, .. } => format!("HintReceipt(hint {hint_id})"),
        LogEntry::Tick { tick_no, now_ms, .. } => format!("Tick({tick_no}, now_ms {now_ms})"),
        LogEntry::Rejected {
            player,
            seq,
            hash,
            code,
        } => format!(
            "Rejected(player {player}, seq {seq}, {}, {})",
            short(hash),
            reject_name(*code)
        ),
        LogEntry::Evidence {
            hunter,
            target,
            strike_seq,
            epochs,
            ..
        } => format!("Evidence({hunter}→{target}, strike seq {strike_seq}, epochs {epochs:?})"),
        LogEntry::Enrolled { player, account, .. } => format!("Enrolled({player} {account})"),
    };
    format!("{text} leaf {}", short(&merkle::leaf(e)))
}

/// Players by name: index `i` is the i-th account in byte order.
fn describe_body(v: &Verdict, names: &[String]) -> String {
    let name = |i: &u16| {
        names
            .get(usize::from(*i))
            .cloned()
            .unwrap_or_else(|| format!("#{i}"))
    };
    match v {
        Verdict::Start { .. } => "Start".into(),
        Verdict::Hint { from, amount, .. } => format!("Hint by {} {amount}", name(from)),
        Verdict::Tag { hunter, target, .. } => format!("Tag {}→{}", name(hunter), name(target)),
        Verdict::Forfeit { player, to, .. } => format!("Forfeit {}→{}", name(player), name(to)),
        Verdict::Checkpoint { log_size, root } => format!("Checkpoint {log_size} {}", short(root)),
        Verdict::End { log_size, root, .. } => format!("End {log_size} {}", short(root)),
    }
}

fn describe_verdict(v: &VerdictPayload, names: &[String]) -> String {
    format!(
        "seq {} {} (prev {}, digest {})",
        v.seq,
        describe_body(&v.body, names),
        short(&v.prev),
        short(&verdict_digest(v))
    )
}
