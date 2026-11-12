// Writes the golden vectors from deterministic inputs. TS tests check these files stay
// in sync with the code; the Rust crate tests (crates/tail-protocol) reproduce every value.
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
  derivePlayerKey,
  deriveTagKey,
  encodeBatch,
  encodeBatchEnvelope,
  encodeHud,
  encodeLogEntry,
  encodePlayerKeys,
  encodeSignedVerdict,
  encodeVerdictPayload,
  enrollClientDataHash,
  FixFlag,
  fromHex,
  type Hud,
  type LogEntry,
  merkleLeaf,
  merkleProof,
  merkleRoot,
  type PlayerKeys,
  playersHash,
  ringCommit,
  sealWith,
  sha256,
  toHex,
  tokenToUuid,
  utf8,
  type Verdict,
  verdictDigest,
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

// ── verdicts ──
const refereeSk = seed("referee");
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
  { kind: "Hint", from: 0, to: 1, amount: 20_000n, hintId: 3 },
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
write("verdicts", {
  refereeSeed: refereeSk,
  refereePk: ed25519.getPublicKey(refereeSk),
  matchId,
  callId,
  verdicts: bodies.map((body, i) => {
    const payload = { matchId, seq: i + 1, callId, body };
    const digest = verdictDigest(payload);
    const sig = ed25519.sign(digest, refereeSk);
    return {
      seq: i + 1,
      body,
      payload: encodeVerdictPayload(payload),
      digest,
      sig,
      signed: encodeSignedVerdict({ ...payload, sig }),
    };
  }),
});

// ── merkle ──
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

// ── sealing + phone messages ──
const recipientSk = seed("recipient");
const keys: PlayerKeys = {
  matchId,
  player: 2,
  startMs: 1_794_514_000_000n,
  endMs: 1_794_517_600_000n,
  kTag,
  kPlayer: kPlayers[2] as Uint8Array,
  target: "alice.tail.testnet",
};
const hud: Hud = {
  tick: 17,
  epoch: 11,
  lock: 3,
  heat: 1,
  head: 1_020_000n,
  status: 0,
  target: "bob.tail.testnet",
  leak: { latE7: 423_551_000, lonE7: -710_651_000 },
  hintFact: { hintId: 3, hint: 1, value: 6 },
};
const { leak: _leak, hintFact: _hintFact, ...hudBare } = hud;
const plaintext = encodePlayerKeys(keys);
write("seal", {
  recipientSk,
  recipientPk: boxPublicKey(recipientSk),
  ephSk: seed("eph"),
  context: "tail/keys",
  plaintext,
  sealed: sealWith(seed("eph"), boxPublicKey(recipientSk), plaintext, "tail/keys"),
  playerKeys: { input: keys, borsh: plaintext },
  hud: { input: hud, borsh: encodeHud(hud) },
  hudNoOptions: { borsh: encodeHud(hudBare) },
});

// ── relay auth ──
const nonce = seed("nonce");
const reqBody = utf8('{"match_id":"5f62","sealed":"AAEC"}');
write("auth", {
  request: {
    method: "post",
    path: "/batch",
    timeMs: 1794514000123,
    body: reqBody,
    digest: authRequestDigest("post", "/batch", 1794514000123, reqBody),
  },
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

console.log(`vectors written to ${out}`);
