// The dossier backfill (src/dossiers.ts) against the fake chain, which keeps the contract's
// mint_dossier rules: exact deposit, the parent's call, a registered account, one dossier each.

import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { Store } from "../src/db.ts";
import { DossierBackfill } from "../src/dossiers.ts";
import { FakeChain, quietLog, seedDevice } from "./fakes.ts";

const PARENT = "relay.testnet";
const DEPOSIT = "12000000000000000000000";

function world(dossierDeposit: string | null = DEPOSIT) {
  const store = new Store(":memory:");
  const chain = new FakeChain();
  const sleeps: number[] = [];
  /** Enrolled here and registered on chain; `dossier` as registration on a contract with dossiers. */
  const enrolled = (handle: string, opts: { registered?: boolean; dossier?: boolean } = {}) => {
    const id = `${handle}.${PARENT}`;
    const pk = ed25519.getPublicKey(ed25519.utils.randomSecretKey());
    seedDevice(store, id, pk);
    if (opts.registered ?? true) chain.accounts.set(id, pk);
    if (opts.dossier) chain.dossiers.set(id, { matches: 0, survived: 0 });
    return id;
  };
  const backfill = (over: { maxPerRun?: number } = {}) =>
    new DossierBackfill({
      store,
      chain,
      log: quietLog(),
      parentAccount: PARENT,
      spacingMs: 1_000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      ...over,
    });
  chain.dossierDeposit = dossierDeposit;
  return { store, chain, sleeps, enrolled, backfill };
}

describe("dossier backfill", () => {
  test("does nothing against a contract from before dossiers", async () => {
    const w = world(null);
    w.enrolled("ana");
    // The fake throws MethodNotFound on any dossier method, as the old contract would.
    expect(await w.backfill().run()).toBeNull();
    expect(w.chain.minted).toEqual([]);
  });

  test("mints for registered accounts without one, paying the exact deposit, once", async () => {
    const w = world();
    const [ana, bo] = [w.enrolled("ana"), w.enrolled("bo")];
    w.enrolled("cy", { dossier: true });
    w.enrolled("dan", { registered: false });
    const r = await w.backfill().run();
    expect(r).toEqual({ minted: [ana, bo], failed: [], held: 1, unregistered: 1, deferred: 0 });
    expect(w.chain.minted).toEqual([ana, bo]);
    // One transaction at a time, spaced.
    expect(w.sleeps).toEqual([1_000]);
    const again = await w.backfill().run();
    expect(again?.minted).toEqual([]);
    expect(again?.held).toBe(3);
    expect(w.chain.minted).toEqual([ana, bo]);
  });

  test("a run mints at most maxPerRun; the next run takes the rest", async () => {
    const w = world();
    const [ana, bo] = [w.enrolled("ana"), w.enrolled("bo")];
    expect((await w.backfill({ maxPerRun: 1 }).run())?.deferred).toBe(1);
    expect(w.chain.minted).toEqual([ana]);
    expect((await w.backfill({ maxPerRun: 1 }).run())?.minted).toEqual([bo]);
  });

  test("a failed mint is reported and the others still go", async () => {
    const w = world();
    const [ana, bo] = [w.enrolled("ana"), w.enrolled("bo")];
    const mint = w.chain.mintDossier.bind(w.chain);
    w.chain.mintDossier = async (id, deposit) => {
      if (id === ana) throw new Error("rpc down");
      return mint(id, deposit);
    };
    const r = await w.backfill().run();
    expect(r?.failed).toEqual([ana]);
    expect(r?.minted).toEqual([bo]);
    w.chain.mintDossier = mint;
    expect((await w.backfill().run())?.minted).toEqual([ana]);
  });

  test("two runs at once are one pass", async () => {
    const w = world();
    w.enrolled("ana");
    const b = w.backfill();
    const [x, y] = await Promise.all([b.run(), b.run()]);
    expect(x).toBe(y);
    expect(w.chain.minted.length).toBe(1);
  });

  test("the fake chain refuses what the contract refuses", async () => {
    const w = world();
    const ana = w.enrolled("ana");
    await expect(w.chain.mintDossier(ana, 1n)).rejects.toThrow("exactly dossier_deposit");
    await expect(w.chain.mintDossier("ana.other.testnet", BigInt(DEPOSIT))).rejects.toThrow("parent");
    await expect(w.chain.mintDossier(`x.${ana}`, BigInt(DEPOSIT))).rejects.toThrow("parent");
    await w.chain.mintDossier(ana, BigInt(DEPOSIT));
    await expect(w.chain.mintDossier(ana, BigInt(DEPOSIT))).rejects.toThrow("already has a dossier");
  });
});
