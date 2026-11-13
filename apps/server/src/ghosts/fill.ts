// Test players: the host of a lobby fills an empty seat with a ghost the relay makes on the spot,
// so two phones can try a match that needs three players. The ghost is enrolled through the
// testing door, topped up with the stake, and joined on chain with its own key. It never sends a
// batch: the referee counts it dark from the start and forfeits its head to its hunter once
// DARK_FORFEIT_MS of dark time has built up (README, "Ghost players: the testing door").
//
// Only routes/dev.ts calls this, and app.ts mounts that route only with NEAR_NETWORK=testnet and
// ALLOW_GHOSTS=1. The ghost enrols in-process (no HTTP route enrols a ghost), and its keys live
// only in this call: after the join nothing needs them. Its stake is minted against the host's
// daily top-up cap (topup.ts), booked before the ghost is made so a refusal costs no account.

import type { Logger } from "@tail/log";
import type { Store } from "../db.ts";
import { type Enrolment, GHOST_PREFIX } from "../enroll.ts";
import { HttpError } from "../errors.ts";
import type { Chain } from "../near.ts";
import { bookTopUp, MAX_TOPUP } from "../topup.ts";
import { newGhostKeys } from "./keys.ts";

/** The most a test player's top-up mints (100 USDC.e); the same bound as POST /dev/topup. */
export const MAX_GHOST_STAKE = MAX_TOPUP;

export interface FillDeps {
  store: Store;
  chain: Chain;
  enrolment: Enrolment;
  log: Logger;
  token: string;
  now?: () => number;
}

/** 8 random base-36 characters. A clash is vanishingly rare, and enrolment refuses a taken handle. */
function ghostHandle(): string {
  const r = crypto.getRandomValues(new Uint8Array(8));
  return GHOST_PREFIX + Array.from(r, (b) => (b % 36).toString(36)).join("");
}

export class GhostFiller {
  /** Matches with a test player on its way in: a double tap must not seat two. */
  private readonly filling = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly d: FillDeps) {
    this.now = d.now ?? Date.now;
  }

  async fill(matchId: string, caller: string): Promise<{ account_id: string }> {
    const m = this.d.store.match(matchId);
    if (!m) throw new HttpError(404, "no such match");
    if (m.host !== caller) throw new HttpError(403, "only the host can add a test player");
    if (m.phase !== "lobby") throw new HttpError(409, `match is ${m.phase}`);
    if (this.filling.has(matchId)) throw new HttpError(409, "a test player is already joining");
    this.filling.add(matchId);
    try {
      return await this.seat(matchId, caller);
    } finally {
      this.filling.delete(matchId);
    }
  }

  private async seat(matchId: string, host: string): Promise<{ account_id: string }> {
    const chain = await this.d.chain.getMatch(matchId);
    if (!chain) throw new HttpError(404, "match is not on chain");
    if (chain.phase !== "lobby") throw new HttpError(409, `match is ${chain.phase} on chain`);
    if (chain.locked_until_ms !== null) throw new HttpError(409, "the lobby is locked");
    if (chain.start_by_ms <= this.now()) throw new HttpError(409, "the lobby's start time has passed");
    if (chain.players.length >= chain.max_players) throw new HttpError(409, "the match is full");
    // The contract lets only invited accounts into such a lobby, and a test player is never invited.
    if (chain.invites.length > 0) throw new HttpError(409, "a test player cannot join an invite-only match");
    const stake = BigInt(chain.stake);
    if (stake > MAX_GHOST_STAKE) throw new HttpError(409, "a test player covers stakes up to 100 USDC.e");

    const booking = bookTopUp(this.d.store, host, `test player for ${matchId}`, stake, this.now());
    const keys = newGhostKeys();
    let account_id: string;
    try {
      ({ account_id } = await this.d.enrolment.enrollGhost({
        handle: ghostHandle(),
        appAttestPk: keys.attestPk,
        playerBoxPk: keys.boxPk,
        nearPk: keys.nearPk,
      }));
      if ((await this.d.chain.getBalance(account_id, this.d.token)) < stake) {
        await this.d.chain.topUp(account_id, stake);
      } else {
        this.d.store.cancelTopup(booking);
      }
    } catch (e) {
      this.d.store.cancelTopup(booking);
      throw e;
    }
    await this.d.chain.joinAsGhost(account_id, keys.nearSeed, matchId);
    this.d.log.info({ matchId, accountId: account_id }, "test player joined");
    return { account_id };
  }
}
