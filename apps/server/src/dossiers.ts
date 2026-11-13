// Dossier backfill. Registration mints a player's dossier (`register_for` pays for it), but an
// account registered before the contract had dossiers holds none, and its function-call key
// cannot attach the deposit `mint_dossier` takes. The relay is the parent of every account it
// made, so it mints those dossiers itself and pays the deposit.
//
// It runs once at boot (main.ts) and from scripts/backfill-dossiers.ts. Idempotent: each account
// is asked about first, and only one without a dossier gets a mint. Against a contract from
// before dossiers (no `dossier_deposit` in get_config) it does nothing. Rate limited: one
// transaction at a time, `spacingMs` apart, at most `maxPerRun` per run.

import type { Logger } from "@tail/log";
import type { Store } from "./db.ts";
import type { Chain } from "./near.ts";

export const BACKFILL_SPACING_MS = 1_000;
/** Each mint costs dossier_deposit (about 0.012 NEAR); a run never spends more than this many. */
export const BACKFILL_MAX_PER_RUN = 100;

export interface BackfillResult {
  minted: string[];
  /** Accounts whose check or mint failed; the next run tries them again. */
  failed: string[];
  /** Accounts already holding a dossier. */
  held: number;
  /** Accounts not (yet) registered in the contract, such as an enrolment still in flight. */
  unregistered: number;
  /** Accounts without a dossier left for the next run (past maxPerRun). */
  deferred: number;
}

export interface BackfillDeps {
  store: Store;
  chain: Chain;
  log: Logger;
  parentAccount: string;
  spacingMs?: number;
  maxPerRun?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class DossierBackfill {
  private running: Promise<BackfillResult | null> | undefined;

  constructor(private readonly d: BackfillDeps) {}

  /** One pass over every account enrolled here; null when the contract has no dossiers. */
  run(): Promise<BackfillResult | null> {
    this.running ??= this.pass().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async pass(): Promise<BackfillResult | null> {
    const { store, chain, log } = this.d;
    const deposit = (await chain.config()).dossier_deposit;
    if (!deposit) {
      log.info("the contract has no dossiers; nothing to backfill");
      return null;
    }
    const spacingMs = this.d.spacingMs ?? BACKFILL_SPACING_MS;
    const maxPerRun = this.d.maxPerRun ?? BACKFILL_MAX_PER_RUN;
    const sleep = this.d.sleep ?? Bun.sleep;
    // mint_dossier takes the parent's call for a direct sub-account only.
    const suffix = `.${this.d.parentAccount}`;
    const accounts = store
      .deviceAccounts()
      .filter((a) => a.endsWith(suffix) && !a.slice(0, -suffix.length).includes("."));
    const out: BackfillResult = { minted: [], failed: [], held: 0, unregistered: 0, deferred: 0 };
    let sent = 0;
    for (const accountId of accounts) {
      let status: Awaited<ReturnType<Chain["dossierStatus"]>>;
      try {
        status = await chain.dossierStatus(accountId);
      } catch (e) {
        log.warn({ accountId, err: (e as Error).message }, "could not read the account's dossier");
        out.failed.push(accountId);
        continue;
      }
      if (status === "held") out.held++;
      if (status === "unregistered") out.unregistered++;
      if (status !== "missing") continue;
      if (sent >= maxPerRun) {
        out.deferred++;
        continue;
      }
      if (sent > 0) await sleep(spacingMs);
      sent++;
      try {
        await chain.mintDossier(accountId, BigInt(deposit));
        out.minted.push(accountId);
        log.info({ accountId }, "minted a dossier for an account registered before dossiers");
      } catch (e) {
        log.warn({ accountId, err: (e as Error).message }, "dossier mint failed");
        out.failed.push(accountId);
      }
    }
    log.info(
      {
        minted: out.minted.length,
        failed: out.failed.length,
        held: out.held,
        unregistered: out.unregistered,
        deferred: out.deferred,
      },
      "dossier backfill done",
    );
    return out;
  }
}
