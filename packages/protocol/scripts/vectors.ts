// Writes the golden vectors from deterministic inputs. TS tests check these files stay
// in sync with the code; the Rust crate tests (crates/tail-protocol) reproduce every value
// (carry.json excepted: mesh carry is phone ↔ relay, both TypeScript).
// Regenerate only on a deliberate wire-format change: `bun run --cwd packages/protocol vectors`.

import { writeFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  hudDigest as authHudDigest,
  replayDigest as authReplayDigest,
  requestDigest as authRequestDigest,
  type Batch,
  batchClientDataHash,
  batchHash,
  beaconTag,
  beaconToken,
  boxPublicKey,
  buildRing,
  type CarryRequest,
  carryAckDigest,
  consistencyProof,
  derivePlayerKey,
  deriveTagKey,
  encodeBatch,
  encodeBatchEnvelope,
  encodeCarryAck,
  encodeCarryRequest,
  encodeHud,
  encodeLogEntry,
  encodePlayerKeys,
  encodePresenceProof,
  encodeSignedHud,
  encodeSignedPlayerKeys,
  encodeSignedVerdict,
  encodeSignedVoiceLine,
  encodeVerdictPayload,
  encodeVoiceLine,
  enrollClientDataHash,
  FixFlag,
  fromHex,
  HintKind,
  type Hud,
  hudSigDigest,
  keysSigDigest,
  type LogEntry,
  merkleLeaf,
  merklePeaks,
  merkleProof,
  merkleRoot,
  type PlayerKeys,
  padCarry,
  playersHash,
  presenceProof,
  RejectCode,
  ringCommit,
  SealContext,
  sealCarryWith,
  sealWith,
  sha256,
  signCarryAck,
  signHud,
  signPlayerKeys,
  signVerdict,
  signVoiceLine,
  TargetStatus,
  toHex,
  tokenToUuid,
  utf8,
  type Verdict,
  type VerdictPayload,
  type VoiceLine,
  verdictDigest,
  voiceSigDigest,
} from "../src/index.ts";

const out = new URL("../vectors/", import.meta.url).pathname;
const seed = (label: string) => sha256(utf8(`tail/vectors/${label}`));
const hex = toHex;
const json = (v: unknown) =>
  `${JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x instanceof Uint8Array ? hex(x) : x), 2)}\n`;
const write = (name: string, v: unknown) => writeFileSync(`${out}${name}.json`, json(v));

// ── beacon ──
const km = seed("K_m");
const kTag = deriveTagKey(km);
const kPlayers = [0, 1, 2].map((i) => derivePlayerKey(km, i));
write("beacon", {
  K_m: km,
  K_tag: kTag,
  K_p: kPlayers,
  tokens: [0, 1, 2].flatMap((player) =>
    [0, 1, 4_000_000].map((epoch) => {
      const token = beaconToken(kTag, kPlayers[player] as Uint8Array, epoch);
      return { player, epoch, tag: beaconTag(kTag, epoch), token, uuid: tokenToUuid(token) };
    }),
  ),
});

// ── batch ──
const matchId = seed("match").slice(0, 16);
const batch: Batch = {
  matchId,
  player: 1,
  seq: 7,
  prev: seed("prev"),
  tMs: 1_794_514_000_123n,
  fixes: [
    { tMs: 1_794_514_000_000n, latE7: 423_550_000, lonE7: -710_650_000, accM: 8, speedCmps: 140, flags: 0 },
    {
      tMs: 1_794_514_001_000n,
      latE7: -1,
      lonE7: 2_147_483_647,
      accM: 65_535,
      speedCmps: 0,
      flags: FixFlag.SimulatedBySoftware,
    },
  ],
  sightings: [
    {
      epoch: 4_000_000,
      token: beaconToken(kTag, kPlayers[0] as Uint8Array, 4_000_000),
      rssiMax: -61,
      rssiMed: -128,
      n: 255,
    },
  ],
  actions: [
    { kind: "Hint", hint: 1, nonce: 42, text: "warmer? 🧊" },
    { kind: "Hint", hint: 0, nonce: 43 },
    { kind: "Strike", nonce: 44 },
  ],
};
const assertion = seed("assertion");
write("batch", {
  input: batch,
  borsh: encodeBatch(batch),
  hash: batchHash(batch),
  clientDataHash: batchClientDataHash(batch),
  envelope: { assertion, borsh: encodeBatchEnvelope({ batch, assertion }) },
  enroll: {
    challenge: seed("challenge"),
    accountId: "alice.tail.testnet",
    playerBoxPk: seed("box"),
    nearPk: seed("near"),
    clientDataHash: enrollClientDataHash(seed("challenge"), "alice.tail.testnet", seed("box"), seed("near")),
  },
});

// ── verdicts (v2: each payload chains to the previous verdict's digest) ──
const refereeSk = seed("referee");
const refereePk = ed25519.getPublicKey(refereeSk);
const callId = fromHex("8579446759a1412f8e65eb3d13b5cb6a");
const vrfSignature = new Uint8Array([...seed("vrf-a"), ...seed("vrf-b")]);
const bodies: Verdict[] = [
  {
    kind: "Start",
    playersHash: seed("players"),
    ringCommit: ringCommit(vrfSignature),
    startMs: 1_794_514_000_000n,
    endMs: 1_794_517_600_000n,
  },
  { kind: "Hint", from: 0, to: 1, amount: 20_000n, hintId: 3, hint: HintKind.Near },
  { kind: "Tag", hunter: 2, target: 0 },
  { kind: "Forfeit", player: 1, to: 2 },
  { kind: "Checkpoint", logSize: 1234n, root: seed("root") },
  {
    kind: "End",
    alpha: "vrf:100000042278:tail-dev.testnet:00112233",
    vrfSignature,
    logSize: 99_999n,
    root: seed("root2"),
  },
];
let prev = new Uint8Array(32);
write("verdicts", {
  refereeSeed: refereeSk,
  refereePk,
  matchId,
  callId,
  verdicts: bodies.map((body, i) => {
    const payload: VerdictPayload = { matchId, seq: i + 1, prev, callId, body };
    const digest = verdictDigest(payload);
    const signed = signVerdict(payload, refereeSk);
    prev = digest;
    return {
      seq: i + 1,
      prev: payload.prev,
      body,
      payload: encodeVerdictPayload(payload),
      digest,
      sig: signed.sig,
      signed: encodeSignedVerdict(signed),
    };
  }),
});

// ── merkle (v1 entries; unchanged) ──
const entries: LogEntry[] = [
  { kind: "Batch", player: 0, seq: 0, hash: seed("b0") },
  { kind: "Contact", a: 0, b: 1, epoch: 4_000_000 },
  { kind: "Verdict", seq: 1, digest: seed("v1") },
  {
    kind: "HintReceipt",
    hintId: 3,
    chatId: "chatcmpl-abc",
    textHash: seed("t"),
    signature: seed("s"),
    signingAddress: "0xabc",
  },
  { kind: "Batch", player: 1, seq: 0, hash: seed("b1") },
  { kind: "Contact", a: 1, b: 2, epoch: 4_000_001 },
  { kind: "Verdict", seq: 2, digest: seed("v2") },
];
const leaves = entries.map(merkleLeaf);
write("merkle", {
  entries: entries.map((e) => ({ entry: e, borsh: encodeLogEntry(e) })),
  leaves,
  roots: Array.from({ length: entries.length + 1 }, (_, n) => ({
    size: n,
    root: merkleRoot(leaves.slice(0, n)),
  })),
  proofs: leaves.map((_, i) => ({ index: i, size: leaves.length, proof: merkleProof(leaves, i) })),
});

// ── log entries added in v2 (tags 4..7) ──
const entriesV2: LogEntry[] = [
  { kind: "Enrolled", player: 0, account: "alice.tail.testnet", keyHash: seed("key0"), attested: true },
  { kind: "Enrolled", player: 1, account: "bob.tail.testnet", keyHash: seed("key1"), attested: false },
  { kind: "Tick", tickNo: 17, nowMs: 1_794_514_170_000n, callId },
  { kind: "Rejected", player: 1, seq: 9, hash: seed("b9"), code: RejectCode.Teleport },
  { kind: "Evidence", hunter: 2, target: 0, strikeSeq: 31, strikeEpoch: 40, epochs: [33, 35, 36, 38, 40] },
  { kind: "Evidence", hunter: 0, target: 1, strikeSeq: 0, strikeEpoch: 0, epochs: [] },
];
write("log", {
  entries: entriesV2.map((e) => ({ entry: e, borsh: encodeLogEntry(e), leaf: merkleLeaf(e) })),
});

// ── consistency proofs (RFC 9162 2.1.4) ──
const cLeaves = Array.from({ length: 70 }, (_, i) => seed(`leaf/${i}`));
const pairs: [number, number][] = [
  [0, 5],
  [1, 1],
  [1, 2],
  [3, 7],
  [4, 8],
  [5, 13],
  [6, 8],
  [7, 70],
  [32, 70],
  [64, 70],
  [69, 70],
];
write("consistency", {
  leaves: cLeaves,
  proofs: pairs.map(([m, n]) => ({
    m,
    n,
    oldRoot: merkleRoot(cLeaves.slice(0, m)),
    newRoot: merkleRoot(cLeaves.slice(0, n)),
    peaks: merklePeaks(cLeaves.slice(0, m)),
    proof: consistencyProof(cLeaves.slice(0, n), m),
  })),
});

// ── presence proof ──
const players = ["alice.tail.testnet", "bob.tail.testnet", "carol.tail.testnet"];
const presenceLog: LogEntry[] = [...entriesV2.slice(0, 2), ...entries];
const contract = "tail-dev.testnet";
const proof = presenceProof({ matchId, contract, log: presenceLog, index: 3, size: 8, players });
write("presence", {
  players,
  roots: [5, 8, presenceLog.length].map((size) => ({
    logSize: size,
    root: merkleRoot(presenceLog.slice(0, size).map(merkleLeaf)),
  })),
  proof: { input: proof, borsh: encodePresenceProof(proof) },
  expect: { a: 0, b: 1, epoch: 4_000_000 },
});

// ── ring ──
const accounts = [
  "dave.tail.testnet",
  "alice.tail.testnet",
  "bob.tail.testnet",
  "carol.tail.testnet",
  "Zed.tail.testnet",
];
write("ring", {
  accounts,
  playersHash: playersHash(accounts),
  vrfSignature,
  ringCommit: ringCommit(vrfSignature),
  ring: buildRing(accounts, vrfSignature),
});

// ── sealing primitive ──
const recipientSk = seed("recipient");
const recipientPk = boxPublicKey(recipientSk);
const keys: PlayerKeys = {
  matchId,
  player: 2,
  startMs: 1_794_514_000_000n,
  endMs: 1_794_517_600_000n,
  kTag,
  kPlayer: kPlayers[2] as Uint8Array,
  target: "alice.tail.testnet",
};
const plaintext = encodePlayerKeys(keys);
// Encodings of every low-order X25519 point, canonical and not, with and without bit 255.
const lowOrder = [
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0100000000000000000000000000000000000000000000000000000000000000",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
  "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
].flatMap((h) => [h, h.slice(0, 62) + (Number.parseInt(h.slice(62), 16) | 0x80).toString(16)]);
write("seal", {
  recipientSk,
  recipientPk,
  ephSk: seed("eph"),
  context: "tail/keys",
  plaintext,
  sealed: sealWith(seed("eph"), recipientPk, plaintext, "tail/keys"),
  playerKeys: { input: keys, borsh: plaintext },
  lowOrder,
});

// ── referee → phone: HUD v2, keys and Handler lines, signed then sealed ──
const hud: Hud = {
  matchId,
  player: 2,
  tick: 17,
  epoch: 11,
  lock: 3,
  heat: 1,
  head: 1_020_000n,
  status: 0,
  target: "bob.tail.testnet",
  leak: { latE7: 423_551_000, lonE7: -710_651_000 },
  hintFact: { hintId: 3, hint: 1, value: 6 },
  nextSeq: 34,
  chainTip: seed("tip"),
  darkMs: 12_500,
  tags: 1,
  logSize: 1234n,
  root: seed("root"),
  rejected: { seq: 30, code: RejectCode.ClockSkew },
};
const { leak: _leak, hintFact: _hintFact, rejected: _rejected, ...hudBare } = hud;
// An out player's HUD: no target, no lock, but the account that took their head.
const hudOut: Hud = {
  ...hudBare,
  tick: 42,
  epoch: 36,
  lock: 0,
  heat: 0,
  head: 0n,
  status: TargetStatus.Out,
  target: "",
  taggedBy: "carol.tail.testnet",
};
const signedHud = signHud(hud, refereeSk);
const signedKeys = signPlayerKeys(keys, refereeSk);
const voice: VoiceLine = { matchId, player: 2, hintId: 3, text: "Your mark drifts east. Mind the café. ☕" };
const signedVoice = signVoiceLine(voice, refereeSk);
const signedMsg = (
  name: string,
  input: unknown,
  borsh: Uint8Array,
  digest: Uint8Array,
  sig: Uint8Array,
  signed: Uint8Array,
  context: string,
) => ({
  name,
  input,
  borsh,
  digest,
  sig,
  signed,
  context,
  sealed: sealWith(seed(`eph/${name}`), recipientPk, signed, context),
});
write("hud", {
  refereeSeed: refereeSk,
  refereePk,
  recipientSk,
  hud: { input: hud, borsh: encodeHud(hud) },
  hudNoOptions: { borsh: encodeHud(hudBare) },
  hudOut: { input: hudOut, borsh: encodeHud(hudOut) },
  signed: [
    signedMsg(
      "hud",
      hud,
      encodeHud(hud),
      hudSigDigest(hud),
      signedHud.sig,
      encodeSignedHud(signedHud),
      SealContext.hud,
    ),
    signedMsg(
      "keys",
      keys,
      encodePlayerKeys(keys),
      keysSigDigest(keys),
      signedKeys.sig,
      encodeSignedPlayerKeys(signedKeys),
      SealContext.keys,
    ),
    signedMsg(
      "voice",
      voice,
      encodeVoiceLine(voice),
      voiceSigDigest(voice),
      signedVoice.sig,
      encodeSignedVoiceLine(signedVoice),
      SealContext.voice,
    ),
  ],
});

// ── relay auth ──
const nonce = seed("nonce");
const reqBody = utf8('{"match_id":"5f62","sealed":"AAEC"}');
const request = {
  contractId: "tail-dev.testnet",
  accountId: "alice.tail.testnet",
  method: "post",
  path: "/batch",
  timeMs: 1794514000123,
  body: reqBody,
};
write("auth", {
  request: { ...request, digest: authRequestDigest(request) },
  hud: {
    nonce,
    matchId,
    accountId: "alice.tail.testnet",
    digest: authHudDigest(nonce, matchId, "alice.tail.testnet"),
  },
  replay: {
    nonce,
    matchId,
    accountId: "alice.tail.testnet",
    digest: authReplayDigest(nonce, matchId, "alice.tail.testnet"),
  },
});

// ── mesh carry ──
const relayBoxSk = seed("relay-box");
const relaySk = seed("relay");
const aliceSk = seed("alice-near");
const carried: CarryRequest = {
  account: request.accountId,
  timeMs: BigInt(request.timeMs),
  method: "POST",
  path: request.path,
  body: reqBody,
  sig: ed25519.sign(authRequestDigest(request), aliceSk),
};
const envelope = sealCarryWith(seed("eph/carry"), boxPublicKey(relayBoxSk), carried);
const ack = signCarryAck(relaySk, envelope, 200, 1_794_514_002_000n);
write("carry", {
  relayBoxSk,
  relayBoxPk: boxPublicKey(relayBoxSk),
  relayPk: ed25519.getPublicKey(relaySk),
  contractId: request.contractId,
  senderPk: ed25519.getPublicKey(aliceSk),
  request: {
    input: carried,
    borsh: encodeCarryRequest(carried),
    padded: padCarry(encodeCarryRequest(carried)),
  },
  envelope,
  ack: {
    input: ack,
    digest: carryAckDigest(envelope, ack.status, ack.receivedMs),
    borsh: encodeCarryAck(ack),
  },
});

console.log(`vectors written to ${out}`);
