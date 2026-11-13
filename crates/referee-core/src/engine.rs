//! `init`, `tick` and `finish`. Each tick runs in a fixed order so its output depends only on
//! its inputs: receipts → batch authenticity → batch validity and ingestion → contacts →
//! deferred strikes → actions (strikes, hints) → dark rules → end check → checkpoint → HUDs →
//! pruning.
// Millisecond spans and metre distances stay far below 2^52, so the f64 conversions are exact
// where it matters, and speeds converted back are never negative.
#![allow(clippy::cast_precision_loss, clippy::cast_sign_loss)]

use crate::geo::{bearing8, distance, Plane, Point};
use crate::log::Log;
use crate::state::{Contact, DeferredStrike, EpochData, Heard, Phase, Player, Secrets, State, StoredFix};
use crate::types::{
    ActionKind, Device, FinishError, Finished, HintIssued, HintReceipt, InitError, MatchConfig, Refusal,
    Refuse, Reject, Rejection, Started, TickError, TickInput, TickOutput,
};
use crate::{
    COIN_DOMAIN, DARK_GRACE_MS, KEEP_EPOCHS, MAX_DURATION_MS, MAX_PLAYERS, MIN_PLAYERS, PRESENCE_ACC_M,
    RECEIPT_WINDOW_MS, TREND_SAME_M,
};
use std::collections::BTreeMap;
use tail_protocol::beacon::{beacon_token, derive_player_key, derive_tag_key, epoch_at};
use tail_protocol::digest::{batch_client_data_hash, batch_hash, sha256, verdict_digest};
use tail_protocol::{
    constants::{hint_kind, target_status},
    hint_price, ring, Action, Batch, BatchEnvelope, CallId, Fix, GridCell, Hash, HintFact, Hud, LogEntry,
    PlayerKeys, Token, Verdict, VerdictPayload, CHECKPOINT_MS, CLOCK_SKEW_MS, DARK_FORFEIT_MS, DARK_LEAK_MS,
    EPOCH_MS, FIX_WINDOW_MS, GEO_SLACK_M, HINT_COOLDOWN_MS, HINT_NEAR_M, HINT_TEXT_MAX, HINT_TREND_MS,
    LEAK_CELL_M, LOCK_EPOCHS, MAX_ACC_M, MAX_SPEED_MPS, MIN_SAMPLES, RSSI_MIN_DBM, TELEPORT_MPS,
    VEHICLE_FREEZE_MS, VEHICLE_HOLD_MS, WINDOW_EPOCHS,
};

/// What one call produces besides the state.
struct Out {
    call_id: CallId,
    verdicts: Vec<VerdictPayload>,
    log: Vec<LogEntry>,
}

impl Out {
    fn new(call_id: CallId) -> Self {
        Self {
            call_id,
            verdicts: Vec::new(),
            log: Vec::new(),
        }
    }
}

/// An action from a valid batch, waiting for the tick's ordering.
struct Pending {
    t_ms: u64,
    player: u16,
    seq: u32,
    index: usize,
    action: Action,
}

// ── init ───────────────────────────────────────────────────────────────────────────

/// Starts a match. Players are indexed by their account id's position in sorted order (the
/// order of `players_hash`), whatever order `devices` arrives in.
pub fn init(
    cfg: MatchConfig,
    mut devices: Vec<Device>,
    k_m: &[u8; 32],
    vrf_signature: &[u8; 64],
    start_ms: u64,
    call_id: CallId,
) -> Result<Started, InitError> {
    let n = devices.len();
    if !(MIN_PLAYERS..=MAX_PLAYERS).contains(&n) {
        return Err(InitError::PlayerCount(n));
    }
    if cfg.stake == 0 {
        return Err(InitError::ZeroStake);
    }
    if cfg.duration_ms == 0 || cfg.duration_ms > MAX_DURATION_MS {
        return Err(InitError::Duration(cfg.duration_ms));
    }
    if cfg.zone.radius_m == 0 {
        return Err(InitError::EmptyZone);
    }
    let end_ms = start_ms
        .checked_add(cfg.duration_ms)
        .ok_or(InitError::TimeOverflow)?;
    // Every per-player head and the sum of all of them must fit, so money never overflows.
    if cfg.stake.checked_mul(n as u128).is_none() {
        return Err(InitError::StakeOverflow);
    }
    devices.sort_by(|a, b| a.account_id.cmp(&b.account_id));
    if let Some(w) = devices.windows(2).find(|w| w[0].account_id == w[1].account_id) {
        return Err(InitError::DuplicateAccount(w[0].account_id.clone()));
    }
    for d in &devices {
        appattest::public_key(&d.key).map_err(|_| InitError::BadDeviceKey(d.account_id.clone()))?;
    }
    let accounts: Vec<String> = devices.iter().map(|d| d.account_id.clone()).collect();
    let index =
        |acc: &String| -> u16 { accounts.binary_search(acc).expect("ring holds the same ids") as u16 };
    let ring_order = ring::build_ring(&accounts, vrf_signature);
    let mut targets = vec![None; n];
    for (k, hunter) in ring_order.iter().enumerate() {
        targets[index(hunter) as usize] = Some(index(&ring_order[(k + 1) % n]));
    }

    let k_tag = derive_tag_key(k_m);
    let k_players: Vec<[u8; 32]> = (0..n).map(|i| derive_player_key(k_m, i as u16)).collect();
    let players = devices
        .into_iter()
        .zip(&targets)
        .map(|(d, &target)| Player::new(d, target, cfg.stake, start_ms))
        .collect::<Vec<_>>();

    let keys = players
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let target = p.target.map(|t| accounts[t as usize].clone()).unwrap_or_default();
            (
                i as u16,
                PlayerKeys {
                    match_id: cfg.match_id,
                    player: i as u16,
                    start_ms,
                    end_ms,
                    k_tag,
                    k_player: k_players[i],
                    target,
                },
            )
        })
        .collect();

    let mut st = State {
        plane: Plane::new(cfg.zone.lat_e7, cfg.zone.lon_e7),
        cfg,
        start_ms,
        end_ms,
        secrets: Secrets {
            k_tag,
            k_players,
            vrf_signature: *vrf_signature,
        },
        ring_commit: ring::ring_commit(vrf_signature),
        players,
        contacts: Vec::new(),
        // The contract starts at last_seq = 0 and accepts only last + 1.
        next_verdict_seq: 1,
        log: Log::default(),
        next_checkpoint_ms: start_ms + CHECKPOINT_MS,
        next_hint_id: 0,
        pending_receipts: Vec::new(),
        deferred: Vec::new(),
        last_tick: None,
        phase: Phase::Running,
    };
    let mut out = Out::new(call_id);
    let start = Verdict::Start {
        players_hash: ring::players_hash(&accounts),
        ring_commit: st.ring_commit,
        start_ms,
        end_ms,
    };
    st.verdict(&mut out, start);
    Ok(Started {
        state: st,
        verdicts: out.verdicts,
        log: out.log,
        keys,
    })
}

// ── tick ───────────────────────────────────────────────────────────────────────────

pub fn tick(mut st: State, input: TickInput) -> Result<TickOutput, TickError> {
    if st.phase != Phase::Running {
        return Err(TickError::NotRunning);
    }
    if input.now_ms < st.start_ms {
        return Err(TickError::BeforeStart {
            now_ms: input.now_ms,
            start_ms: st.start_ms,
        });
    }
    if let Some((last, last_ms)) = st.last_tick {
        if input.tick_no <= last {
            return Err(TickError::StaleTick {
                last,
                got: input.tick_no,
            });
        }
        if input.now_ms < last_ms {
            return Err(TickError::ClockWentBack {
                last_ms,
                now_ms: input.now_ms,
            });
        }
    }
    let total_before = st.total_heads();
    let TickInput {
        tick_no,
        now_ms: now,
        call_id,
        batches,
        receipts,
    } = input;
    st.last_tick = Some((tick_no, now));
    // Past the end only the end matters; clamping also keeps every epoch small (init bounds the
    // duration), so epoch arithmetic cannot overflow.
    let cur = st
        .epoch(now.min(st.end_ms))
        .expect("start ≤ now and the duration is bounded");
    let mut out = Out::new(call_id);
    let mut rejected = Vec::new();
    let mut refused = Vec::new();

    st.log_receipts(&mut out, receipts, now);

    let authentic = st.authenticate_all(batches, &mut rejected);
    let table = st.token_table(cur);
    let mut pending = Vec::new();
    // Authentic batches come sorted by player and seq, so each check sees the time of the
    // player's previous accepted batch, including one accepted earlier in this tick.
    for b in authentic {
        match st.check(&b, now, cur) {
            Ok(()) => st.ingest(&b, now, cur, &table, &mut out, &mut pending),
            Err(reason) => rejected.push(Rejection {
                player: b.player,
                seq: b.seq,
                reason,
            }),
        }
    }

    st.find_contacts(cur, &mut out);
    let mut facts = vec![None; st.players.len()];
    let hints = st.run_actions(tick_no, pending, now, cur, &mut out, &mut refused, &mut facts);
    st.dark_rules(now, cur, &mut out);

    let over = now >= st.end_ms || st.alive_count() <= 1;
    if over {
        st.phase = Phase::Over;
        // No tick follows, so a strike still waiting gets its answer now.
        for d in std::mem::take(&mut st.deferred) {
            let reason = st
                .judge_strike(d.player, d.t_ms)
                .err()
                .unwrap_or(Refuse::MatchOver);
            refused.push(Refusal {
                player: d.player,
                nonce: d.nonce,
                action: ActionKind::Strike,
                reason,
            });
        }
    } else if now >= st.next_checkpoint_ms {
        let cp = Verdict::Checkpoint {
            log_size: st.log.size(),
            root: st.log.root(),
        };
        st.verdict(&mut out, cp);
        st.next_checkpoint_ms = st.start_ms + ((now - st.start_ms) / CHECKPOINT_MS + 1) * CHECKPOINT_MS;
    }
    let huds = st.huds(tick_no, now, cur, &facts);
    st.prune(cur);
    debug_assert_eq!(st.total_heads(), total_before, "heads only move");
    Ok(TickOutput {
        state: st,
        verdicts: out.verdicts,
        huds,
        log: out.log,
        rejected,
        refused,
        hints,
        over,
    })
}

// ── finish ─────────────────────────────────────────────────────────────────────────

/// Ends a match after the tick that reported `over`. Receipts for hints of the last tick can
/// still join the log here, before the End root is taken.
pub fn finish(
    mut st: State,
    alpha: String,
    vrf_signature: &[u8; 64],
    call_id: CallId,
    receipts: Vec<HintReceipt>,
) -> Result<Finished, FinishError> {
    match st.phase {
        Phase::Running => return Err(FinishError::NotOver),
        Phase::Ended => return Err(FinishError::AlreadyEnded),
        Phase::Over => {}
    }
    if ring::ring_commit(vrf_signature) != st.ring_commit || *vrf_signature != st.secrets.vrf_signature {
        return Err(FinishError::VrfMismatch);
    }
    let mut out = Out::new(call_id);
    let now = st.last_tick.map_or(st.start_ms, |(_, t)| t);
    st.log_receipts(&mut out, receipts, now);
    let end = Verdict::End {
        alpha,
        vrf_signature: *vrf_signature,
        log_size: st.log.size(),
        root: st.log.root(),
    };
    st.verdict(&mut out, end);
    st.phase = Phase::Ended;
    Ok(Finished {
        state: st,
        verdicts: out.verdicts,
        log: out.log,
    })
}

// ── helpers ────────────────────────────────────────────────────────────────────────

fn epoch_mid_ms(start_ms: u64, epoch: u32) -> u64 {
    start_ms + u64::from(epoch) * EPOCH_MS + EPOCH_MS / 2
}

fn stored(f: &Fix) -> StoredFix {
    StoredFix {
        t_ms: f.t_ms,
        lat_e7: f.lat_e7,
        lon_e7: f.lon_e7,
        acc_m: f.acc_m,
    }
}

fn pair(a: u16, b: u16) -> (u16, u16) {
    if a < b {
        (a, b)
    } else {
        (b, a)
    }
}

impl State {
    fn epoch(&self, t_ms: u64) -> Option<u32> {
        epoch_at(t_ms, self.start_ms)
    }

    fn point(&self, f: &StoredFix) -> Point {
        self.plane.point(f.lat_e7, f.lon_e7)
    }

    fn alive_count(&self) -> usize {
        self.players.iter().filter(|p| p.alive()).count()
    }

    fn hunter_of(&self, p: u16) -> Option<u16> {
        self.players
            .iter()
            .position(|q| q.alive() && q.target == Some(p))
            .map(|i| i as u16)
    }

    fn append(&mut self, out: &mut Out, e: LogEntry) {
        self.log.push(&e);
        out.log.push(e);
    }

    fn verdict(&mut self, out: &mut Out, body: Verdict) {
        let payload = VerdictPayload {
            match_id: self.cfg.match_id,
            seq: self.next_verdict_seq,
            call_id: out.call_id,
            body,
        };
        self.next_verdict_seq += 1;
        let digest = verdict_digest(&payload);
        self.append(
            out,
            LogEntry::Verdict {
                seq: payload.seq,
                digest,
            },
        );
        out.verdicts.push(payload);
    }

    fn log_receipts(&mut self, out: &mut Out, receipts: Vec<HintReceipt>, now: u64) {
        self.pending_receipts
            .retain(|&(_, issued)| now.saturating_sub(issued) <= RECEIPT_WINDOW_MS);
        for r in receipts {
            // Only a hint this referee issued, once: the relay cannot pad the log.
            if let Some(i) = self.pending_receipts.iter().position(|&(id, _)| id == r.hint_id) {
                self.pending_receipts.remove(i);
                let entry = LogEntry::HintReceipt {
                    hint_id: r.hint_id,
                    chat_id: r.chat_id,
                    text_hash: r.text_hash,
                    signature: r.signature,
                    signing_address: r.signing_address,
                };
                self.append(out, entry);
            }
        }
    }

    // ── batch authenticity (4.3): match, seq, prev, App Attest ──────────────────────

    fn authenticate_all(
        &mut self,
        mut envs: Vec<BatchEnvelope>,
        rejected: &mut Vec<Rejection>,
    ) -> Vec<Batch> {
        envs.sort_by_key(|e| (e.batch.player, e.batch.seq));
        let mut ok = Vec::new();
        for env in envs {
            match self.authenticate(&env) {
                Ok(()) => ok.push(env.batch),
                Err(reason) => rejected.push(Rejection {
                    player: env.batch.player,
                    seq: env.batch.seq,
                    reason,
                }),
            }
        }
        ok
    }

    /// The cheap chain checks run first and nothing changes unless all pass, so a batch rejected
    /// for a seq gap can be resubmitted in order without burning its assertion counter.
    fn authenticate(&mut self, env: &BatchEnvelope) -> Result<(), Reject> {
        let b = &env.batch;
        if b.match_id != self.cfg.match_id {
            return Err(Reject::WrongMatch);
        }
        let app_id = &self.cfg.app_id;
        let p = self
            .players
            .get_mut(b.player as usize)
            .ok_or(Reject::UnknownPlayer)?;
        if !p.alive() {
            return Err(Reject::PlayerOut);
        }
        if b.seq != p.next_seq {
            return Err(Reject::Seq {
                expected: p.next_seq,
                got: b.seq,
            });
        }
        if b.prev != p.prev {
            return Err(Reject::Prev);
        }
        let key = appattest::public_key(&p.key).map_err(|e| Reject::Assertion(e.step))?;
        let counter = appattest::verify_assertion(
            &key,
            &env.assertion,
            &batch_client_data_hash(b),
            app_id,
            p.counter,
        )
        .map_err(|e| Reject::Assertion(e.step))?;
        p.counter = counter;
        p.next_seq = b.seq.saturating_add(1);
        p.prev = batch_hash(b);
        Ok(())
    }

    // ── batch validity (4.3): clock, order, age, flags, fix order, teleport ─────────

    /// A batch may arrive late (a reconnect backlog, or carried by another phone) but never
    /// from the future. Lateness is not a clock error, so an old batch is still valid while it
    /// keeps its player's batch times in order and falls inside the kept evidence; it only
    /// cannot make its player present (`ingest`). Each player's clock is judged on its own
    /// against the referee clock, so one player's clock can never move another's window.
    fn check(&self, b: &Batch, now: u64, cur: u32) -> Result<(), Reject> {
        if b.t_ms > now.saturating_add(CLOCK_SKEW_MS) {
            return Err(Reject::ClockSkew {
                t_ms: b.t_ms,
                now_ms: now,
            });
        }
        let p = &self.players[b.player as usize];
        if let Some(last) = p.last_batch_t.filter(|&l| b.t_ms < l) {
            return Err(Reject::BatchOrder {
                t_ms: b.t_ms,
                last_ms: last,
            });
        }
        let oldest = self.start_ms + u64::from(cur.saturating_sub(KEEP_EPOCHS)) * EPOCH_MS;
        if b.t_ms < oldest {
            return Err(Reject::TooOld {
                t_ms: b.t_ms,
                oldest_ms: oldest,
            });
        }
        let flags = b.fixes.iter().fold(0u8, |acc, f| acc | f.flags);
        if flags != 0 {
            return Err(Reject::FixFlags { flags });
        }
        let mut last_t = p.last_fix_t;
        for f in &b.fixes {
            if f.t_ms > b.t_ms || last_t.is_some_and(|l| f.t_ms <= l) {
                return Err(Reject::FixOrder);
            }
            last_t = Some(f.t_ms);
        }
        let mut prev = p.last_fix;
        for f in b.fixes.iter().filter(|f| f.acc_m <= MAX_ACC_M).map(stored) {
            if let Some(r) = prev {
                // Distance both accuracies cannot explain, over at least one second.
                let excess =
                    distance(self.point(&r), self.point(&f)) - f64::from(r.acc_m) - f64::from(f.acc_m);
                let dt_s = ((f.t_ms - r.t_ms) as f64 / 1000.0).max(1.0);
                let mps = excess.max(0.0) / dt_s;
                if mps > TELEPORT_MPS {
                    return Err(Reject::Teleport {
                        cmps: (mps * 100.0) as u64,
                    });
                }
            }
            prev = Some(f);
        }
        Ok(())
    }

    // ── ingestion ───────────────────────────────────────────────────────────────────

    /// Every token any live player can have advertised in the kept epochs, so a sighting
    /// resolves with one lookup instead of one HMAC per player.
    fn token_table(&self, cur: u32) -> BTreeMap<Token, (u16, u32)> {
        let mut t = BTreeMap::new();
        for e in cur.saturating_sub(KEEP_EPOCHS)..=cur + 2 {
            for (i, p) in self.players.iter().enumerate() {
                if p.alive() {
                    let tok = beacon_token(&self.secrets.k_tag, &self.secrets.k_players[i], e);
                    t.insert(tok, (i as u16, e));
                }
            }
        }
        t
    }

    fn ingest(
        &mut self,
        b: &Batch,
        now: u64,
        cur: u32,
        table: &BTreeMap<Token, (u16, u32)>,
        out: &mut Out,
        pending: &mut Vec<Pending>,
    ) {
        let keep_from = cur.saturating_sub(KEEP_EPOCHS);
        let horizon = cur + 2;
        let pi = b.player as usize;
        let mut last_placed = None;
        for f in &b.fixes {
            self.players[pi].last_fix_t = Some(f.t_ms);
            if f.acc_m > PRESENCE_ACC_M {
                continue;
            }
            let sf = stored(f);
            last_placed = Some(sf);
            // Fine enough to place the player in the zone, not to prove contact.
            if f.acc_m > MAX_ACC_M {
                continue;
            }
            self.vehicle(pi, f);
            self.players[pi].last_fix = Some(sf);
            self.assign_fix(pi, sf, keep_from, horizon);
        }
        self.players[pi].last_batch_t = Some(b.t_ms);
        // Only a batch about now says where the player is now. A late one still counts as
        // evidence, but a phone whose clock runs far behind must not stay present while its
        // tokens sit in epochs no hunter's phone accepts.
        let fresh = b.t_ms.saturating_add(CLOCK_SKEW_MS) >= now;
        if fresh && last_placed.is_some_and(|f| self.in_zone(&f)) {
            self.players[pi].present_ms = now;
        }
        if let Some(eb) = self.epoch(b.t_ms) {
            // One count per token per batch: listing a token twice must not double its samples.
            let mut seen: BTreeMap<Token, (u16, u32, u8)> = BTreeMap::new();
            for s in &b.sightings {
                // The phone's epoch must fit the batch time, and the token's epoch the phone's:
                // a token recorded earlier and replayed later resolves to an epoch too old.
                if s.epoch.abs_diff(eb) > 1 || s.rssi_max < RSSI_MIN_DBM {
                    continue;
                }
                let Some(&(j, e)) = table.get(&s.token) else {
                    continue;
                };
                if j == b.player || e.abs_diff(s.epoch) > 1 || e < keep_from || e > horizon {
                    continue;
                }
                let n = &mut seen.entry(s.token).or_insert((j, e, 0)).2;
                *n = (*n).max(s.n);
            }
            for (j, e, n) in seen.into_values() {
                let slot = slot(&mut self.players[pi].epochs, e);
                match slot.heard.iter_mut().find(|h| h.player == j) {
                    Some(h) => h.n = h.n.saturating_add(n),
                    None => slot.heard.push(Heard { player: j, n }),
                }
            }
        }
        self.append(
            out,
            LogEntry::Batch {
                player: b.player,
                seq: b.seq,
                hash: batch_hash(b),
            },
        );
        pending.extend(b.actions.iter().enumerate().map(|(index, a)| Pending {
            t_ms: b.t_ms,
            player: b.player,
            seq: b.seq,
            index,
            action: a.clone(),
        }));
    }

    /// Keeps, per epoch, the usable fix nearest its midpoint (ties keep the earlier fix).
    fn assign_fix(&mut self, pi: usize, f: StoredFix, keep_from: u32, horizon: u32) {
        let Some(ef) = self.epoch(f.t_ms) else {
            return;
        };
        let start = self.start_ms;
        for e in ef.saturating_sub(1)..=ef.saturating_add(1) {
            if e < keep_from || e > horizon {
                continue;
            }
            let off = f.t_ms.abs_diff(epoch_mid_ms(start, e));
            if off > FIX_WINDOW_MS {
                continue;
            }
            let s = slot(&mut self.players[pi].epochs, e);
            if s.fix
                .is_none_or(|old| off < old.t_ms.abs_diff(epoch_mid_ms(start, e)))
            {
                s.fix = Some(f);
            }
        }
    }

    /// Faster than `MAX_SPEED_MPS` for `VEHICLE_HOLD_MS` freezes contact from the start of the
    /// run until `VEHICLE_FREEZE_MS` after its latest fast fix.
    fn vehicle(&mut self, pi: usize, f: &Fix) {
        let p = &mut self.players[pi];
        if f64::from(f.speed_cmps) / 100.0 <= MAX_SPEED_MPS {
            p.fast_since = None;
            return;
        }
        let since = *p.fast_since.get_or_insert(f.t_ms);
        if f.t_ms - since < VEHICLE_HOLD_MS {
            return;
        }
        let until = f.t_ms.saturating_add(VEHICLE_FREEZE_MS);
        match p.freezes.last_mut() {
            Some((from, u)) if *u >= since => {
                *from = (*from).min(since);
                *u = (*u).max(until);
            }
            _ => p.freezes.push((since, until)),
        }
    }

    /// Out only when even the far edge of the accuracy circle is outside: GPS noise at the
    /// boundary must not count as leaving.
    fn in_zone(&self, f: &StoredFix) -> bool {
        let z = self.cfg.zone;
        let d = distance(self.point(f), self.plane.point(z.lat_e7, z.lon_e7));
        d - f64::from(f.acc_m) <= f64::from(z.radius_m)
    }

    fn in_safehouse(&self, f: &StoredFix) -> bool {
        let p = self.point(f);
        self.cfg
            .safehouses
            .iter()
            .any(|s| distance(p, self.plane.point(s.lat_e7, s.lon_e7)) <= f64::from(s.radius_m))
    }

    fn frozen(&self, pi: usize, t_ms: u64) -> bool {
        self.players[pi]
            .freezes
            .iter()
            .any(|&(from, until)| from <= t_ms && t_ms < until)
    }

    // ── contact (4.5) ───────────────────────────────────────────────────────────────

    fn epoch_data(&self, pi: usize, e: u32) -> Option<&EpochData> {
        let eps = &self.players[pi].epochs;
        eps.binary_search_by_key(&e, |d| d.epoch).ok().map(|i| &eps[i])
    }

    fn has_contact(&self, a: u16, b: u16, e: u32) -> bool {
        let (a, b) = pair(a, b);
        self.contacts.binary_search(&Contact { epoch: e, a, b }).is_ok()
    }

    /// contact(a, b, e): each phone heard the other's epoch-e token often and strongly enough,
    /// both fixes near the epoch midpoint agree, and neither is in a safehouse or frozen.
    fn contact_holds(&self, a: usize, b: usize, e: u32) -> bool {
        let (Some(da), Some(db)) = (self.epoch_data(a, e), self.epoch_data(b, e)) else {
            return false;
        };
        let heard = |d: &EpochData, who: usize| {
            d.heard
                .iter()
                .any(|h| h.player as usize == who && h.n >= MIN_SAMPLES)
        };
        if !heard(da, b) || !heard(db, a) {
            return false;
        }
        let (Some(fa), Some(fb)) = (da.fix, db.fix) else {
            return false;
        };
        let slack = GEO_SLACK_M + f64::from(fa.acc_m) + f64::from(fb.acc_m);
        if distance(self.point(&fa), self.point(&fb)) > slack {
            return false;
        }
        let mid = epoch_mid_ms(self.start_ms, e);
        !self.in_safehouse(&fa) && !self.in_safehouse(&fb) && !self.frozen(a, mid) && !self.frozen(b, mid)
    }

    /// Contacts only ever get established, never withdrawn, so a later fix cannot undo a lock
    /// a player already saw.
    fn find_contacts(&mut self, cur: u32, out: &mut Out) {
        let keep_from = cur.saturating_sub(KEEP_EPOCHS);
        let n = self.players.len();
        let mut new = Vec::new();
        for a in 0..n {
            for b in a + 1..n {
                if !self.players[a].alive() || !self.players[b].alive() {
                    continue;
                }
                for d in &self.players[a].epochs {
                    let e = d.epoch;
                    if e >= keep_from
                        && e <= cur + 1
                        && !self.has_contact(a as u16, b as u16, e)
                        && self.contact_holds(a, b, e)
                    {
                        new.push(Contact {
                            epoch: e,
                            a: a as u16,
                            b: b as u16,
                        });
                    }
                }
            }
        }
        new.sort_unstable();
        for c in new {
            let i = self.contacts.binary_search(&c).unwrap_err();
            self.contacts.insert(i, c);
            self.append(
                out,
                LogEntry::Contact {
                    a: c.a,
                    b: c.b,
                    epoch: c.epoch,
                },
            );
        }
    }

    /// lock(h→t, e) = contact epochs in (e − WINDOW_EPOCHS, e], from the epoch h was assigned
    /// t on.
    fn lock(&self, hunter: u16, target: u16, epoch: u32) -> u32 {
        let (lo_player, hi_player) = pair(hunter, target);
        let first = epoch
            .saturating_add(1)
            .saturating_sub(WINDOW_EPOCHS)
            .max(self.players[hunter as usize].lock_from);
        self.contacts
            .iter()
            .filter(|c| c.a == lo_player && c.b == hi_player && (first..=epoch).contains(&c.epoch))
            .count() as u32
    }

    // ── actions (4.6, 4.7) ──────────────────────────────────────────────────────────

    fn coin(&self, tick_no: u32, player: u16) -> Hash {
        let vrf_out = sha256(&[&self.secrets.vrf_signature]);
        sha256(&[
            COIN_DOMAIN,
            &vrf_out,
            &tick_no.to_le_bytes(),
            &player.to_le_bytes(),
        ])
    }

    /// Strikes waiting from the previous tick go first: they arrived earlier. Then this tick's
    /// actions, which are simultaneous: device times are set by the phones and cannot rank
    /// them, so the VRF coin orders the players, and neither side of a duel can know or steer
    /// who wins.
    #[allow(clippy::too_many_arguments)]
    fn run_actions(
        &mut self,
        tick_no: u32,
        mut pending: Vec<Pending>,
        now: u64,
        cur: u32,
        out: &mut Out,
        refused: &mut Vec<Refusal>,
        facts: &mut [Option<HintFact>],
    ) -> Vec<HintIssued> {
        for d in std::mem::take(&mut self.deferred) {
            if let Err(reason) = self.strike(d.player, d.t_ms, d.nonce, cur, false, out) {
                refused.push(Refusal {
                    player: d.player,
                    nonce: d.nonce,
                    action: ActionKind::Strike,
                    reason,
                });
            }
        }
        let coins: Vec<Hash> = (0..self.players.len())
            .map(|p| self.coin(tick_no, p as u16))
            .collect();
        pending.sort_by_key(|a| (coins[a.player as usize], a.player, a.seq, a.index));
        // A strike can wait only if another tick follows.
        let may_defer = now < self.end_ms;
        let mut issued = Vec::new();
        for a in pending {
            let (nonce, kind) = match &a.action {
                Action::Strike { nonce } => (*nonce, ActionKind::Strike),
                Action::Hint { hint, nonce, .. } => (*nonce, ActionKind::Hint(*hint)),
            };
            let result = match a.action {
                Action::Strike { nonce } => self.strike(a.player, a.t_ms, nonce, cur, may_defer, out),
                Action::Hint { hint, nonce, text } => {
                    self.hint(a.player, hint, nonce, text, a.t_ms, now, out).map(|h| {
                        facts[a.player as usize] = Some(h.fact);
                        issued.push(h);
                    })
                }
            };
            if let Err(reason) = result {
                refused.push(Refusal {
                    player: a.player,
                    nonce,
                    action: kind,
                    reason,
                });
            }
        }
        issued
    }

    fn live_target(&self, p: u16, t_ms: u64) -> Result<u16, Refuse> {
        let pl = &self.players[p as usize];
        if !pl.alive() {
            return Err(Refuse::PlayerOut);
        }
        if t_ms >= self.end_ms {
            return Err(Refuse::TimeUp);
        }
        // A live player without a target is the last one standing.
        pl.target.ok_or(Refuse::MatchOver)
    }

    /// Contact in epoch `e` that counts toward h's lock on t.
    fn counted_contact(&self, h: u16, t: u16, e: u32) -> bool {
        e >= self.players[h as usize].lock_from && self.has_contact(h, t, e)
    }

    /// A strike stands iff lock ≥ LOCK_EPOCHS at its epoch and contact holds in that epoch or
    /// the one before. Returns the target.
    fn judge_strike(&self, h: u16, t_ms: u64) -> Result<u16, Refuse> {
        let t = self.live_target(h, t_ms)?;
        let e = self.epoch(t_ms).ok_or(Refuse::NoContact)?;
        let lock = self.lock(h, t, e);
        if lock < LOCK_EPOCHS {
            return Err(Refuse::Lock { lock });
        }
        let in_contact = self.counted_contact(h, t, e) || (e > 0 && self.counted_contact(h, t, e - 1));
        if !in_contact {
            return Err(Refuse::NoContact);
        }
        Ok(t)
    }

    /// Whether the target's batches for e−1 or e could still turn this refusal into a tag: the
    /// target has sent nothing dated past the end of an epoch that lacks contact, and contact
    /// there would fill the lock. The hunter's phone sent its strike as soon as it had the
    /// evidence; the target's phone may simply be a batch or a tick behind.
    fn awaits_target(&self, h: u16, t_ms: u64) -> bool {
        let (Ok(t), Some(e)) = (self.live_target(h, t_ms), self.epoch(t_ms)) else {
            return false;
        };
        let from = self.players[h as usize].lock_from;
        let target_t = self.players[t as usize].last_batch_t;
        let missing = [e.checked_sub(1), Some(e)]
            .into_iter()
            .flatten()
            .filter(|&x| {
                let end_ms = self.start_ms + u64::from(x + 1) * EPOCH_MS;
                x >= from && !self.has_contact(h, t, x) && target_t.is_none_or(|l| l < end_ms)
            })
            .count() as u32;
        missing > 0 && self.lock(h, t, e) + missing >= LOCK_EPOCHS
    }

    /// Tags the target, or refuses; with `may_defer`, a strike short only of the target's late
    /// data waits for the next tick instead (once).
    fn strike(
        &mut self,
        h: u16,
        t_ms: u64,
        nonce: u32,
        cur: u32,
        may_defer: bool,
        out: &mut Out,
    ) -> Result<(), Refuse> {
        match self.judge_strike(h, t_ms) {
            Ok(t) => {
                self.eliminate(t, h, cur);
                self.verdict(out, Verdict::Tag { hunter: h, target: t });
                Ok(())
            }
            Err(Refuse::Lock { .. } | Refuse::NoContact) if may_defer && self.awaits_target(h, t_ms) => {
                self.deferred.push(DeferredStrike {
                    player: h,
                    t_ms,
                    nonce,
                });
                Ok(())
            }
            Err(reason) => Err(reason),
        }
    }

    /// `loser`'s head moves to `winner`, who inherits `loser`'s target. The lock on it counts
    /// from the next epoch: contact the winner had with that player before now was not a hunt.
    fn eliminate(&mut self, loser: u16, winner: u16, cur: u32) {
        let (l, w) = (loser as usize, winner as usize);
        let head = std::mem::take(&mut self.players[l].head);
        self.players[w].head += head;
        self.players[l].taken_by = Some(winner);
        let next = self.players[l].target.take();
        self.players[w].target = next.filter(|&n| n != winner);
        self.players[w].lock_from = cur + 1;
    }

    #[allow(clippy::too_many_arguments)]
    fn hint(
        &mut self,
        p: u16,
        kind: u8,
        nonce: u32,
        text: Option<String>,
        t_ms: u64,
        now: u64,
        out: &mut Out,
    ) -> Result<HintIssued, Refuse> {
        let t = self.live_target(p, t_ms)?;
        let price = hint_price(self.cfg.stake, kind).ok_or(Refuse::UnknownHint)?;
        if text.as_ref().is_some_and(|s| s.chars().count() > HINT_TEXT_MAX) {
            return Err(Refuse::TextTooLong);
        }
        // On the referee clock: a phone that moves its own clock forward must not skip it.
        if let Some(last) = self.players[p as usize].last_hint_ms {
            let ready_ms = last.saturating_add(HINT_COOLDOWN_MS);
            if now < ready_ms {
                return Err(Refuse::Cooldown { ready_ms });
            }
        }
        let head = self.players[p as usize].head;
        if head < price {
            return Err(Refuse::InsufficientHead { head, price });
        }
        let value = self.hint_value(p, t, kind, t_ms).ok_or(Refuse::NoFix)?;
        self.players[p as usize].head -= price;
        self.players[t as usize].head += price;
        self.players[p as usize].last_hint_ms = Some(now);
        let hint_id = self.next_hint_id;
        self.next_hint_id += 1;
        self.pending_receipts.push((hint_id, now));
        self.verdict(
            out,
            Verdict::Hint {
                from: p,
                to: t,
                amount: price,
                hint_id,
            },
        );
        Ok(HintIssued {
            hint_id,
            from: p,
            to: t,
            amount: price,
            fact: HintFact {
                hint_id,
                hint: kind,
                value,
            },
            nonce,
            text,
        })
    }

    /// The fact, from the latest usable fixes: NEAR 0/1, BEARING 0..7, TREND 0 farther /
    /// 1 closer / 2 same compared with the fixes nearest `HINT_TREND_MS` before the hint.
    fn hint_value(&self, p: u16, t: u16, kind: u8, t_ms: u64) -> Option<u8> {
        let a = self.point(&self.players[p as usize].last_fix?);
        let b = self.point(&self.players[t as usize].last_fix?);
        match kind {
            hint_kind::NEAR => Some(u8::from(distance(a, b) <= HINT_NEAR_M)),
            hint_kind::BEARING => Some(bearing8(a, b)),
            hint_kind::TREND => {
                let then = t_ms.checked_sub(HINT_TREND_MS)?;
                let a0 = self.point(&self.fix_near(p, then)?);
                let b0 = self.point(&self.fix_near(t, then)?);
                let (d0, d1) = (distance(a0, b0), distance(a, b));
                Some(if d1 < d0 - TREND_SAME_M {
                    1
                } else if d1 > d0 + TREND_SAME_M {
                    0
                } else {
                    2
                })
            }
            _ => None,
        }
    }

    fn fix_near(&self, p: u16, t_ms: u64) -> Option<StoredFix> {
        self.players[p as usize]
            .epochs
            .iter()
            .filter_map(|d| d.fix)
            .filter(|f| f.t_ms.abs_diff(t_ms) <= FIX_WINDOW_MS)
            .min_by_key(|f| (f.t_ms.abs_diff(t_ms), f.t_ms))
    }

    // ── dark (4.x, IDEA 3) ──────────────────────────────────────────────────────────

    fn dark_gap(&self, pi: usize, now: u64) -> u64 {
        now.min(self.end_ms).saturating_sub(self.players[pi].present_ms)
    }

    /// Dark time accrues once a gap passes `DARK_GRACE_MS` and then counts from the gap's start;
    /// cumulative dark time reaching `DARK_FORFEIT_MS` forfeits the head to the hunter.
    fn dark_rules(&mut self, now: u64, cur: u32, out: &mut Out) {
        let eff = now.min(self.end_ms);
        for pi in 0..self.players.len() {
            if !self.players[pi].alive() || self.dark_gap(pi, now) <= DARK_GRACE_MS {
                continue;
            }
            let p = &mut self.players[pi];
            let from = p.present_ms.max(p.dark_counted_ms);
            p.dark_ms += eff.saturating_sub(from);
            p.dark_counted_ms = eff;
        }
        for pi in 0..self.players.len() {
            if self.alive_count() <= 1 {
                break;
            }
            if self.players[pi].alive() && self.players[pi].dark_ms >= DARK_FORFEIT_MS {
                let Some(to) = self.hunter_of(pi as u16) else {
                    continue;
                };
                self.eliminate(pi as u16, to, cur);
                self.verdict(
                    out,
                    Verdict::Forfeit {
                        player: pi as u16,
                        to,
                    },
                );
            }
        }
    }

    fn leak(&self, t: u16, now: u64) -> Option<GridCell> {
        let ti = t as usize;
        if !self.players[ti].alive() || self.dark_gap(ti, now) < DARK_LEAK_MS {
            return None;
        }
        let f = self.players[ti].last_fix?;
        let (lat_e7, lon_e7) = self.plane.cell_centre(self.point(&f), LEAK_CELL_M);
        Some(GridCell { lat_e7, lon_e7 })
    }

    // ── HUD and pruning ─────────────────────────────────────────────────────────────

    fn huds(&self, tick_no: u32, now: u64, cur: u32, facts: &[Option<HintFact>]) -> Vec<(u16, Hud)> {
        let over = self.phase != Phase::Running;
        self.players
            .iter()
            .enumerate()
            .map(|(i, p)| {
                let me = i as u16;
                let lock_of = |h: u16, t: u16| self.lock(h, t, cur).min(u32::from(u8::MAX)) as u8;
                let hud = if p.alive() {
                    Hud {
                        tick: tick_no,
                        epoch: cur,
                        lock: p.target.map_or(0, |t| lock_of(me, t)),
                        heat: self.hunter_of(me).map_or(0, |h| lock_of(h, me)),
                        head: p.head,
                        status: if over {
                            target_status::WON
                        } else {
                            target_status::HUNTING
                        },
                        target: p
                            .target
                            .map(|t| self.players[t as usize].account.clone())
                            .unwrap_or_default(),
                        leak: p.target.and_then(|t| self.leak(t, now)),
                        hint_fact: facts[i],
                        tagged_by: None,
                    }
                } else {
                    Hud {
                        tick: tick_no,
                        epoch: cur,
                        lock: 0,
                        heat: 0,
                        head: p.head,
                        status: target_status::OUT,
                        target: String::new(),
                        leak: None,
                        hint_fact: None,
                        tagged_by: p.taken_by.map(|w| self.players[w as usize].account.clone()),
                    }
                };
                (me, hud)
            })
            .collect()
    }

    fn prune(&mut self, cur: u32) {
        let keep_from = cur.saturating_sub(KEEP_EPOCHS);
        let keep_from_ms = self.start_ms + u64::from(keep_from) * EPOCH_MS;
        self.contacts.retain(|c| c.epoch >= keep_from);
        for p in &mut self.players {
            p.epochs.retain(|d| d.epoch >= keep_from);
            p.freezes.retain(|&(_, until)| until >= keep_from_ms);
            if !p.alive() {
                // An eliminated player's evidence can never matter again.
                p.epochs.clear();
                p.freezes.clear();
            }
        }
    }
}

impl Player {
    fn new(d: Device, target: Option<u16>, stake: u128, start_ms: u64) -> Self {
        Self {
            account: d.account_id,
            key: d.key,
            counter: d.counter,
            next_seq: 0,
            prev: [0; 32],
            taken_by: None,
            target,
            lock_from: 0,
            head: stake,
            last_fix: None,
            last_fix_t: None,
            last_batch_t: None,
            // Everyone starts present, so the dark clock runs from the start of the match.
            present_ms: start_ms,
            dark_ms: 0,
            dark_counted_ms: start_ms,
            fast_since: None,
            freezes: Vec::new(),
            last_hint_ms: None,
            epochs: Vec::new(),
        }
    }
}

fn slot(epochs: &mut Vec<EpochData>, e: u32) -> &mut EpochData {
    let i = match epochs.binary_search_by_key(&e, |d| d.epoch) {
        Ok(i) => i,
        Err(i) => {
            epochs.insert(
                i,
                EpochData {
                    epoch: e,
                    fix: None,
                    heard: Vec::new(),
                },
            );
            i
        }
    };
    &mut epochs[i]
}
