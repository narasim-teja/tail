// Testnet top-ups (POST /dev/topup and test players, ghosts/fill.ts) mint usdc.fakes.testnet with
// the relay's key. Each mint is free to whoever asks, so every one is booked against the account
// that asked, and an account's total over a rolling day is capped: a leaked or careless client
// cannot drain the relay's gas into endless mints.

import type { Store } from "./db.ts";
import { HttpError } from "./errors.ts";
import type { Chain } from "./near.ts";

/** 100 USDC.e (6 decimals); enough for any test stake, small enough to bound a mistake. */
export const MAX_TOPUP = 100_000_000n;
/** What one account may have minted for it, or for test players it seats, per rolling day. */
export const DAILY_TOPUP_CAP = 300_000_000n;
export const TOPUP_WINDOW_MS = 24 * 3_600_000;

/**
 * Books `amount` against `requester`'s daily cap, or throws 429. `what` names the recipient in
 * the record. Returns the booking, to cancel if the mint fails.
 */
export function bookTopUp(store: Store, requester: string, what: string, amount: bigint, nowMs: number) {
  const booking = store.bookTopup(requester, what, amount, nowMs, TOPUP_WINDOW_MS, DAILY_TOPUP_CAP);
  if (booking === null) throw new HttpError(429, "daily top-up limit reached (300 USDC.e); try tomorrow");
  return booking;
}

/** Mints `amount` to `target` on behalf of `requester`, within the requester's daily cap. */
export async function cappedTopUp(
  d: { store: Store; chain: Chain },
  requester: string,
  target: string,
  amount: bigint,
  nowMs: number,
): Promise<void> {
  const booking = bookTopUp(d.store, requester, target, amount, nowMs);
  try {
    await d.chain.topUp(target, amount);
  } catch (e) {
    d.store.cancelTopup(booking);
    throw e;
  }
}
