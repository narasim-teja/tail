// The relay's replay bundle re-executes under crates/referee-verify: a ghost match judged by the
// real (local) referee, served by GET /replay/:id, must pass `tail-verify --strict`, which exits
// 3 when anything had to be taken from the log instead of recomputed. So the bundle has to carry
// every device's App Attest key, every batch's assertion, the refused batches and the App ID.
// Both binaries are built here as local-referee.test.ts builds the referee; that file covers the
// relay's other duties in the same kind of match.
//
// The script: three ghosts enrol unattested and start; the hunter asks a hint, walks to its
// target and strikes once its HUD shows a full lock; the bystander sends one batch with a
// simulated fix (refused for validity, after it took its seq), resends an old batch (refused:
// seq) and bytes that are no batch. The match runs to End and is declassified.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BATCH_MS, FixFlag, LOCK_EPOCHS, type ReplayBundleV2, TICK_MS } from "@tail/protocol";
import { createRelay } from "../src/app.ts";
import { newCarryKeys } from "../src/carry.ts";
import { Store } from "../src/db.ts";
import { Ghost } from "../src/ghosts/ghost.ts";
import { CLEAN_TAG, positionAt, toLatLonE7 } from "../src/ghosts/trace.ts";
import { GuardedReferee, localTransport, RefereeClient, type RefereeTransport } from "../src/referee.ts";
import { ContractChain } from "./contract-chain.ts";
import { quietLog, until } from "./fakes.ts";

const ROOT = join(import.meta.dir, "../../..");
const REFEREE_CRATE = join(ROOT, "crates/referee-wasi");
const REFEREE_BIN = join(REFEREE_CRATE, "target/release/tail-referee");
const VERIFY_BIN = join(ROOT, "target/release/tail-verify");
const PARENT = "relay.testnet";
const CONTRACT = "tail.relay.testnet";
const APP_ID = "TEAM.app";
const STAKE = 1_000_000n;
const DURATION_MS = 120_000;
const ZONE = { lat_e7: 423_550_000, lon_e7: -710_656_000, radius_m: 1500 };

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

let dir = "";
const cleanup: (() => void)[] = [];

async function cargoBuild(cwd: string, args: string[]) {
  const build = Bun.spawn(["cargo", "build", "--release", "--locked", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [err, code] = await Promise.all([new Response(build.stderr).text(), build.exited]);
  if (code !== 0) throw new Error(`cargo build ${args.join(" ")} failed:\n${err.slice(-2000)}`);
}

/** Runs tail-verify on `bundle`; its exit status and report. */
async function tailVerify(bundle: unknown, name: string) {
  const path = join(dir, `${name}.json`);
  await Bun.write(path, JSON.stringify(bundle));
  const run = Bun.spawn([VERIFY_BIN, path, "--strict"], { stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(run.stdout).text(), run.exited]);
  return { code, out };
}

beforeAll(async () => {
  // Incremental: no-ops when the binaries are current.
  await Promise.all([
    cargoBuild(REFEREE_CRATE, ["--bin", "tail-referee"]),
    cargoBuild(ROOT, ["-p", "referee-verify", "--bin", "tail-verify"]),
  ]);
  dir = mkdtempSync(join(tmpdir(), "tail-replay-verify-"));
}, 600_000);

afterAll(() => {
  for (const f of cleanup.splice(0)) f();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("the relay's replay bundle", () => {
  test("re-executes under tail-verify --strict, App Attest and refusals included", async () => {
    const clock = { ms: Date.now() - 10 * 60_000 };
    const local = localTransport({ bin: REFEREE_BIN, dir, owner: PARENT, allowUnattested: true });
    // The relay leaves referee time to the referee; the test's clock runs fast, so it hands the
    // referee that time as `now_ms` (local-referee.test.ts says why that is allowed).
    const transport: RefereeTransport = (cmd, input) =>
      local(cmd, cmd === "tick" ? { ...input, now_ms: clock.ms } : input);
    const referee = new GuardedReferee(new RefereeClient(transport), "local");
    const pins = await referee.pubkeys();
    const chain = new ContractChain(
      { refereePk: pins.refereePk, vrfPk: pins.vrfPk, vrfSender: PARENT },
      () => clock.ms,
    );
    const store = new Store(":memory:");
    const relay = createRelay({
      store,
      chain,
      referee,
      log: quietLog(),
      parentAccount: PARENT,
      appId: APP_ID,
      environment: "development",
      token: "usdc.fakes.testnet",
      carryKeys: newCarryKeys(),
      replay: {
        contract: CONTRACT,
        network: "testnet",
        refereeProject: `${PARENT}/tail-referee`,
        outlayerApi: "https://testnet-api.outlayer.ai",
        refereeKind: "local",
      },
      refereeHealth: () => referee.health(),
      testnet: true,
      allowGhosts: true,
      refereeRetryMs: [],
      now: () => clock.ms,
    });
    relay.matches.stop();
    const server = Bun.serve({ port: 0, fetch: relay.app.fetch, websocket: relay.websocket });
    cleanup.push(() => {
      relay.enrolment.stop();
      server.stop(true);
    });
    const url = `http://localhost:${server.port}`;

    const trust = { contract: CONTRACT, refereePk: pins.refereePk };
    const ghosts = ["a", "b", "c"].map((r) => new Ghost(`ghost-${r}`, url, trust));
    for (const g of ghosts) await g.enroll(relay.enrolment);
    const [host] = ghosts as [Ghost];
    const { match_id: id } = await host.request<{ match_id: string }>("POST", "/matches", {
      stake: STAKE.toString(),
      duration_ms: DURATION_MS,
      zone: ZONE,
      public_replay: true,
      min_players: 3,
      max_players: 3,
      start_by_ms: Date.now() + 600_000,
    });
    for (const g of ghosts) {
      chain.balances.set(g.accountId, STAKE);
      await chain.joinAsGhost(g.accountId, g.nearSeed, id);
    }
    const started = await host.request<{ keys: { account_id: string; sealed: string }[]; start_ms: number }>(
      "POST",
      `/matches/${id}/start`,
      {},
    );
    for (const g of ghosts) g.setKeys(started.keys.find((k) => k.account_id === g.accountId)?.sealed ?? "");
    for (const g of ghosts) await g.connectHud(id);
    cleanup.push(() => {
      for (const g of ghosts) g.closeHud();
    });
    const startMs = started.start_ms;
    const hunter = ghosts.find((g) => g.keys?.player === 0) as Ghost;
    const target = ghosts.find((g) => g.accountId === hunter.keys?.target) as Ghost;
    const bystander = ghosts.find((g) => g !== hunter && g !== target) as Ghost;
    const role = (g: Ghost) => (g === hunter ? "hunter" : g === target ? "target" : "bystander");

    const hint = CLEAN_TAG.hint as NonNullable<typeof CLEAN_TAG.hint>;
    let hinted = false;
    let struck = false;
    const first = new Map<Ghost, Uint8Array>();
    for (let k = 1; store.match(id)?.phase !== "ended"; k++) {
      if (k > 20) throw new Error("the match did not end");
      if (!struck && (hunter.huds.at(-1)?.lock ?? 0) >= LOCK_EPOCHS) {
        hunter.strike();
        struck = true;
      }
      const live = ghosts.filter((g) => !g.out);
      const outbox: { g: Ghost; sealed: Uint8Array }[] = [];
      for (let s = 1; s <= TICK_MS / 1000; s++) {
        const t = startMs + (k - 1) * TICK_MS + s * 1000;
        const tS = (t - startMs) / 1000;
        const pos = new Map(live.map((g) => [g, positionAt(CLEAN_TAG.paths[role(g)], tS)]));
        for (const g of live) {
          const p = pos.get(g) as { east: number; north: number; speed: number };
          g.fix({
            tMs: BigInt(t),
            ...toLatLonE7({ latE7: ZONE.lat_e7, lonE7: ZONE.lon_e7 }, p.east, p.north),
            accM: CLEAN_TAG.accM,
            speedCmps: Math.round(p.speed * 100),
            flags: g === bystander && tS === 33 ? FixFlag.SimulatedBySoftware : 0,
          });
          for (const o of live) {
            const q = pos.get(o) as { east: number; north: number };
            if (o !== g && Math.hypot(p.east - q.east, p.north - q.north) <= CLEAN_TAG.radioM)
              g.hear(t, o.token(t), CLEAN_TAG.rssi);
          }
        }
        if (!hinted && tS >= hint.atS) {
          hunter.hint(hint.kind, hint.text);
          hinted = true;
        }
        if ((s * 1000) % BATCH_MS === 0)
          for (const g of live) {
            const sealed = g.sealedBatch(t, pins.refereeBoxPk, APP_ID);
            if (!first.has(g)) first.set(g, sealed);
            outbox.push({ g, sealed });
          }
      }
      clock.ms = startMs + k * TICK_MS;
      for (const { g, sealed } of outbox)
        await g.request("POST", "/batch", { match_id: id, sealed: b64(sealed) });
      if (k === 5) {
        const resent = first.get(bystander) as Uint8Array;
        await bystander.request("POST", "/batch", { match_id: id, sealed: b64(resent) });
        await bystander.request("POST", "/batch", {
          match_id: id,
          sealed: b64(crypto.getRandomValues(new Uint8Array(200))),
        });
      }
      await relay.matches.step(id);
      const tick = store.match(id)?.tick_no ?? 0;
      await until(() => ghosts.every((g) => g.huds.at(-1)?.tick === tick), `the HUDs of tick ${tick}`);
    }
    expect(struck).toBe(true);
    expect(target.out).toBe(true);

    const bundle = (await (await relay.app.request(`/replay/${id}`)).json()) as ReplayBundleV2;
    expect(bundle.version).toBe(2);
    expect(bundle.match.appId).toBe(APP_ID);
    expect(bundle.assertions).toHaveLength(bundle.batches.length);
    // The validity refusal; the resend came as the same envelope as an accepted batch, and the
    // bytes that were no batch never opened.
    expect(bundle.rejected).toHaveLength(1);
    expect(bundle.devices.map((d) => d.appAttestPk?.length)).toEqual([130, 130, 130]);

    const strict = await tailVerify(bundle, "relay");
    expect(strict.out).toContain("PASS");
    expect(strict.out).not.toContain("trusted");
    expect(strict.code).toBe(0);

    // The same match from a relay that released none of it still passes, but not strictly.
    const { assertions: _a, rejected: _r, ...older } = bundle;
    const without = {
      ...older,
      match: { ...bundle.match, appId: undefined },
      devices: bundle.devices.map(({ appAttestPk: _k, ...d }) => d),
    };
    const lax = await tailVerify(without, "older");
    expect(lax.out).toContain("trusted");
    expect(lax.code).toBe(3);
  }, 120_000);
});
