//! Hint prices: the only place they are defined (the TypeScript twin is
//! `packages/protocol/src/pricing.ts`; `vectors/pricing.json` pins both).
//!
//! The Handler sells intel like a market maker. Each kind has a base price in basis points of
//! the stake. Every hint anyone in the match bought in the last `PRICE_WINDOW_MS` of match time
//! adds `PRICE_STEP_BPS` to it, up to `PRICE_CAP_BPS`, and the price falls back as those hints
//! age out of the window. A hunt that turns into a bidding war gets dearer for everyone; a quiet
//! match stays cheap.
//!
//! The referee charges `hint_price(stake, kind, recent_hints(earlier, t_ms))` and puts `t_ms` in
//! the `Hint` verdict. The contract recomputes the same number from the match's earlier hints
//! and refuses any other amount, so a referee cannot overcharge. No dependencies and no floating
//! point: the contract builds it for wasm32-unknown-unknown.

use crate::constants::hint_kind;

/// Demand counts hints bought in the last 5 minutes of match time.
pub const PRICE_WINDOW_MS: u64 = 300_000;
/// Each recent hint adds 25 % of the base price.
pub const PRICE_STEP_BPS: u128 = 2_500;
/// Never more than 4x the base price.
pub const PRICE_CAP_BPS: u128 = 40_000;
/// 100 % in basis points.
const BPS: u128 = 10_000;

/// Base hint price in basis points of the stake; `None` for an unknown kind.
pub const fn hint_bps(kind: u8) -> Option<u128> {
    match kind {
        hint_kind::NEAR | hint_kind::TREND => Some(200),
        hint_kind::BEARING => Some(500),
        _ => None,
    }
}

/// How many of `prev_hint_times_ms` fall in the window that ends at `now_ms`:
/// `now_ms - PRICE_WINDOW_MS < t <= now_ms`. A hint charged earlier in the same tick (same
/// `t_ms`) counts, so the second hint of a tick already pays for the first.
pub fn recent_hints(prev_hint_times_ms: &[u64], now_ms: u64) -> u32 {
    let n = prev_hint_times_ms
        .iter()
        .filter(|&&t| t <= now_ms && t.saturating_add(PRICE_WINDOW_MS) > now_ms)
        .count();
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// The demand multiplier in basis points: `min(10 000 + PRICE_STEP_BPS × recent, PRICE_CAP_BPS)`.
pub fn demand_bps(recent: u32) -> u128 {
    (BPS + PRICE_STEP_BPS * u128::from(recent)).min(PRICE_CAP_BPS)
}

/// `HINT_BPS[kind] × stake / 10 000 × demand_bps(recent) / 10 000`, each division rounded down;
/// `None` for an unknown kind.
pub fn hint_price(stake: u128, kind: u8, recent: u32) -> Option<u128> {
    hint_bps(kind).map(|bps| stake * bps / BPS * demand_bps(recent) / BPS)
}

/// The kind's name as the phone shows it.
pub const fn hint_name(kind: u8) -> Option<&'static str> {
    match kind {
        hint_kind::NEAR => Some("Near"),
        hint_kind::BEARING => Some("Bearing"),
        hint_kind::TREND => Some("Warmer"),
        _ => None,
    }
}

/// `demand_bps(recent)` as a multiplier: 12 500 → "1.25x", 20 000 → "2x".
fn multiplier(recent: u32) -> String {
    let bps = demand_bps(recent);
    let frac = format!("{:04}", bps % BPS);
    let frac = frac.trim_end_matches('0');
    if frac.is_empty() {
        format!("{}x", bps / BPS)
    } else {
        format!("{}.{frac}x", bps / BPS)
    }
}

/// The Handler's one line on the price, the same words on the phone and in the voice prompt:
/// "Intel's dear: 4 hints bought in the last 5 minutes put Bearing at 2x." `None` for an
/// unknown kind.
pub fn price_reason(kind: u8, recent: u32) -> Option<String> {
    let name = hint_name(kind)?;
    let minutes = PRICE_WINDOW_MS / 60_000;
    let hints = if recent == 1 { "hint" } else { "hints" };
    let x = multiplier(recent);
    Some(match recent {
        0 => format!("Intel's cheap: nobody bought a hint in the last {minutes} minutes, so {name} is at its base price."),
        _ if demand_bps(recent) >= PRICE_CAP_BPS => format!(
            "Intel's at its peak: {recent} {hints} bought in the last {minutes} minutes hold {name} at {x}."
        ),
        _ if demand_bps(recent) >= 2 * BPS => {
            format!("Intel's dear: {recent} {hints} bought in the last {minutes} minutes put {name} at {x}.")
        }
        _ => format!("Intel's warming: {recent} {hints} bought in the last {minutes} minutes put {name} at {x}."),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const STAKE: u128 = 1_000_000;

    #[test]
    fn a_quiet_match_pays_the_base_price() {
        assert_eq!(hint_price(STAKE, hint_kind::NEAR, 0), Some(20_000));
        assert_eq!(hint_price(STAKE, hint_kind::TREND, 0), Some(20_000));
        assert_eq!(hint_price(STAKE, hint_kind::BEARING, 0), Some(50_000));
        assert_eq!(hint_price(STAKE, 3, 0), None);
    }

    #[test]
    fn each_recent_hint_adds_a_quarter_up_to_four_times() {
        assert_eq!(hint_price(STAKE, hint_kind::BEARING, 1), Some(62_500));
        assert_eq!(hint_price(STAKE, hint_kind::BEARING, 4), Some(100_000));
        assert_eq!(hint_price(STAKE, hint_kind::BEARING, 12), Some(200_000));
        assert_eq!(hint_price(STAKE, hint_kind::BEARING, 13), Some(200_000));
        assert_eq!(hint_price(STAKE, hint_kind::BEARING, u32::MAX), Some(200_000));
    }

    #[test]
    fn both_divisions_round_down() {
        // 49 × 200 / 10 000 = 0; 999 × 500 / 10 000 = 49, × 12 500 / 10 000 = 61.
        assert_eq!(hint_price(49, hint_kind::NEAR, 5), Some(0));
        assert_eq!(hint_price(999, hint_kind::BEARING, 1), Some(61));
    }

    #[test]
    fn the_window_is_open_below_and_closed_above() {
        let now = 1_000_000;
        let times = [
            now - PRICE_WINDOW_MS,     // aged out exactly at the edge
            now - PRICE_WINDOW_MS + 1, // still in
            now - 1,
            now,     // earlier in this tick
            now + 1, // later than now: not "earlier"
        ];
        assert_eq!(recent_hints(&times, now), 3);
        assert_eq!(recent_hints(&[], now), 0);
        assert_eq!(
            recent_hints(&[0, 5], 10),
            2,
            "early in the match the window starts at 0"
        );
    }

    #[test]
    fn the_reason_names_the_demand() {
        assert_eq!(
            price_reason(hint_kind::NEAR, 0).unwrap(),
            "Intel's cheap: nobody bought a hint in the last 5 minutes, so Near is at its base price."
        );
        assert_eq!(
            price_reason(hint_kind::TREND, 1).unwrap(),
            "Intel's warming: 1 hint bought in the last 5 minutes put Warmer at 1.25x."
        );
        assert_eq!(
            price_reason(hint_kind::BEARING, 4).unwrap(),
            "Intel's dear: 4 hints bought in the last 5 minutes put Bearing at 2x."
        );
        assert_eq!(
            price_reason(hint_kind::BEARING, 30).unwrap(),
            "Intel's at its peak: 30 hints bought in the last 5 minutes hold Bearing at 4x."
        );
        assert_eq!(price_reason(9, 1), None);
    }
}
