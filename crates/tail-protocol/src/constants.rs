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

pub mod domain {
    pub const TAG: &[u8] = b"tail/tag";
    pub const BEACON: &[u8] = b"tail/beacon";
    pub const TAG_MAC: &[u8] = b"tag";
    pub const TOKEN_MAC: &[u8] = b"tok";
    pub const BATCH: &[u8] = b"tail/batch";
    pub const VERDICT: &[u8] = b"tail/verdict/v1";
    pub const RING: &[u8] = b"tail/ring";
    pub const PLAYERS: &[u8] = b"tail/players";
    pub const SEAL: &[u8] = b"tail/seal/v1";
    pub const ENROLL: &[u8] = b"tail/enroll/v1";
}
