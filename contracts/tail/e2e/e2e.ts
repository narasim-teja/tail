// The TAIL contract end to end on NEAR testnet, on a throwaway contract account it creates and
// deletes again (`tail-e2e-<run>.<NEAR_RELAY_ACCOUNT>`; its NEAR goes back to the parent). It
// never touches the live contract and never rotates keys anywhere.
//
//   cd contracts/tail && cargo near build non-reproducible-wasm && cd e2e && bun run e2e.ts
//
// Covers: registration paid by the parent, top-ups, an invite-only lobby with a named sponsor,
// three players joining with function-call keys, the host locking the lobby, referee-signed
// Start/Hint/Tag/Checkpoint/End with the Tag following the ring End rebuilds, settlement, withdraw
// (a player naming its wallet once, paid, and refunded). The verdict key and the VRF key are local
// test keys in .keys/ standing in for the enclave's `verdicts` key and OutLayer's VRF key; the
// parent stands in for the referee's OutLayer caller (the VRF alpha's sender).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { Account, actions, KeyPair, type KeyPairString, nearToYocto, teraToGas } from "near-api-js";
import {
  buildRing,
  encodeSignedVerdict,
  playersHash,
  ringCommit,
  sortAccounts,
  type Verdict,
  verdictDigest,
} from "../../../packages/protocol/src/index.ts";
import {
  ALLOWED_TOKENS,
  createContract,
  deleteContract,
  hex,
  keysDir,
  log,
  parent,
  parentId,
  provider,
  TOKEN,
  unhex,
} from "./common.ts";

const STAKE = 100_000n; // 0.1 USDC (6 decimals)
const SPONSOR = 11n; // odd on purpose: two survivors split it 6 / 5
// Start is dated 4.5 min back (the contract allows 5) so this 4-minute match is already past
// end_ms when End lands: an End with two survivors is only accepted from end_ms on, and Tag and
// Hint still land within the 5-minute grace after it.
const DURATION_MS = 240_000;
const START_BACKDATE_MS = 270_000;
const runId = Date.now().toString(36);
const contractId = `tail-e2e-${runId}.${parentId}`;

const results: [string, boolean, string][] = [];
const record = (name: string, ok: boolean, note = "") => {
  results.push([name, ok, note]);
  log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? `  (${note})` : ""}`);
};
const gasNotes: string[] = [];

const refereeSk = loadSecret("tail-e2e-referee.json");
const vrfSk = loadSecret("tail-e2e-vrf.json");
const refereePk = hex(ed25519.getPublicKey(refereeSk));
const vrfPk = hex(ed25519.getPublicKey(vrfSk));
log(`test referee key: present, public ${refereePk}`);
log(`test vrf key: present, public ${vrfPk}`);

await createContract(contractId, {
  owner: parentId,
  referee_pk: refereePk,
  vrf_pk: vrfPk,
  vrf_sender: parentId,
  allowed_tokens: ALLOWED_TOKENS,
});
let failure: unknown;
try {
  await run();
} catch (e) {
  failure = e;
} finally {
  await deleteContract(contractId);
}
if (failure) throw failure;

log("\n| check | result | note |\n|---|---|---|");
for (const [n, ok, note] of results) log(`| ${n} | ${ok ? "PASS" : "FAIL"} | ${note.replace(/\|/g, "/")} |`);
log("\napply gas (function-call receipt / whole transaction):");
for (const g of gasNotes) log(`  ${g}`);
process.exit(results.every((r) => r[1]) ? 0 : 1);

async function run() {
  const config = await view<Config>("get_config", {});
  record(
    "throwaway contract deployed with the test keys pinned",
    config.owner === parentId &&
      config.referee_pk === refereePk &&
      config.vrf_pk === vrfPk &&
      config.vrf_sender === parentId,
    `${contractId}; match deposit ${config.match_storage_deposit}, registration ${config.registration_deposit} yocto`,
  );
  const withdrawGas = config.withdraw_min_gas;
  const registration = BigInt(config.registration_deposit);

  // ---------- token: registration and mint ----------
  for (const id of [parentId, contractId]) await registerOnToken(id);
  await parent.callFunction({
    contractId: TOKEN,
    methodName: "mint",
    args: { account_id: parentId, amount: "1000000" },
    gas: teraToGas("30"),
  });
  record("mint 1 USDC.e to the parent", (await ftBalance(parentId)) >= 1_000_000n);

  // ---------- players: sub-accounts holding only a function-call key ----------
  const ids = ["p1", "p2", "p3"].map((p) => `${p}-${runId}.${parentId}`);
  const players = await Promise.all(
    ids.map(async (id) => {
      const key = KeyPair.fromRandom("ed25519");
      await parent.signAndSendTransaction({
        receiverId: id,
        actions: [
          actions.createAccount(),
          actions.transfer(nearToYocto("0.1")),
          actions.addFunctionCallAccessKey(
            key.getPublicKey(),
            contractId,
            ["join_match", "leave_lobby", "withdraw"],
            nearToYocto("0.5"),
          ),
        ],
      });
      return { id, key, acct: new Account(id, provider, key.toString() as KeyPairString) };
    }),
  );
  writeFileSync(
    `${keysDir}tail-e2e-players-${runId}.json`,
    JSON.stringify(players.map((p) => ({ account_id: p.id, private_key: p.key.toString() }))),
    { mode: 0o600 },
  );
  // Index order = sorted account ids; p1 < p2 < p3 here, so p1 is 0, p2 is 1, p3 is 2.
  const sorted = sortAccounts(ids);
  type Player = (typeof players)[number];
  const byIndex = sorted.map((id) => players.find((p) => p.id === id) as Player);
  const [p0, p1, p2] = byIndex as [Player, Player, Player];
  // p0 and p1 are registered with themselves as payout, as the relay does; p0 names a wallet on
  // its first withdraw. p2's payout account is not registered on the token, so its withdraw must
  // fail and refund.
  const unregisteredPayout = `nobody-${runId}.${parentId}`;
  const unregistered = await fails(() =>
    callAs(players[0]?.acct as Account, "join_match", { match_id: "00".repeat(16) }),
  );
  record("an unregistered player cannot join", unregistered.includes("account not registered"), unregistered);
  for (const p of players) {
    const keys = await provider.viewAccessKeyList({ accountId: p.id });
    const onlyFc = keys.keys.length === 1 && keys.keys[0]?.access_key.permission !== "FullAccess";
    record(`${short(p.id)} holds one function-call key, no full access`, onlyFc);
    await registerOnToken(p.id);
    const payout = p === p2 ? unregisteredPayout : p.id;
    await callAs(parent, "register_for", { account_id: p.id, payout_account: payout }, registration);
  }
  record(
    "the parent registers each player with the registration deposit",
    (await view<string | null>("get_payout", { account_id: p2.id })) === unregisteredPayout,
  );
  await callAs(parent, "register_for", { account_id: parentId, payout_account: parentId }, registration);

  // ---------- money in: bad msgs refunded, credits accepted ----------
  const before = await ftBalance(parentId);
  await ftTransferCall(`{"credit":"${unregisteredPayout}"}`, 1_000n);
  await ftTransferCall("nope", 1_000n);
  record(
    "a credit to an unregistered account and a bad msg come back in full",
    (await eventually(
      () => ftBalance(parentId),
      (b) => b === before,
    )) === before,
  );
  for (const p of players) await ftTransferCall(JSON.stringify({ credit: p.id }), STAKE);
  const bals = await Promise.all(players.map((p) => balance(p.id)));
  record(
    "top-up credits each player internally",
    bals.every((b) => b === STAKE),
    bals.join(", "),
  );

  // ---------- lobby: invite-only, named sponsor, joins, lock ----------
  const matchId = await callAs<string>(
    parent,
    "create_match",
    {
      cfg: {
        token: TOKEN,
        stake: STAKE.toString(),
        duration_ms: DURATION_MS,
        zone_hash: hex(sha256(new TextEncoder().encode("tail e2e zone"))),
        public_replay: true,
        min_players: 3,
        max_players: 3,
        start_by_ms: Date.now() + 30 * 60_000,
        invites: ids,
        sponsors: [parentId],
      },
    },
    BigInt(config.match_storage_deposit),
  );
  record("create_match with the storage deposit", /^[0-9a-f]{32}$/.test(matchId), matchId);
  await ftTransferCall(JSON.stringify({ sponsor: matchId }), SPONSOR);
  const uninvited = await fails(() => callAs(parent, "join_match", { match_id: matchId }));
  record("an uninvited registered account cannot join", uninvited.includes("not invited"), uninvited);
  for (const p of players) await callAs(p.acct, "join_match", { match_id: matchId });
  await callAs(parent, "lock_lobby", { match_id: matchId });
  let m = await getMatch(matchId);
  record(
    "three invited players joined via function-call keys; sponsor pot held; host locked the lobby",
    m.players.length === 3 &&
      m.players.every((p) => p.head === STAKE.toString()) &&
      m.sponsor_pot === "11" &&
      m.locked_until_ms !== null,
    `heads ${heads(m)}, pot ${m.sponsor_pot}`,
  );
  record("players are listed in sorted order", m.players.map((p) => p.account_id).join() === sorted.join());
  const leave = await fails(() => callAs(p1.acct, "leave_lobby", { match_id: matchId }));
  record("a player cannot leave a locked lobby", leave.includes("lobby is locked"), leave);

  // ---------- verdicts ----------
  const id = unhex(matchId);
  const alpha = `vrf:1:${parentId}:${matchId}`; // OutLayer's alpha shape, seed = match id hex
  const vrfSignature = ed25519.sign(new TextEncoder().encode(alpha), vrfSk);
  const startMs = BigInt(Date.now() - START_BACKDATE_MS);
  const start: Verdict = {
    kind: "Start",
    playersHash: playersHash(ids),
    ringCommit: ringCommit(vrfSignature),
    startMs,
    endMs: startMs + BigInt(DURATION_MS),
  };
  const forged = await fails(() =>
    applyVerdicts([signVerdict(id, 1, start, ed25519.utils.randomSecretKey())]),
  );
  record(
    "a Start signed by another key is refused on-chain",
    forged.includes("bad referee signature"),
    forged,
  );

  await applyOne("Start", signVerdict(id, 1, start));
  m = await getMatch(matchId);
  record(
    "Start runs the match and stores ring_commit",
    m.phase === "running" && m.ring_commit === hex(ringCommit(vrfSignature)),
  );

  const hintAmount = (STAKE * 200n) / 10_000n; // a NEAR hint: 2% of the stake
  const hint = signVerdict(id, 2, { kind: "Hint", from: 0, to: 1, amount: hintAmount, hintId: 1 });
  await applyOne("Hint", hint);
  const hinted = `${STAKE - hintAmount},${STAKE + hintAmount},${STAKE}`;
  m = await eventually(
    () => getMatch(matchId),
    (v) => heads(v) === hinted,
  );
  record(
    "Hint moves the price from player 0 to player 1",
    heads(m) === `${STAKE - hintAmount},${STAKE + hintAmount},${STAKE}`,
    heads(m),
  );

  const replay = await fails(() => applyVerdicts([hint]));
  record("the same verdict replayed is refused", replay.includes("verdict out of order"), replay);

  // The ring End rebuilds from the VRF reveal: ring[k] hunts ring[k+1]. Player 1 is tagged by
  // whoever hunts it, so players 0 and 2 survive either way.
  const ring = buildRing(ids, vrfSignature).map((a) => sorted.indexOf(a));
  const hunter = ring[(ring.indexOf(1) + ring.length - 1) % ring.length] as number;
  await applyOne("Tag", signVerdict(id, 3, { kind: "Tag", hunter, target: 1 }));
  const afterTag = [STAKE - hintAmount, 0n, STAKE];
  afterTag[hunter] = (afterTag[hunter] as bigint) + STAKE + hintAmount;
  m = await eventually(
    () => getMatch(matchId),
    (v) => heads(v) === afterTag.join(),
  );
  record(
    `Tag by the ring's hunter (player ${hunter}) takes player 1's whole head and marks them out`,
    heads(m) === afterTag.join() && m.players[1]?.out === true,
    heads(m),
  );

  const checkpointRoot = sha256(new TextEncoder().encode("checkpoint 1"));
  await applyOne(
    "Checkpoint",
    signVerdict(id, 4, { kind: "Checkpoint", logSize: 42n, root: checkpointRoot }),
  );

  const finalRoot = sha256(new TextEncoder().encode("final"));
  await applyOne(
    "End",
    signVerdict(id, 5, { kind: "End", alpha, vrfSignature, logSize: 99n, root: finalRoot }),
  );
  m = await eventually(
    () => getMatch(matchId),
    (v) => v.phase === "ended",
  );
  const roots = await view<Roots>("get_roots", { match_id: matchId });
  record(
    "End verifies the VRF reveal, anchors the root, keeps the checkpoint",
    m.phase === "ended" &&
      m.alpha === alpha &&
      roots.checkpoints[0]?.root === hex(checkpointRoot) &&
      roots.final_root?.root === hex(finalRoot),
  );
  const expected = [(afterTag[0] as bigint) + 6n, 0n, (afterTag[2] as bigint) + 5n];
  const settled = await eventually(
    () => Promise.all(byIndex.map((p) => balance(p.id))),
    (b) => b.join() === expected.join(),
  );
  record(
    "survivors get their head plus the sponsor pot split 6 / 5; the tagged player gets 0",
    settled.join() === expected.join(),
    settled.join(", "),
  );

  // ---------- withdraw with function-call keys (withdraw_min_gas: 20 go to ft_transfer, 10 to the callback) ----------
  const noTo = await fails(() => callAs(p0.acct, "withdraw", { token: TOKEN, amount: "1" }, 0n, withdrawGas));
  record("a player whose payout is itself must name a wallet to withdraw", noTo.includes("pass `to`"), noTo);
  // The parent stands in for the player's wallet: it is registered on the token.
  const ftBefore = await ftBalance(parentId);
  const paid = await callAs<boolean>(
    p0.acct,
    "withdraw",
    { token: TOKEN, amount: settled[0]?.toString(), to: parentId },
    0n,
    withdrawGas,
  );
  const ftAfter = await eventually(
    () => ftBalance(parentId),
    (b) => b - ftBefore === settled[0],
  );
  record(
    "player 0 withdraws everything to the wallet it named, which becomes its payout for good",
    paid === true &&
      ftAfter - ftBefore === settled[0] &&
      (await balance(p0.id)) === 0n &&
      (await view<string | null>("get_payout", { account_id: p0.id })) === parentId,
    `${ftBefore} -> ${ftAfter}`,
  );
  const other = await fails(() =>
    callAs(p0.acct, "withdraw", { token: TOKEN, amount: "1", to: p1.id }, 0n, withdrawGas),
  );
  record("a second wallet cannot be named", other.includes("must be absent or the payout"), other);
  const again = await fails(() =>
    callAs(p0.acct, "withdraw", { token: TOKEN, amount: "1" }, 0n, withdrawGas),
  );
  record("a second withdraw beyond the balance is refused", again.includes("balance too small"), again);
  const out = await fails(() =>
    callAs(p1.acct, "withdraw", { token: TOKEN, amount: "1", to: parentId }, 0n, withdrawGas),
  );
  record("the tagged player has nothing to withdraw", out.includes("balance too small"), out);

  const res = await p2.acct.callFunctionRaw({
    contractId,
    methodName: "withdraw",
    args: { token: TOKEN, amount: settled[2]?.toString() },
    gas: teraToGas(withdrawGas),
  });
  const status = res.status as { SuccessValue?: string };
  const refunded = JSON.parse(Buffer.from(status.SuccessValue ?? "", "base64").toString() || "null");
  // The refund callback is the receipt that logs the restore; its gas is the margin to watch.
  const callback = res.receipts_outcome.find((r) =>
    r.outcome.logs.some((l) => l.includes("balance restored")),
  );
  gasNotes.push(
    `on_withdraw refund path: ${(Number(callback?.outcome.gas_burnt ?? 0) / 1e12).toFixed(2)} Tgas of 10`,
  );
  record(
    "a withdraw whose ft_transfer fails restores the internal balance",
    refunded === false &&
      (await eventually(
        () => balance(p2.id),
        (b) => b === settled[2],
      )) === settled[2],
    `on_withdraw returned ${refunded}`,
  );
}

// ---------- helpers ----------

interface Config {
  owner: string;
  referee_pk: string;
  vrf_pk: string;
  vrf_sender: string;
  withdraw_min_gas: number;
  match_storage_deposit: string;
  registration_deposit: string;
}
interface MatchView {
  phase: string;
  players: { account_id: string; head: string; out: boolean; paid: string }[];
  sponsor_pot: string;
  locked_until_ms: number | null;
  ring_commit: string | null;
  alpha: string | null;
}
interface Roots {
  checkpoints: { log_size: number; root: string }[];
  final_root: { log_size: number; root: string } | null;
}

function signVerdict(matchId: Uint8Array, seq: number, body: Verdict, sk: Uint8Array = refereeSk): string {
  const callId = new Uint8Array(16); // the OutLayer call id; zero for a locally signed verdict
  const sig = ed25519.sign(verdictDigest({ matchId, seq, callId, body }), sk);
  return Buffer.from(encodeSignedVerdict({ matchId, seq, callId, body, sig })).toString("base64");
}
function applyVerdicts(verdicts: string[]) {
  return parent.callFunctionRaw({
    contractId,
    methodName: "apply",
    args: { verdicts },
    gas: teraToGas("100"),
  });
}
async function applyOne(kind: string, verdict: string) {
  const t0 = performance.now();
  const res = await applyVerdicts([verdict]);
  const ms = Math.round(performance.now() - t0);
  const receipt = Number(res.receipts_outcome[0]?.outcome.gas_burnt ?? 0);
  const total =
    Number(res.transaction_outcome.outcome.gas_burnt) +
    res.receipts_outcome.reduce((s, r) => s + Number(r.outcome.gas_burnt), 0);
  gasNotes.push(`${kind}: ${(receipt / 1e12).toFixed(2)} / ${(total / 1e12).toFixed(2)} Tgas, ${ms} ms`);
}
async function getMatch(matchId: string) {
  return view<MatchView>("get_match", { match_id: matchId });
}
function heads(m: MatchView) {
  return m.players.map((p) => p.head).join();
}
async function balance(accountId: string) {
  return BigInt(await view<string>("get_balance", { account_id: accountId, token: TOKEN }));
}
async function ftTransferCall(msg: string, amount: bigint) {
  await parent.callFunction({
    contractId: TOKEN,
    methodName: "ft_transfer_call",
    args: { receiver_id: contractId, amount: amount.toString(), msg },
    gas: teraToGas("60"),
    deposit: 1n,
  });
}
async function callAs<T = unknown>(
  a: Account,
  methodName: string,
  args: Record<string, unknown>,
  deposit = 0n,
  tgas = 30,
): Promise<T> {
  return (await a.callFunction({ contractId, methodName, args, gas: teraToGas(tgas), deposit })) as T;
}
async function view<T>(method: string, args: Record<string, unknown>): Promise<T> {
  return (await provider.callFunction({
    contractId,
    method,
    args,
    blockQuery: { finality: "optimistic" },
  })) as T;
}
async function ftBalance(id: string) {
  const b = await provider.callFunction({
    contractId: TOKEN,
    method: "ft_balance_of",
    args: { account_id: id },
    blockQuery: { finality: "optimistic" },
  });
  return BigInt(b as string);
}
async function registerOnToken(id: string) {
  const reg = await provider.callFunction({
    contractId: TOKEN,
    method: "storage_balance_of",
    args: { account_id: id },
  });
  if (reg) return;
  await parent.callFunction({
    contractId: TOKEN,
    methodName: "storage_deposit",
    args: { account_id: id },
    gas: teraToGas("30"),
    deposit: nearToYocto("0.00125"),
  });
}
async function fails(f: () => Promise<unknown>): Promise<string> {
  try {
    await f();
    return "";
  } catch (e) {
    return String((e as Error).message ?? e).slice(0, 160);
  }
}
function loadSecret(file: string): Uint8Array {
  const path = `${keysDir}${file}`;
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify({ sk: hex(ed25519.utils.randomSecretKey()) }), { mode: 0o600 });
  }
  return unhex(JSON.parse(readFileSync(path, "utf8")).sk as string);
}
/** Re-reads until `ok` holds (up to 8 s): an RPC node can serve a view from a block just before
 *  the transaction it already reported. */
async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  let v = await read();
  for (let i = 0; i < 16 && !ok(v); i++) {
    await Bun.sleep(500);
    v = await read();
  }
  return v;
}
function short(id: string) {
  return id.split(".")[0] ?? id;
}
