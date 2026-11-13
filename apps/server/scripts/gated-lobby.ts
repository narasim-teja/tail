// A lobby only veterans may join, on NEAR testnet with ghosts, through the relay: three ghosts
// play a one-minute match that ends before anyone is tagged, so each has a settled match survived
// in its dossier; then a lobby made with `requires: {min_matches: 1, min_survived: 1}` refuses a
// fresh ghost's join_match on chain and takes a veteran's. The veteran leaves again
// (leave_lobby, its stake back to its balance) and the lobby lapses at its start time. Runs the
// relay in-process with a fresh database.
//
//   ALLOW_GHOSTS=1 bun apps/server/scripts/gated-lobby.ts      (testnet only; ~0.6 NEAR)
//   REFEREE_MODE=local ALLOW_GHOSTS=1 RELAY_PORT=8788 bun apps/server/scripts/gated-lobby.ts

import { createLogger } from "@tail/log";
import { fromHex, toHex } from "@tail/protocol";
import { Account, teraToGas } from "near-api-js";
import { loadConfig, loadRepoEnv } from "../src/config.ts";
import { Ghost } from "../src/ghosts/ghost.ts";
import { Squad } from "../src/ghosts/squad.ts";
import { CLEAN_TAG } from "../src/ghosts/trace.ts";
import { startRelay } from "../src/main.ts";
import { nearKeyPair } from "../src/near.ts";

const STAKE = 100_000n; // 0.1 USDC.e
// The shortest match the relay makes: CLEAN_TAG's hunter needs about a minute of lock after
// walking in for 45 s, so the clock runs out first and all three survive.
const DURATION_MS = 60_000;
const ZONE = { latE7: 423_550_000, lonE7: -710_656_000, radiusM: 1500 }; // Boston Common
const REQUIRES = { min_matches: 1, min_survived: 1 };

interface Dossier {
  matches: number;
  survived: number;
}

loadRepoEnv();
const run = Date.now().toString(36).slice(-6);
const config = {
  ...loadConfig(process.env),
  dbPath: new URL(`../data/gated-lobby-${run}.db`, import.meta.url).pathname,
};
if (!config.allowGhosts) throw new Error("set ALLOW_GHOSTS=1 (testnet only) to run ghosts");
const log = createLogger("gated-lobby");
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, note = "") => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? `  (${note})` : ""}`);
  if (!ok) throw new Error(`check failed: ${name}`);
};

const relay = startRelay(config);
const url = `http://localhost:${relay.server.port}`;
const cfg = await relay.chain.config();
const trust = { contract: config.contract, refereePk: fromHex(cfg.referee_pk) };
const ghost = (role: string) => new Ghost(`ghost-${role}-${run}`, url, trust);
const veterans = ["a", "b", "c"].map(ghost);
const fresh = ghost("new");
let squad: Squad | undefined;

const dossier = (accountId: string) =>
  relay.chain.provider.callFunction({
    contractId: config.contract,
    method: "get_dossier",
    args: { account_id: accountId },
  }) as Promise<Dossier | null>;

/** Waits for a lobby the relay just created to show in the RPC view (it can trail by a block). */
async function onChain(matchId: string) {
  for (let i = 0; i < 10; i++) {
    const m = await relay.chain.getMatch(matchId);
    if (m) return m;
    await Bun.sleep(1_000);
  }
  throw new Error(`lobby ${matchId} never showed on chain`);
}

const lobby = (host: Ghost, extra: Record<string, unknown>) =>
  host.request<{ match_id: string }>("POST", "/matches", {
    stake: STAKE.toString(),
    duration_ms: DURATION_MS,
    zone: { lat_e7: ZONE.latE7, lon_e7: ZONE.lonE7, radius_m: ZONE.radiusM },
    public_replay: true,
    min_players: 3,
    max_players: 3,
    start_by_ms: Date.now() + 30 * 60_000,
    ...extra,
  });

try {
  // ── a settled match the three ghosts all survive ─────────────────────────────────
  for (const g of [...veterans, fresh]) await g.enroll(relay.enrolment);
  const host = veterans[0] as Ghost;
  const first = await lobby(host, { invites: veterans.map((g) => g.accountId) });
  await onChain(first.match_id);
  for (const g of veterans) {
    await g.request("POST", "/dev/topup", { account_id: g.accountId, amount: STAKE.toString() });
    await g.join(relay.chain.provider, config.contract, first.match_id);
  }
  await host.request("POST", `/matches/${first.match_id}/start`, {});
  for (const g of veterans) {
    await g.fetchKeys(first.match_id);
    await g.connectHud(first.match_id);
  }
  const keys = await relay.referee.pubkeys();
  squad = new Squad({
    ghosts: veterans,
    trace: CLEAN_TAG,
    matchId: first.match_id,
    zone: ZONE,
    refereeBoxPk: keys.refereeBoxPk,
    appId: config.appId,
    log,
  });
  squad.start();
  const deadline = Date.now() + DURATION_MS + 5 * 60_000;
  while (relay.store.match(first.match_id)?.phase !== "ended") {
    const phase = relay.store.match(first.match_id)?.phase;
    if (phase === "ending") squad.stop();
    if (phase === "failed") throw new Error(`match failed: ${relay.store.match(first.match_id)?.error}`);
    if (Date.now() > deadline) throw new Error("the first match did not settle in time");
    await Bun.sleep(1_000);
  }
  squad.stop();
  const settled = await relay.chain.getMatch(first.match_id);
  check(
    "the first match settled with every ghost still in",
    settled?.phase === "ended" && settled.players.every((p) => !p.out),
    first.match_id,
  );
  const records = await Promise.all(veterans.map((g) => dossier(g.accountId)));
  const veteran = veterans.find(
    (_, i) => (records[i]?.matches ?? 0) >= 1 && (records[i]?.survived ?? 0) >= 1,
  );
  check(
    "a ghost's dossier now counts a settled match survived",
    veteran !== undefined,
    records.map((r) => `${r?.matches ?? 0}/${r?.survived ?? 0}`).join(", "),
  );
  if (!veteran) throw new Error("unreachable");
  const before = await dossier(fresh.accountId);
  check(
    "the fresh ghost has no settled match",
    (before?.matches ?? 0) === 0 && (before?.survived ?? 0) === 0,
  );

  // ── the gated lobby ──────────────────────────────────────────────────────────────
  const gated = await lobby(veteran, { requires: REQUIRES });
  const m = await onChain(gated.match_id);
  check(
    "create_match pinned the lobby's requires",
    m.requires?.min_matches === REQUIRES.min_matches && m.requires.min_survived === REQUIRES.min_survived,
    gated.match_id,
  );
  const shown = (await (await fetch(`${url}/matches/${gated.match_id}`)).json()) as {
    chain: { requires: unknown } | null;
  };
  check("the public match view shows it", JSON.stringify(shown.chain?.requires) === JSON.stringify(REQUIRES));

  for (const g of [fresh, veteran])
    await g.request("POST", "/dev/topup", { account_id: g.accountId, amount: STAKE.toString() });
  const refused = await fresh.join(relay.chain.provider, config.contract, gated.match_id).then(
    () => "",
    (e: unknown) => String((e as Error).message),
  );
  check(
    "join_match refuses the fresh ghost on chain",
    refused.includes("below this match's requires"),
    refused.slice(0, 160),
  );
  await veteran.join(relay.chain.provider, config.contract, gated.match_id);
  const joined = await relay.chain.getMatch(gated.match_id);
  check(
    "join_match takes the veteran",
    joined?.players.length === 1 && joined.players[0]?.account_id === veteran.accountId,
  );

  // ── tidy up: the veteran takes its stake back; the lobby lapses at start_by ──────
  await new Account(veteran.accountId, relay.chain.provider, nearKeyPair(veteran.nearSeed)).callFunction({
    contractId: config.contract,
    methodName: "leave_lobby",
    args: { match_id: gated.match_id },
    gas: teraToGas("30"),
  });
  const left = await relay.chain.getMatch(gated.match_id);
  check("the veteran left the lobby again", left?.players.length === 0);
  console.log(`\ncontract ${config.contract}, referee_pk ${toHex(keys.refereePk).slice(0, 12)}…`);
  console.log(`settled match ${first.match_id}, gated lobby ${gated.match_id}`);
} finally {
  squad?.stop();
  for (const g of veterans) g.closeHud();
  await relay.stop();
}
console.log(`\n${results.filter((r) => r[1]).length}/${results.length} checks passed`);
process.exit(0);
