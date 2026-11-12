//! TAIL referee rules engine (TECHNICAL.md 4.3–4.11, 5.2).
//!
//! A pure state machine: no I/O, no clock, no randomness of its own. Time arrives as
//! `now_ms`, `K_m` and the VRF signature come from the caller, so the same inputs always give
//! the same outputs and the OutLayer wrapper only has to unseal, call, sign and seal.
//!
//! ```text
//! init(cfg, devices, K_m, vrf_signature, start_ms, call_id) → Start verdict, per-player keys
//! tick(state, TickInput)                                     → verdicts, HUDs, log entries
//! finish(state, alpha, vrf_signature, call_id, receipts)     → End verdict
//! ```
//!
//! The rules as implemented, and every choice TECHNICAL.md left open, are in `README.md`.

mod engine;
mod geo;
mod log;
mod state;
mod types;

pub use engine::{finish, init, tick};
pub use state::{Phase, PlayerView, State};
pub use types::*;

use tail_protocol::WINDOW_EPOCHS;

/// A match needs a hunter and a target; more than this and the per-tick work and the sealed
/// state stop being small.
pub const MIN_PLAYERS: usize = 2;
pub const MAX_PLAYERS: usize = 16;
/// A match lasts at most a day, which keeps every epoch number tiny.
pub const MAX_DURATION_MS: u64 = 86_400_000;
/// A gap without a present batch shorter than this never counts as dark, so a missed tick on
/// a flaky network costs nothing. Longer gaps count in full.
pub const DARK_GRACE_MS: u64 = 20_000;
/// TREND reports "same" when the distance changed by less than this.
pub const TREND_SAME_M: f64 = 10.0;
/// A voice receipt is logged only if it arrives within this long of its hint.
pub const RECEIPT_WINDOW_MS: u64 = 120_000;
/// Per-epoch evidence kept in the state: the lock window plus room for late batches (skew),
/// the strike's e−1 and the TREND look-back.
pub const KEEP_EPOCHS: u32 = WINDOW_EPOCHS + 4;
/// Tie-break for actions with the same device time:
/// `SHA256("tail/coin" ‖ SHA256(vrf_signature) ‖ u32le(tick_no) ‖ u16le(player))`, lower first.
pub const COIN_DOMAIN: &[u8] = b"tail/coin";
