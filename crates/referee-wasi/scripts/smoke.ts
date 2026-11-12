// Smoke test of the deployed referee on hosted OutLayer testnet: calls every command once and
// checks what it returns with the TS protocol package (the same bytes the contract and the
// phones use). Run from the repo root: `bun crates/referee-wasi/scripts/smoke.ts`.
import { createPublicKey, generateKeyPairSync, randomBytes, verify } from "node:crypto";
// Only for checking the model's TEE signature (Ethereum personal_sign); already installed
// under the protocol package, so imported by path rather than installed here.
import { secp256k1 } from "../../../packages/protocol/node_modules/@noble/curves/secp256k1.js";
import { keccak_256 } from "../../../packages/protocol/node_modules/@noble/hashes/sha3.js";
import {
  boxPublicKey,
  buildRing,
  concat,
  decodeLogEntry,
  decodePlayerKeys,
  decodeSignedVerdict,
  derivePlayerKey,
  deriveTagKey,
  encodeBatchEnvelope,
  equal,
  fromHex,
  type LogEntry,
  merkleLeaf,
  merkleRoot,
  open,
  playersHash,
  ringCommit,
  seal,
  sha256,
  sortAccounts,
  toHex,
  utf8,
  verdictDigest,
  Writer,
} from "../../../packages/protocol/src/index.ts";
import { balance, type Json, OWNER, ok, refused, spend } from "./lib.ts";

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
type Player = { account: string; boxSk: Uint8Array; appAttestPk: Uint8Array };
const players: Player[] = [];
for (const name of ["ana", "bo", "cy"]) {
  const account = `${name}-${run}.${OWNER}`;
  const boxSk = new Uint8Array(randomBytes(32));
  const p256 = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "jwk" });
  const appAttestPk = concat(Uint8Array.of(4), jwkBytes(p256.x), jwkBytes(p256.y));
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
    .fixed(boxPublicKey(boxSk), 32)
    .fixed(nearPk, 32)
    .fixed(uuidBytes(c.id), 16)
    .bytes();
  const receipt = unb64(r.receipt);
  check(equal(receipt, expected), `${account}: receipt is borsh(Device) with this call's id`);
  check(
    ed25519Verify(refereePk, sha256(concat(utf8("tail/enroll-receipt/v1"), receipt)), unb64(r.sig)),
    `${account}: receipt signed by referee_pk`,
  );
  players.push({ account, boxSk, appAttestPk });
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
const opened = new Map<string, ReturnType<typeof decodePlayerKeys>>();
for (const p of players) {
  const entry = st.keys.find((k: Json) => k.account_id === p.account);
  const pk = decodePlayerKeys(open(p.boxSk, unb64(entry.sealed), "tail/keys"));
  check(
    pk.player === sorted.indexOf(p.account) &&
      equal(pk.matchId, matchId) &&
      accounts.includes(pk.target) &&
      pk.target !== p.account,
    `${p.account}: sealed PlayerKeys open with the player's box key (player ${pk.player}, target ${pk.target})`,
  );
  opened.set(p.account, pk);
}
const kTags = [...opened.values()].map((k) => toHex(k.kTag));
check(new Set(kTags).size === 1, "every player got the same k_tag");
const log: LogEntry[] = st.log.map((e: string) => decodeLogEntry(unb64(e)));

// ── tick: a batch with no App Attest assertion, and garbage ─────────────────────
console.log("tick");
const ana = players[0] as Player;
const batch = {
  matchId,
  player: sorted.indexOf(ana.account),
  seq: 0,
  prev: new Uint8Array(32),
  tMs: startMs + 10_000n,
  fixes: [],
  sightings: [],
  actions: [],
};
const sealedBatch = seal(boxPk, encodeBatchEnvelope({ batch, assertion: new Uint8Array(0) }), "tail/batch");
const { result: t1, call: t1Call } = await ok("tick", {
  match_id: b64(matchId),
  state: st.state,
  last_seq: 1,
  now_ms: Number(startMs + 10_000n),
  batches: [b64(sealedBatch), b64(randomBytes(80))],
});
console.log(
  `  tick 1: wall ${t1Call.wall.toFixed(0)} ms, enclave ${t1Call.enclave} ms, state ${t1.state_bytes} B`,
);
check(
  t1.opened === 1 && t1.unopened.length === 1 && t1.unopened[0].index === 1,
  "the sealed batch opens; the garbage one does not",
);
check(
  t1.rejected.length === 1 && String(t1.rejected[0].reason).startsWith("Assertion"),
  `the engine rejects the unasserted batch (${t1.rejected[0]?.reason})`,
);
log.push(...t1.log.map((e: string) => decodeLogEntry(unb64(e))));
const ahead = await refused("tick", {
  match_id: b64(matchId),
  state: t1.state,
  last_seq: t1.seq,
  now_ms: Date.now() + 3_600_000,
});
check(ahead.includes("ahead of the referee clock"), "now_ms ahead of the referee clock is refused");
const { result: t2, call: t2Call } = await ok("tick", {
  match_id: b64(matchId),
  state: t1.state,
  last_seq: t1.seq,
  now_ms: Number(endMs),
});
console.log(`  tick 2: wall ${t2Call.wall.toFixed(0)} ms, enclave ${t2Call.enclave} ms`);
check(t2.tick_no === 2 && t2.over === true, "tick 2 at end_ms continues from tick 1 and ends the match");
log.push(...t2.log.map((e: string) => decodeLogEntry(unb64(e))));
const otherMatch = await refused("tick", {
  match_id: b64(randomBytes(16)),
  state: t2.state,
  last_seq: t2.seq,
});
check(otherMatch.includes("does not open"), "a state blob does not open for another match id");

// ── voice ───────────────────────────────────────────────────────────────────────
console.log("voice");
const { result: v, call: vCall } = await ok("voice", {
  hint_id: 0,
  hint: 0,
  value: 0,
  question: "am I close?",
});
console.log(
  `  "${v.text}" (${v.source}, model ${v.latency_ms} ms, call wall ${vCall.wall.toFixed(0)} ms, kind ${v.signature_kind})`,
);
check(v.text_sha256 === toHex(sha256(utf8(v.text))), "text_sha256 = sha256(text)");
// borsh HintReceipt: u32 hint_id ‖ string chat_id ‖ [u8;32] text_hash ‖ bytes signature ‖ string address
const receipt = unb64(v.receipt);
const chatLen = new DataView(receipt.buffer, receipt.byteOffset).getUint32(4, true);
check(
  toHex(receipt.slice(8 + chatLen, 8 + chatLen + 32)) === v.text_sha256,
  "the HintReceipt carries the text hash",
);
if (v.source === "model") {
  check(v.signature, `model TEE signature fetched (${v.signature_error ?? "no error"})`);
  check(
    v.signed_text.endsWith(`:${v.request_sha256}:${v.response_sha256}`),
    "signed text covers the exact request and response",
  );
  const sig = fromHex(v.signature.replace(/^0x/, ""));
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
    address === String(v.signing_address).toLowerCase(),
    `ECDSA signature recovers signing_address ${v.signing_address}`,
  );
} else {
  console.log(`  template fallback: ${v.fallback_reason}`);
}

// ── end ─────────────────────────────────────────────────────────────────────────
console.log("end");
const { result: e } = await ok("end", { match_id: b64(matchId), state: t2.state, last_seq: t2.seq });
const endV = decodeSignedVerdict(unb64(e.verdicts[0]));
check(endV.seq === t2.seq + 1 && endV.body.kind === "End", `End verdict, seq ${t2.seq + 1}`);
check(ed25519Verify(refereePk, verdictDigest(endV), endV.sig), "End signature verifies with referee_pk");
if (endV.body.kind !== "End") throw new Error("unreachable");
log.push(...e.log.map((x: string) => decodeLogEntry(unb64(x))));
check(
  equal(ringCommit(endV.body.vrfSignature), startV.body.ringCommit),
  "ring_commit = SHA256(tail/ring ‖ revealed vrf_signature)",
);
check(endV.body.alpha.endsWith(`:${toHex(matchId)}`), "VRF alpha ends with the match id hex seed");
check(
  ed25519Verify(fromHex(keys.vrf_pk), utf8(endV.body.alpha), endV.body.vrfSignature),
  "VRF signature verifies over alpha with the OutLayer VRF key",
);
const before = log.slice(0, Number(endV.body.logSize));
check(
  log.length === Number(endV.body.logSize) + 1 && equal(endV.body.root, merkleRoot(before.map(merkleLeaf))),
  "End root = Merkle root of the returned log before End",
);

const stale = await refused("tick", { match_id: b64(matchId), state: t1.state, last_seq: endV.seq });
check(stale.includes("rollback"), "an old state blob after End is refused as a rollback");
const ended = await refused("tick", { match_id: b64(matchId), state: e.state, last_seq: endV.seq });
check(ended.includes("NotRunning"), "the End state blob refuses further ticks");

// ── declassify ──────────────────────────────────────────────────────────────────
console.log("declassify");
const { result: d } = await ok("declassify", { match_id: b64(matchId) });
const km = fromHex(d.k_m);
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
