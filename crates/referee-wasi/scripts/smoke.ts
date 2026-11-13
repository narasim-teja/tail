// Smoke test of the deployed referee on hosted OutLayer testnet: calls every command once and
// checks what it returns with the TS protocol package (the same bytes the contract and the
// phones use). Run from the repo root: `bun crates/referee-wasi/scripts/smoke.ts`, or against the
// local test referee: `REFEREE_MODE=local bun crates/referee-wasi/scripts/smoke.ts`.
import { createPublicKey, generateKeyPairSync, randomBytes, verify } from "node:crypto";
// Only for checking the model's TEE signature (Ethereum personal_sign); already installed
// under the protocol package, so imported by path rather than installed here.
import { secp256k1 } from "../../../packages/protocol/node_modules/@noble/curves/secp256k1.js";
import { keccak_256 } from "../../../packages/protocol/node_modules/@noble/hashes/sha3.js";
import {
  type Batch,
  badLogSalts,
  batchClientDataHash,
  batchHash,
  boxPublicKey,
  buildRing,
  concat,
  decodeLogEntry,
  decodeSignedVerdict,
  derivePlayerKey,
  deriveTagKey,
  encodeBatchEnvelope,
  equal,
  type Fix,
  fromHex,
  type Bytes as Hash,
  type LogEntry,
  merkleEmptyRoot,
  merkleLeaf,
  merkleRoot,
  openSignedHud,
  openSignedPlayerKeys,
  openSignedVoiceLine,
  PHONE_PAD,
  type PlayerKeys,
  playersHash,
  RejectCode,
  ringCommit,
  SealContext,
  seal,
  sha256,
  sortAccounts,
  toHex,
  utf8,
  verdictChainBreak,
  verdictDigest,
  verifyConsistency,
  Writer,
} from "../../../packages/protocol/src/index.ts";
import { assertion, balance, type Json, OWNER, ok, p256, refused, spend } from "./lib.ts";

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const jwkBytes = (v: string | undefined) => {
  if (!v) throw new Error("JWK export lacks a coordinate");
  return new Uint8Array(Buffer.from(v, "base64url"));
};
const uuidBytes = (s: string) => fromHex(s.replace(/-/g, ""));
const check = (cond: unknown, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`  ok  ${what}`);
};
const ed25519Verify = (pk: Uint8Array, msg: Uint8Array, sig: Uint8Array) =>
  verify(
    null,
    msg,
    createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(pk).toString("base64url") },
      format: "jwk",
    }),
    sig,
  );

console.log(`balance before: ${await balance()}`);

// ── pubkeys ─────────────────────────────────────────────────────────────────────
console.log("pubkeys");
const { result: keys } = await ok("pubkeys");
const refereePk = unb64(keys.referee_pk);
const boxPk = unb64(keys.referee_box_pk);
check(refereePk.length === 32 && boxPk.length === 32, "32-byte referee_pk and referee_box_pk");
check(
  ed25519Verify(refereePk, sha256(concat(utf8("tail/referee-box/v1"), boxPk)), unb64(keys.box_pk_sig)),
  "box pk is signed by referee_pk under tail/referee-box/v1",
);
console.log(`  referee_pk ${keys.referee_pk}  box_pk ${keys.referee_box_pk}  vrf_pk ${keys.vrf_pk}`);

// ── enroll three test players ───────────────────────────────────────────────────
console.log("enroll");
const run = toHex(randomBytes(3));
type Player = { account: string; boxSk: Uint8Array; sk: Uint8Array; appAttestPk: Uint8Array };
const players: Player[] = [];
for (const name of ["ana", "bo", "cy"]) {
  const account = `${name}-${run}.${OWNER}`;
  const boxSk = new Uint8Array(randomBytes(32));
  const sk = p256.utils.randomSecretKey();
  const appAttestPk = p256.getPublicKey(sk, false);
  const ed = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" });
  const nearPk = jwkBytes(ed.x);
  const { result: r, call: c } = await ok("enroll", {
    account_id: account,
    app_attest_pk: b64(appAttestPk),
    player_box_pk: b64(boxPublicKey(boxSk)),
    near_pk: b64(nearPk),
  });
  const expected = new Writer()
    .string(account)
    .fixed(appAttestPk, 65)
    .bool(false) // a software key: the referee must run with ALLOW_UNATTESTED=1
    .fixed(boxPublicKey(boxSk), 32)
    .fixed(nearPk, 32)
    .fixed(uuidBytes(c.id), 16)
    .bytes();
  const receipt = unb64(r.receipt);
  check(r.attested === false, `${account}: an unattested key is marked so`);
  check(r.referee_pk === keys.referee_pk, `${account}: the receipt names its referee`);
  check(equal(receipt, expected), `${account}: receipt is borsh(Device) with this call's id`);
  check(
    ed25519Verify(refereePk, sha256(concat(utf8("tail/enroll-receipt/v1"), receipt)), unb64(r.sig)),
    `${account}: receipt signed by referee_pk`,
  );
  players.push({ account, boxSk, sk, appAttestPk });
}

// ── start ───────────────────────────────────────────────────────────────────────
// Started 2 minutes ago and 1 minute long, so a tick at end_ms (in the past, never ahead of
// the referee clock) ends it and `end` can run. scripts/match.ts plays a full match.
console.log("start");
const matchId = new Uint8Array(randomBytes(16));
const startMs = BigInt(Date.now() - 120_000);
const durationMs = 60_000n;
const endMs = startMs + durationMs;
const accounts = players.map((p) => p.account);
const { result: st, call: startCall } = await ok("start", {
  match_id: b64(matchId),
  players: accounts,
  start_ms: Number(startMs),
  duration_ms: Number(durationMs),
  stake: "1000000",
  zone: { lat_e7: 423_601_000, lon_e7: -710_589_000, radius_m: 500 },
});
console.log(`  start: wall ${startCall.wall.toFixed(0)} ms, enclave ${startCall.enclave} ms`);
const startV = decodeSignedVerdict(unb64(st.verdicts[0]));
check(
  st.verdicts.length === 1 &&
    startV.body.kind === "Start" &&
    startV.seq === 1 &&
    equal(startV.matchId, matchId),
  "one Start verdict, seq 1, this match",
);
check(equal(startV.callId, uuidBytes(startCall.id)), "verdict call_id = the OutLayer call id");
check(
  ed25519Verify(refereePk, verdictDigest(startV), startV.sig),
  "Start signature verifies with referee_pk over verdictDigest",
);
if (startV.body.kind !== "Start") throw new Error("unreachable");
check(equal(startV.body.playersHash, playersHash(accounts)), "players_hash matches the TS playersHash");
check(startV.body.startMs === startMs && startV.body.endMs === endMs, "end_ms = start_ms + duration_ms");
const sorted = sortAccounts(accounts);
const opened = new Map<string, PlayerKeys>();
for (const p of players) {
  const entry = st.keys.find((k: Json) => k.account_id === p.account);
  const pk = openSignedPlayerKeys(p.boxSk, unb64(entry.sealed), refereePk);
  check(
    pk.player === sorted.indexOf(p.account) &&
      equal(pk.matchId, matchId) &&
      accounts.includes(pk.target) &&
      pk.target !== p.account,
    `${p.account}: sealed, signed PlayerKeys open with the player's box key (player ${pk.player}, target ${pk.target})`,
  );
  opened.set(p.account, pk);
}
const kTags = [...opened.values()].map((k) => toHex(k.kTag));
check(new Set(kTags).size === 1, "every player got the same k_tag");
// The relay keeps the leaf hashes and the sealed log; the plaintext comes from declassify.
check(
  st.log === undefined && st.leaves.length === players.length + 1,
  "start: leaves for 3 Enrolled + Start, no plaintext log",
);
const leaves: Hash[] = [...st.leaves.map(unb64)];
const logSealed: string[] = [st.log_sealed];
const proofs: { seq: number; from_size: number; path: string[] }[] = [];
const keep = (r: Json) => {
  leaves.push(...r.leaves.map(unb64));
  logSealed.push(r.log_sealed);
  proofs.push(...r.proofs);
};

// ── tick: a hint, three real batches, one without an App Attest assertion, and garbage ──
console.log("tick");
const ana = players[0] as Player;
const asker = sorted.indexOf(ana.account);
const fix = (t: bigint, i: number): Fix => ({
  tMs: t - 1000n,
  latE7: 423_601_000 + i * 100,
  lonE7: -710_589_000,
  accM: 5,
  speedCmps: 0,
  flags: 0,
});
const sealBatch = (batch: Batch, a: Uint8Array) =>
  b64(seal(boxPk, encodeBatchEnvelope({ batch, assertion: a }), SealContext.batch));
const t1Ms = startMs + 10_000n;
const firstBatches = players.map((p) => {
  const player = sorted.indexOf(p.account);
  const batch: Batch = {
    matchId,
    player,
    seq: 0,
    prev: new Uint8Array(32),
    tMs: t1Ms,
    fixes: [fix(t1Ms, player)],
    sightings: [],
    actions: p === ana ? [{ kind: "Hint", hint: 0, nonce: 1, text: "am I close?" }] : [],
  };
  return { batch, sealed: sealBatch(batch, assertion(p.sk, batchClientDataHash(batch), 1)) };
});
const last = firstBatches[2] as (typeof firstBatches)[number];
const unasserted: Batch = { ...last.batch, seq: 1, prev: batchHash(last.batch), fixes: [], actions: [] };
const { result: t1, call: t1Call } = await ok("tick", {
  match_id: b64(matchId),
  state: st.state,
  last_seq: 1,
  now_ms: Number(t1Ms),
  batches: [
    ...firstBatches.map((b) => b.sealed),
    sealBatch(unasserted, new Uint8Array(0)),
    b64(randomBytes(80)),
  ],
});
console.log(
  `  tick 1: wall ${t1Call.wall.toFixed(0)} ms, enclave ${t1Call.enclave} ms, state ${t1.state_bytes} B`,
);
keep(t1);
check(
  t1.opened === 4 && t1.unopened.length === 1 && t1.unopened[0].index === 4,
  "the sealed batches open; the garbage one does not",
);
check(
  t1.rejected.length === 1 && t1.rejected[0].reason === RejectCode.Assertion && t1.rejected[0].seq === 1,
  `the engine rejects the unasserted batch with RejectCode.Assertion (${t1.rejected[0]?.reason})`,
);
const hintV = decodeSignedVerdict(unb64(t1.verdicts[0]));
check(
  hintV.body.kind === "Hint" && hintV.body.from === asker && hintV.body.hint === 0,
  "a Hint verdict for the asker, with its kind",
);
check(
  t1.hints.length === 1 && t1.hints[0].player === asker && Object.keys(t1.hints[0]).length === 2,
  "the hint leaves as {player, blob} and nothing else",
);
const anaHud = openSignedHud(
  ana.boxSk,
  unb64(t1.huds.find((h: Json) => h.player === asker).sealed),
  refereePk,
);
check(
  anaHud.hintFact?.hint === 0 &&
    anaHud.logSize === BigInt(leaves.length) &&
    equal(anaHud.root, merkleRoot(leaves)) &&
    anaHud.nextSeq === 1,
  "the asker's signed HUD carries the fact, the log so far and its next seq",
);
const ahead = await refused("tick", {
  match_id: b64(matchId),
  state: t1.state,
  last_seq: t1.seq,
  now_ms: Date.now() + 3_600_000,
});
check(ahead.includes("ahead of the referee clock"), "now_ms ahead of the referee clock is refused");

// ── voice ───────────────────────────────────────────────────────────────────────
console.log("voice");
const { result: v, call: vCall } = await ok("voice", { state: t1.state, blob: t1.hints[0].blob });
const line = openSignedVoiceLine(ana.boxSk, unb64(v.sealed), refereePk);
console.log(
  `  "${line.text}" (${v.signed_text ? "model, signed" : "no model signature"}, call wall ${vCall.wall.toFixed(0)} ms)`,
);
check(
  line.player === asker && line.hintId === 0 && equal(line.matchId, matchId) && line.text.length > 0,
  "the Handler line opens with the asker's box key and is signed by referee_pk",
);
check(
  Object.keys(v).sort().join() === "hint_id,player,receipt,sealed,signed_text",
  "the relay sees who asked, the sealed line, the signed text and the receipt; nothing names the fact or the words",
);
check(unb64(v.sealed).length === 32 + PHONE_PAD + 16, "the Handler line is padded to PHONE_PAD");
check(
  equal(unb64(v.receipt).subarray(4, 36), sha256(unb64(v.sealed))),
  "the receipt names the sealed line it stands for",
);

const { result: t2, call: t2Call } = await ok("tick", {
  match_id: b64(matchId),
  state: t1.state,
  last_seq: t1.seq,
  now_ms: Number(endMs),
  receipts: [v.receipt],
});
console.log(`  tick 2: wall ${t2Call.wall.toFixed(0)} ms, enclave ${t2Call.enclave} ms`);
check(t2.tick_no === 2 && t2.over === true, "tick 2 at end_ms continues from tick 1 and ends the match");
keep(t2);
check(v.leaves === undefined, "voice names no leaf: the receipt is salted where it lands");
const otherMatch = await refused("tick", {
  match_id: b64(randomBytes(16)),
  state: t2.state,
  last_seq: t2.seq,
});
check(otherMatch.includes("does not open"), "a state blob does not open for another match id");

// ── end ─────────────────────────────────────────────────────────────────────────
console.log("end");
const { result: e } = await ok("end", { match_id: b64(matchId), state: t2.state, last_seq: t2.seq });
const endV = decodeSignedVerdict(unb64(e.verdicts[0]));
check(endV.seq === t2.seq + 1 && endV.body.kind === "End", `End verdict, seq ${t2.seq + 1}`);
check(ed25519Verify(refereePk, verdictDigest(endV), endV.sig), "End signature verifies with referee_pk");
if (endV.body.kind !== "End") throw new Error("unreachable");
keep(e);
check(
  equal(ringCommit(endV.body.vrfSignature), startV.body.ringCommit),
  "ring_commit = SHA256(tail/ring ‖ revealed vrf_signature)",
);
check(endV.body.alpha.endsWith(`:${toHex(matchId)}`), "VRF alpha ends with the match id hex seed");
check(
  ed25519Verify(fromHex(keys.vrf_pk), utf8(endV.body.alpha), endV.body.vrfSignature),
  "VRF signature verifies over alpha with the OutLayer VRF key",
);
check(
  leaves.length === Number(endV.body.logSize) + 1 &&
    equal(endV.body.root, merkleRoot(leaves.slice(0, Number(endV.body.logSize)))),
  "End root = Merkle root of the leaves before End",
);
check(
  proofs.length === 1 &&
    proofs[0]?.from_size === 0 &&
    verifyConsistency(0, Number(endV.body.logSize), merkleEmptyRoot(), endV.body.root, []),
  "End carries the consistency proof from size 0 (no checkpoint in a one-minute match)",
);

const stale = await refused("tick", { match_id: b64(matchId), state: t1.state, last_seq: endV.seq });
check(stale.includes("rollback"), "an old state blob after End is refused as a rollback");
const ended = await refused("tick", { match_id: b64(matchId), state: e.state, last_seq: endV.seq });
check(ended.includes("NotRunning"), "the End state blob refuses further ticks");

// ── declassify ──────────────────────────────────────────────────────────────────
console.log("declassify");
const { result: d } = await ok("declassify", { match_id: b64(matchId), log_sealed: logSealed });
const log: LogEntry[] = d.log.map((x: string) => decodeLogEntry(unb64(x)));
check(
  log.length === leaves.length && log.every((x, i) => equal(merkleLeaf(x), leaves[i] as Hash)),
  "the declassified log is exactly the leaves held during play",
);
check(
  log.filter((x) => x.kind === "Tick").length === 2 &&
    log.some((x) => x.kind === "Rejected" && x.code === RejectCode.Assertion) &&
    log.slice(0, 3).every((x) => x.kind === "Enrolled" && !x.attested),
  "the log has 3 Enrolled (unattested ghosts), 2 Ticks and the Rejected batch",
);
check(
  verdictChainBreak([startV, hintV, endV], refereePk) === undefined,
  "Start → Hint → End are chained by prev",
);
// The Handler's signature as the replay checks it: the logged receipt and `signed_text`.
const receiptEntry = log.find((x) => x.kind === "HintReceipt");
check(receiptEntry?.kind === "HintReceipt", "the voice receipt joined the log");
if (receiptEntry?.kind === "HintReceipt" && v.signed_text) {
  check(
    /^.+:[0-9a-f]{64}:[0-9a-f]{64}$/.test(v.signed_text),
    "signed text is model:sha256(request):sha256(response)",
  );
  const sig = receiptEntry.signature;
  const msg = utf8(v.signed_text);
  const digest = keccak_256(concat(utf8(`\x19Ethereum Signed Message:\n${msg.length}`), msg));
  const recovered = secp256k1.recoverPublicKey(
    concat(Uint8Array.of((sig[64] as number) - 27), sig.slice(0, 64)),
    digest,
    { prehash: false },
  );
  const uncompressed = secp256k1.Point.fromBytes(recovered).toBytes(false);
  const address = `0x${toHex(keccak_256(uncompressed.slice(1)).slice(12))}`;
  check(
    address === receiptEntry.signingAddress.toLowerCase(),
    `the logged ECDSA signature over signed_text recovers ${receiptEntry.signingAddress}`,
  );
}

const km = fromHex(d.k_m);
check(badLogSalts(km, log).length === 0, "every log salt is the one the declassified K_m gives its index");
const ring = buildRing(accounts, endV.body.vrfSignature);
check(
  JSON.stringify(d.ring) === JSON.stringify(ring),
  "declassified ring = buildRing(players, vrf_signature)",
);
for (const [account, pk] of opened) {
  check(
    equal(pk.kTag, deriveTagKey(km)) && equal(pk.kPlayer, derivePlayerKey(km, pk.player)),
    `${account}: keys derive from the declassified K_m`,
  );
  const k = ring.indexOf(account);
  check(pk.target === ring[(k + 1) % ring.length], `${account}: target is the ring successor`);
}

const s = spend();
console.log(
  `\nALL OK. ${s.calls} calls, $${s.usd.toFixed(4)} (compute_cost sum). balance after: ${await balance()}`,
);
