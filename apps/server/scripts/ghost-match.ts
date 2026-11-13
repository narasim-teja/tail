// A full 3-ghost match on NEAR testnet and the configured referee (hosted OutLayer, or the local
// test referee with REFEREE_MODE=local), end to end through the relay:
// enrol (testing door) → create the lobby → top up → join with each ghost's own key → start →
// real-time ticks with sealed batches, a hint and a tag → End → declassify. After each step it
// checks the contract (get_match, get_heads, get_roots, balances), and at the end the relay's
// leaves and the declassified log against the anchored root, and an inclusion and a consistency
// proof from the relay's proof endpoints. Runs the relay in-process with a fresh database.
//
//   ALLOW_GHOSTS=1 bun apps/server/scripts/ghost-match.ts      (testnet only; ~0.5 NEAR, ~$0.05)
//   REFEREE_MODE=local ALLOW_GHOSTS=1 RELAY_PORT=8788 bun apps/server/scripts/ghost-match.ts

import { createLogger } from "@tail/log";
import {
  type AnyReplayBundle,
  decodeLogEntry,
  decodeSignedVerdict,
  fromHex,
  merkleLeaf,
  merkleRoot,
  merkleVerify,
  sha256,
  toHex,
  verifyConsistency,
} from "@tail/protocol";
import { loadConfig, loadRepoEnv } from "../src/config.ts";
import { Ghost } from "../src/ghosts/ghost.ts";
import { Squad } from "../src/ghosts/squad.ts";
import { CLEAN_TAG } from "../src/ghosts/trace.ts";
import { startRelay } from "../src/main.ts";

const STAKE = 100_000n; // 0.1 USDC.e
const DURATION_MS = 300_000; // 5 minutes: walk in, a minute of lock, the tag, then the clock runs out
const ZONE = { latE7: 423_550_000, lonE7: -710_656_000, radiusM: 1500 }; // Boston Common

loadRepoEnv();
const run = Date.now().toString(36).slice(-6);
const config = {
  ...loadConfig(process.env),
  dbPath: new URL(`../data/ghost-match-${run}.db`, import.meta.url).pathname,
};
if (!config.allowGhosts) throw new Error("set ALLOW_GHOSTS=1 (testnet only) to run ghosts");
const log = createLogger("ghost-match");
const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, note = "") => {
  results.push([name, ok, note]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? `  (${note})` : ""}`);
  if (!ok) throw new Error(`check failed: ${name}`);
};

const relay = startRelay(config);
const url = `http://localhost:${relay.server.port}`;
const nearBefore = await relay.chain.relayBalance();
// What a phone pins: the contract, and the referee key that contract pins.
const cfg = await relay.chain.config();
const ghosts = ["a", "b", "c"].map(
  (r) =>
    new Ghost(`ghost-${r}-${run}`, url, { contract: config.contract, refereePk: fromHex(cfg.referee_pk) }),
);
let squad: Squad | undefined;

try {
  // ── preflight: the contract pins this referee ────────────────────────────────────
  const keys = await relay.referee.pubkeys();
  check(
    "the contract pins the deployed referee's verdict and VRF keys",
    cfg.referee_pk === toHex(keys.refereePk) && cfg.vrf_pk === toHex(keys.vrfPk),
    `referee_pk ${cfg.referee_pk.slice(0, 12)}…`,
  );

  // ── enrol ────────────────────────────────────────────────────────────────────────
  for (const g of ghosts) await g.enroll(relay.enrolment);
  for (const g of ghosts) {
    const list = await relay.chain.provider.viewAccessKeyList({ accountId: g.accountId });
    const k = list.keys[0];
    check(
      `${g.handle} holds one function-call key, scoped to the contract`,
      list.keys.length === 1 && k?.access_key.permission !== "FullAccess",
    );
    check(
      `${g.handle} is registered with itself as payout`,
      (await relay.chain.provider.callFunction({
        contractId: config.contract,
        method: "get_payout",
        args: { account_id: g.accountId },
      })) === g.accountId,
    );
  }

  // ── lobby ────────────────────────────────────────────────────────────────────────
  const host = ghosts[0] as Ghost;
  const created = await host.request<{ match_id: string }>("POST", "/matches", {
    stake: STAKE.toString(),
    duration_ms: DURATION_MS,
    zone: { lat_e7: ZONE.latE7, lon_e7: ZONE.lonE7, radius_m: ZONE.radiusM },
    public_replay: true,
    min_players: 3,
    max_players: 3,
    start_by_ms: Date.now() + 30 * 60_000,
    invites: ghosts.map((g) => g.accountId),
  });
  const matchId = created.match_id;
  // The RPC view can trail the create transaction by a block or two: wait for the lobby to show.
  let m = await relay.chain.getMatch(matchId);
  for (let i = 0; i < 10 && !m; i++) {
    await Bun.sleep(1_000);
    m = await relay.chain.getMatch(matchId);
  }
  check(
    "create_match opened a lobby hosted by the relay",
    m?.phase === "lobby" && m.host === config.relayAccount,
    matchId,
  );
  // A match keeps the keys pinned when it was created; a concurrent key rotation would show here.
  check(
    "the lobby pinned the deployed referee's keys",
    m?.referee_pk === toHex(keys.refereePk) && m.vrf_pk === toHex(keys.vrfPk),
  );

  for (const g of ghosts)
    await g.request("POST", "/dev/topup", { account_id: g.accountId, amount: STAKE.toString() });
  const bal = await Promise.all(ghosts.map((g) => relay.chain.getBalance(g.accountId, config.token)));
  check(
    "top-up credited each ghost's internal balance",
    bal.every((b) => b === STAKE),
    bal.join(", "),
  );

  for (const g of ghosts) await g.join(relay.chain.provider, config.contract, matchId);
  m = await relay.chain.getMatch(matchId);
  check(
    "three ghosts joined with their own function-call keys",
    m?.players.length === 3 && m.players.every((p) => p.head === STAKE.toString()),
    m?.players.map((p) => p.account_id.split(".")[0]).join(", "),
  );

  // ── start ────────────────────────────────────────────────────────────────────────
  const t0 = performance.now();
  const started = await host.request<{
    players: string[];
    keys: { player: number; account_id: string; sealed: string }[];
    start_ms: number;
    end_ms: number;
  }>("POST", `/matches/${matchId}/start`, {});
  const startWall = Math.round(performance.now() - t0);
  for (const g of ghosts) {
    const k = started.keys.find((x) => x.account_id === g.accountId);
    if (!k) throw new Error(`no keys for ${g.accountId}`);
    g.setKeys(k.sealed);
  }
  m = await relay.chain.getMatch(matchId);
  check(
    "Start landed: the match runs with the ring committed",
    m?.phase === "running" && m.seq === 1 && m.ring_commit !== null && m.start_ms === started.start_ms,
    `start took ${startWall} ms`,
  );
  check(
    "every ghost's sealed PlayerKeys open and name another player as target",
    ghosts.every((g) => g.keys && g.keys.target !== g.accountId && started.players.includes(g.keys.target)),
  );

  for (const g of ghosts) await g.connectHud(matchId);
  squad = new Squad({
    ghosts,
    trace: CLEAN_TAG,
    matchId,
    zone: ZONE,
    refereeBoxPk: keys.refereeBoxPk,
    appId: config.appId,
    log,
  });
  const hunter = squad.ghost("hunter");
  const target = squad.ghost("target");
  const bystander = squad.ghost("bystander");
  console.log(`roles: ${hunter.handle} hunts ${target.handle}; ${bystander.handle} stands by`);
  squad.start();

  // ── play: poll until the relay has settled and declassified the match ────────────
  const deadline = started.end_ms + 4 * 60_000;
  let shown = 0;
  while (relay.store.match(matchId)?.phase !== "ended") {
    const phase = relay.store.match(matchId)?.phase;
    // Phones stop reporting once the referee says the match is over.
    if (phase === "ending") squad.stop();
    if (phase === "failed") throw new Error(`match failed: ${relay.store.match(matchId)?.error}`);
    if (Date.now() > deadline) throw new Error("match did not settle in time");
    const ticks = relay.store.ticks(matchId);
    for (const t of ticks.slice(shown)) {
      const h = hunter.huds.at(-1);
      console.log(
        `tick ${t.tick_no}: ${t.wall_ms} ms, ${t.batches} batches, verdicts [${t.verdicts.join(",")}]` +
          `${t.rejected.length ? ` rejected ${JSON.stringify(t.rejected)}` : ""}` +
          `${t.refused.length ? ` refused ${JSON.stringify(t.refused)}` : ""}  hunter lock ${h?.lock ?? "-"}`,
      );
    }
    shown = ticks.length;
    await Bun.sleep(1000);
  }
  squad.stop();

  // ── after: chain state, money, log ───────────────────────────────────────────────
  const verdicts = relay.store.verdicts(matchId);
  const kinds = verdicts.map((v) => v.kind);
  m = await relay.chain.getMatch(matchId);
  check(
    "every verdict landed on chain in seq order",
    m?.phase === "ended" &&
      m.seq === verdicts.length &&
      verdicts.every((v, i) => v.seq === i + 1 && v.applied_ms),
    kinds.join(", "),
  );
  check("the hunter's hint and its tag are among them", kinds.includes("Hint") && kinds.includes("Tag"));
  const tag = verdicts.map((v) => decodeSignedVerdict(v.raw).body).find((b) => b.kind === "Tag");
  const idx = (g: Ghost) => g.keys?.player;
  check(
    "the Tag names the hunter and its target",
    tag?.kind === "Tag" && tag.hunter === idx(hunter) && tag.target === idx(target),
  );
  check(
    "the target's HUD says out",
    target.huds.some((h) => h.status === 1),
  );
  check(
    "the Handler answered the hunter's hint",
    hunter.handlerLines.length > 0,
    hunter.handlerLines[0] ?? "",
  );

  const heads = await relay.chain.getHeads(matchId);
  const paid = m?.players.map((p) => BigInt(p.paid)) ?? [];
  const byIndex = (g: Ghost) => paid[idx(g) as number] ?? -1n;
  check(
    "settlement: the hunter holds two stakes, the bystander one, the target nothing",
    byIndex(hunter) === 2n * STAKE && byIndex(bystander) === STAKE && byIndex(target) === 0n,
    `paid ${paid.join(", ")}; heads ${heads?.join(", ")}`,
  );
  const balances = await Promise.all(ghosts.map((g) => relay.chain.getBalance(g.accountId, config.token)));
  check(
    "internal balances match what settlement paid",
    ghosts.every((g, i) => balances[i] === byIndex(g)),
    balances.join(", "),
  );

  const roots = await relay.chain.getRoots(matchId);
  const leaves = relay.store.leaves(matchId);
  const entries = relay.store.log(matchId);
  const end = verdicts.map((v) => decodeSignedVerdict(v.raw).body).find((b) => b.kind === "End");
  const size = end?.kind === "End" ? Number(end.logSize) : -1;
  const root = toHex(merkleRoot(leaves.slice(0, size)));
  check(
    "the relay's leaves reproduce the root anchored on chain",
    leaves.length >= size && roots?.final_root?.root === root && roots.final_root.log_size === size,
    `${leaves.length} leaves, ${roots?.checkpoints.length} checkpoints`,
  );
  check(
    "the declassified log hashes to exactly those leaves",
    entries.length === leaves.length &&
      entries.every((e, i) => toHex(merkleLeaf(decodeLogEntry(e))) === toHex(leaves[i] as Uint8Array)),
    `${entries.length} entries`,
  );
  const contact = entries.findIndex((e) => decodeLogEntry(e).kind === "Contact");
  const inc = (await (
    await fetch(
      `${url}/matches/${matchId}/inclusion?leaf=${toHex(leaves[contact] as Uint8Array)}&size=${size}`,
    )
  ).json()) as { index: number; size: number; path: string[] };
  check(
    "the relay's inclusion proof places a Contact entry under the anchored root",
    contact >= 0 &&
      merkleVerify(leaves[contact] as Uint8Array, inc.index, inc.size, inc.path.map(fromHex), fromHex(root)),
    `entry ${contact}`,
  );
  const first = roots?.checkpoints[0];
  if (first) {
    const con = (await (
      await fetch(`${url}/matches/${matchId}/consistency?from=${first.log_size}&to=${size}`)
    ).json()) as { path: string[] };
    check(
      "the relay's consistency proof links the first checkpoint to End",
      verifyConsistency(first.log_size, size, fromHex(first.root), fromHex(root), con.path.map(fromHex)),
    );
  }
  const res = await fetch(`${url}/replay/${matchId}`);
  const bundle = (await res.json()) as AnyReplayBundle;
  const bundleRoot = toHex(
    merkleRoot(
      bundle.log
        .slice(0, size)
        .map((e) => merkleLeaf(decodeLogEntry(new Uint8Array(Buffer.from(e, "base64"))))),
    ),
  );
  check(
    "the ReplayBundle (v2) reproduces the anchored root; every verdict names its transaction",
    res.ok &&
      bundle.version === 2 &&
      bundle.leaves.length === bundle.log.length &&
      bundleRoot === roots?.final_root?.root &&
      bundle.verdicts.every((v) => v.txHash),
    `${bundle.verdicts.length} verdicts, ${bundle.handler.length} Handler line(s), ring ${bundle.reveal.ring.length}`,
  );
  const loggedBatches = new Set(
    entries.map((e) => decodeLogEntry(e)).flatMap((e) => (e.kind === "Batch" ? [toHex(e.hash)] : [])),
  );
  const trailHashes = bundle.batches.map((b) => toHex(sha256(new Uint8Array(Buffer.from(b, "base64")))));
  check(
    "the bundle's declassified trails are exactly the logged batches",
    trailHashes.length === loggedBatches.size && trailHashes.every((h) => loggedBatches.has(h)),
    `${trailHashes.length} of ${relay.store.allBatches(matchId).length} forwarded`,
  );
  check("the declassified reveal is stored", relay.store.match(matchId)?.reveal !== null);

  // ── report ───────────────────────────────────────────────────────────────────────
  const ticks = relay.store.ticks(matchId);
  const walls = ticks.map((t) => t.wall_ms).sort((a, b) => a - b);
  const pct = (p: number) => walls[Math.min(walls.length - 1, Math.floor(p * walls.length))];
  const nearAfter = await relay.chain.relayBalance();
  console.log(`\ncontract ${config.contract}, match ${matchId}`);
  console.log(`verdicts: ${verdicts.map((v) => `${v.seq}:${v.kind}`).join(" ")}`);
  console.log(`ticks: ${ticks.length}, wall p50 ${pct(0.5)} ms, p95 ${pct(0.95)} ms, max ${walls.at(-1)} ms`);
  const byCmd = new Map<string, number>();
  for (const c of relay.refereeClient.calls) byCmd.set(c.cmd, (byCmd.get(c.cmd) ?? 0) + 1);
  console.log(
    `${config.refereeMode === "local" ? "Local test referee" : "OutLayer"}: ${relay.refereeClient.calls.length} calls (${[...byCmd].map(([k, v]) => `${k} ${v}`).join(", ")}), $${relay.refereeClient.spendUsd().toFixed(4)}`,
  );
  console.log(`NEAR spent by the relay: ${(Number(nearBefore - nearAfter) / 1e24).toFixed(4)}`);
} finally {
  squad?.stop();
  for (const g of ghosts) g.closeHud();
  relay.stop();
}
console.log(`\n${results.filter((r) => r[1]).length}/${results.length} checks passed`);
process.exit(0);
