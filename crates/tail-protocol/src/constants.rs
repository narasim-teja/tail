//! Mirror of `packages/protocol/src/constants.ts`. Change both in the same change.

pub const EPOCH_MS: u64 = 15_000;
pub const BATCH_MS: u64 = 5_000;
/// S2 measured OutLayer p95 above 4 s, so ticks are 10 s.
pub const TICK_MS: u64 = 10_000;
pub const WINDOW_EPOCHS: u32 = 8;
pub const LOCK_EPOCHS: u32 = 4;
pub const RSSI_MIN_DBM: i8 = -82;
pub const MIN_SAMPLES: u8 = 2;
pub const GEO_SLACK_M: f64 = 40.0;
pub const MAX_ACC_M: u16 = 50;
pub const FIX_WINDOW_MS: u64 = 10_000;
pub const MAX_SPEED_MPS: f64 = 7.0;
pub const VEHICLE_HOLD_MS: u64 = 20_000;
pub const VEHICLE_FREEZE_MS: u64 = 120_000;
pub const TELEPORT_MPS: f64 = 15.0;
pub const CLOCK_SKEW_MS: u64 = 20_000;
pub const DARK_LEAK_MS: u64 = 45_000;
pub const LEAK_CELL_M: f64 = 100.0;
pub const DARK_FORFEIT_MS: u64 = 180_000;
pub const HINT_COOLDOWN_MS: u64 = 30_000;
pub const HINT_NEAR_M: f64 = 150.0;
pub const HINT_TREND_MS: u64 = 60_000;
pub const CHECKPOINT_MS: u64 = 60_000;
pub const REFEREE_TIMEOUT_MS: u64 = 900_000;
pub const HINT_TEXT_MAX: usize = 140;
/// Most hints one match may charge. The contract keeps one record per hint until `End` replays
/// them, and pays for that storage when the match is created, so the count needs a bound: 20 per
/// player at 12 players. The referee refuses the next one (`refuse_code::HINT_LIMIT`).
pub const MAX_HINTS: usize = 240;

pub mod hint_kind {
    pub const NEAR: u8 = 0;
    pub const BEARING: u8 = 1;
    pub const TREND: u8 = 2;
}

/// Hint price in basis points of the stake; `None` for an unknown kind.
pub const fn hint_bps(kind: u8) -> Option<u128> {
    match kind {
        hint_kind::NEAR | hint_kind::TREND => Some(200),
        hint_kind::BEARING => Some(500),
        _ => None,
    }
}

/// `HINT_BPS[kind] × stake / 10 000`, rounded down.
pub fn hint_price(stake: u128, kind: u8) -> Option<u128> {
    hint_bps(kind).map(|bps| stake * bps / 10_000)
}

pub mod fix_flag {
    pub const SIMULATED_BY_SOFTWARE: u8 = 1;
    pub const PRODUCED_BY_ACCESSORY: u8 = 2;
}

pub mod target_status {
    pub const HUNTING: u8 = 0;
    pub const OUT: u8 = 1;
    pub const WON: u8 = 2;
}

/// Why the referee refused a batch: `LogEntry::Rejected.code` and `Hud.rejected`. Shared so the
/// phone can name the reason without knowing the referee's types.
pub mod reject_code {
    pub const UNKNOWN_PLAYER: u8 = 1;
    pub const WRONG_MATCH: u8 = 2;
    pub const PLAYER_OUT: u8 = 3;
    /// `seq` is not the next one expected.
    pub const SEQ: u8 = 4;
    /// `prev` is not the hash of the last accepted batch.
    pub const PREV: u8 = 5;
    /// The App Attest assertion did not verify.
    pub const ASSERTION: u8 = 6;
    pub const CLOCK_SKEW: u8 = 7;
    /// A fix was simulated or came from an accessory.
    pub const FIX_FLAGS: u8 = 8;
    /// Fixes out of time order.
    pub const FIX_ORDER: u8 = 9;
    pub const TELEPORT: u8 = 10;
    /// `t_ms` went backwards against an earlier batch of the same player.
    pub const TIME_ORDER: u8 = 11;
    /// Dated before the evidence the referee still keeps, so nothing in it could count.
    pub const TOO_OLD: u8 = 12;
}

/// Why the referee took no action on a valid batch's Strike or Hint: the `reason` of a tick's
/// `refused` list. The amounts some refusals carry (a lock count, a head) stay with the referee;
/// the player sees them in the signed HUD.
pub mod refuse_code {
    pub const PLAYER_OUT: u8 = 1;
    pub const TIME_UP: u8 = 2;
    /// Only one player is left.
    pub const MATCH_OVER: u8 = 3;
    /// Strike: the lock was not full.
    pub const LOCK: u8 = 4;
    /// Strike: no contact with the target in the strike's epoch or the one before.
    pub const NO_CONTACT: u8 = 5;
    pub const UNKNOWN_HINT: u8 = 6;
    /// Hint: the question is over `HINT_TEXT_MAX` characters.
    pub const TEXT_TOO_LONG: u8 = 7;
    /// Hint: too soon after the last one.
    pub const COOLDOWN: u8 = 8;
    /// Hint: the asker's head cannot pay for it.
    pub const FUNDS: u8 = 9;
    /// Hint: no usable fix for the asker or the target.
    pub const NO_FIX: u8 = 10;
    /// Hint: the match already charged `MAX_HINTS`.
    pub const HINT_LIMIT: u8 = 11;
}

pub mod domain {
    pub const TAG: &[u8] = b"tail/tag";
    pub const BEACON: &[u8] = b"tail/beacon";
    pub const TAG_MAC: &[u8] = b"tag";
    pub const TOKEN_MAC: &[u8] = b"tok";
    pub const BATCH: &[u8] = b"tail/batch";
    /// v2: the payload carries `prev`, the digest of the match's previous verdict.
    pub const VERDICT: &[u8] = b"tail/verdict/v2";
    pub const RING: &[u8] = b"tail/ring";
    pub const PLAYERS: &[u8] = b"tail/players";
    pub const SEAL: &[u8] = b"tail/seal/v1";
    pub const ENROLL: &[u8] = b"tail/enroll/v1";
    /// Signature digest of a `Hud`, and the seal AAD of a `SignedHud`.
    pub const HUD: &[u8] = b"tail/hud/v2";
    /// Signature digest of `PlayerKeys`, and the seal AAD of a `SignedPlayerKeys`.
    pub const KEYS: &[u8] = b"tail/keys/v2";
    /// Signature digest of a `VoiceLine`, and the seal AAD of a `SignedVoiceLine`.
    pub const VOICE: &[u8] = b"tail/voice/v1";
    /// HKDF info of `K_log`, the match's log-salt key.
    pub const LOG: &[u8] = b"tail/log";
    /// HMAC prefix of a log entry's salt.
    pub const LOG_SALT: &[u8] = b"tail/log-salt";
}
