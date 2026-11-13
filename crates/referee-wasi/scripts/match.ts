// A real 3-player match on hosted OutLayer, played by ghost phones written in TS. Each ghost has
// a P-256 key and signs App Attest-format assertions (CBOR {signature, authenticatorData}, as
// `crates/appattest` verifies), enrols, opens its sealed PlayerKeys, and every tick sends a
// sealed batch: 1 Hz fixes a few metres from the others inside the zone, and sightings of the
// others' real beacon tokens. One ghost asks a hint, then strikes once its lock is full.
//
// Time runs fast: the match is started in the past (start_ms = now − 4 min, 3 min long) and each
// tick passes `now_ms` 10 s after the previous one, so it never runs ahead of the referee's
// clock and the whole match takes a couple of minutes of wall time. The verdicts are not
// submitted to the contract (the relay does that).
//
// Run from the repo root: `bun crates/referee-wasi/scripts/match.ts`, or against the local test
// referee: `REFEREE_MODE=local bun crates/referee-wasi/scripts/match.ts` (build it first).
import { createPublicKey, generateKeyPairSync, randomBytes, verify } from "node:crypto";
import {
  type Action,
  type Batch,
  batchClientDataHash,
  batchHash,
  beaconToken,
  boxPublicKey,
  buildRing,
  decodeLogEntry,
  decodeSignedVerdict,
  encodeBatchEnvelope,
  epochAt,
  equal,
  fromHex,
  type Bytes as Hash,
  type Hud,
  type LogEntry,
  merkleEmptyRoot,
  merkleLeaf,
  merkleRoot,
  openSignedHud,
  openSignedPlayerKeys,
  openSignedVoiceLine,
  type PlayerKeys,
  ringCommit,
  SealContext,
  type Sighting,
  type SignedVerdict,
  seal,
  sha256,
  sortAccounts,
  toHex,
  utf8,
  verdictChainBreak,
  verdictDigest,
  verifyConsistency,
} from "../../../packages/protocol/src/index.ts";
import { assertion, balance, type Call, type Json, OWNER, ok, p256, refused, spend } from "./lib.ts";

const STAKE = 1_000_000n;
const DURATION_MS = 180_000;
const TICK_MS = 10_000;
const LOCK_EPOCHS = 4;
const ZONE = { lat_e7: 423_601_000, lon_e7: -710_589_000, radius_m: 500 };

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
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

// ── ghosts ───────────────────────────────────────────────────────────────────────
type Ghost = {
  account: string;
  boxSk: Uint8Array;
  sk: Uint8Array;
  index: number;
  keys?: PlayerKeys;
  seq: number;
  prev: Uint8Array;
  counter: number;
  nonce: number;
  lat: number;
  lon: number;
  actions: Action[];
  huds: Hud[];
  out: boolean;
};

function batchFor(g: Ghost, ghosts: Ghost[], fromMs: number, toMs: number, startMs: number) {
  const keys = g.keys as PlayerKeys;
  const fixes = [];
  const heard = new Map<string, { epoch: number; token: Uint8Array; n: number }>();
  for (let t = fromMs + 1000; t <= toMs; t += 1000) {
    fixes.push({ tMs: BigInt(t), latE7: g.lat, lonE7: g.lon, accM: 5, speedCmps: 0, flags: 0 });
    const e = epochAt(t, startMs);
    for (const o of ghosts) {
      if (o === g || o.out) continue;
      const ok = o.keys as PlayerKeys;
      const token = beaconToken(ok.kTag, ok.kPlayer, e);
      const k = `${e}:${toHex(token)}`;
      const h = heard.get(k) ?? { epoch: e, token, n: 0 };
      h.n++;
      heard.set(k, h);
    }
  }
  const sightings: Sighting[] = [...heard.values()].map((h) => ({
    epoch: h.epoch,
    token: h.token,
    rssiMax: -55,
    rssiMed: -60,
    n: h.n,
  }));
  const batch: Batch = {
    matchId: keys.matchId,
    player: g.index,
    seq: g.seq,
    prev: g.prev,
    tMs: BigInt(toMs),
    fixes,
    sightings,
    actions: g.actions,
  };
  g.actions = [];
  g.counter++;
  const env = { batch, assertion: assertion(g.sk, batchClientDataHash(batch), g.counter) };
  sentHashes.add(toHex(batchHash(batch)));
  g.seq++;
  g.prev = batchHash(batch);
  const sealedB64 = b64(seal(boxPk, encodeBatchEnvelope(env), SealContext.batch));
  // The relay keeps every sealed batch it forwarded, for declassify_batches after End.
  keptSealed.push(sealedB64);
  return sealedB64;
}

const keptSealed: string[] = [];
const sentHashes = new Set<string>();

// ── keys, enrolment ─────────────────────────────────────────────────────────────
console.log(`balance before: ${await balance()}`);
const { result: keys } = await ok("pubkeys");
const refereePk = unb64(keys.referee_pk);
const boxPk = unb64(keys.referee_box_pk);
console.log(`referee_pk ${keys.referee_pk}  referee_box_pk ${keys.referee_box_pk}`);

const run = toHex(randomBytes(3));
const ghosts: Ghost[] = [];
for (const [i, name] of ["ana", "bo", "cy"].entries()) {
  const g: Ghost = {
    account: `${name}-${run}.${OWNER}`,
    boxSk: new Uint8Array(randomBytes(32)),
    sk: p256.utils.randomSecretKey(),
    index: -1,
    seq: 0,
    prev: new Uint8Array(32),
    counter: 0,
    nonce: 0,
    // A few metres apart, near the zone centre (1e-7 degree of latitude ≈ 1.1 cm).
    lat: ZONE.lat_e7 + i * 250,
    lon: ZONE.lon_e7 + i * 150,
    actions: [],
    huds: [],
    out: false,
  };
  const ed = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" });
  await ok("enroll", {
    account_id: g.account,
    app_attest_pk: b64(p256.getPublicKey(g.sk, false)),
    player_box_pk: b64(boxPublicKey(g.boxSk)),
    near_pk: Buffer.from(String(ed.x), "base64url").toString("base64"),
  });
  ghosts.push(g);
}
console.log(`enrolled ${ghosts.map((g) => g.account).join(", ")}`);

// ── start ───────────────────────────────────────────────────────────────────────
const matchId = new Uint8Array(randomBytes(16));
const startMs = Date.now() - DURATION_MS - 60_000;
const accounts = ghosts.map((g) => g.account);
const sorted = sortAccounts(accounts);
const { result: st, call: startCall } = await ok("start", {
  match_id: b64(matchId),
  players: accounts,
  start_ms: startMs,
  duration_ms: DURATION_MS,
  stake: STAKE.toString(),
  zone: ZONE,
});
// What the relay keeps during play: leaf hashes and the log sealed to the referee, never the
// plaintext; every anchored root with the consistency proof that came with it.
const leaves: Hash[] = [];
const logSealed: string[] = [];
const anchors: { from: number; size: number; root: Hash; path: Hash[] }[] = [];
const verdicts: { v: SignedVerdict; call: string }[] = [];
const take = (r: Json, c: Call) => {
  if (r.log !== undefined) throw new Error("FAIL: a plaintext log left the referee during play");
  leaves.push(...r.leaves.map(unb64));
  logSealed.push(r.log_sealed);
  for (const s of r.verdicts) {
    const v = decodeSignedVerdict(unb64(s));
    verdicts.push({ v, call: c.id });
    if (v.body.kind === "Checkpoint" || v.body.kind === "End") {
      const p = r.proofs.find((x: Json) => x.seq === v.seq);
      if (!p) throw new Error(`FAIL: verdict ${v.seq} has no consistency proof`);
      anchors.push({
        from: p.from_size,
        size: Number(v.body.logSize),
        root: v.body.root,
        path: p.path.map(unb64),
      });
    }
  }
};
take(st, startCall);
for (const g of ghosts) {
  g.index = sorted.indexOf(g.account);
  const entry = st.keys.find((k: Json) => k.account_id === g.account);
  g.keys = openSignedPlayerKeys(g.boxSk, unb64(entry.sealed), refereePk);
}
const hunter = ghosts.find((g) => g.index === 0) as Ghost;
const target = ghosts.find((g) => g.account === hunter.keys?.target) as Ghost;
console.log(`start: ${startCall.wall.toFixed(0)} ms wall; ${hunter.account} hunts ${target.account}`);

// ── ticks ───────────────────────────────────────────────────────────────────────
type Row = {
  tick: number;
  t: number;
  wall: number;
  enclave: number;
  state: number;
  batches: number;
  kinds: string;
  lock: number;
  heat: number;
};
const rows: Row[] = [];
let state: string = st.state;
let seq: number = st.seq;
let receipts: string[] = [];
let over = false;
let hinted = false;
let struck = false;
let voiceRow = "";
let signedText: string | null = null;
for (let k = 1; !over; k++) {
  const now = startMs + k * TICK_MS;
  if (k === 2) {
    hunter.actions.push({ kind: "Hint", hint: 0, nonce: ++hunter.nonce, text: "am I close?" });
    hinted = true;
  }
  const lastHud = hunter.huds.at(-1);
  if (!struck && lastHud && lastHud.lock >= LOCK_EPOCHS) {
    hunter.actions.push({ kind: "Strike", nonce: ++hunter.nonce });
    struck = true;
  }
  const alive = ghosts.filter((g) => !g.out);
  const batches = alive.map((g) => batchFor(g, ghosts, now - TICK_MS, now, startMs));
  const { result: t, call: c } = await ok("tick", {
    match_id: b64(matchId),
    state,
    last_seq: seq,
    now_ms: now,
    batches,
    receipts,
  });
  receipts = [];
  state = t.state;
  seq = t.seq;
  over = t.over;
  take(t, c);
  // A tagged player stops sending; its batches would only be rejected as PlayerOut.
  for (const s of t.verdicts) {
    const body = decodeSignedVerdict(unb64(s)).body;
    if (body.kind === "Tag") for (const g of ghosts) if (g.index === body.target) g.out = true;
  }
  if (t.unopened.length || t.rejected.length)
    throw new Error(`tick ${k}: ${JSON.stringify([t.unopened, t.rejected])}`);
  for (const h of t.huds) {
    const g = ghosts.find((x) => x.index === h.player) as Ghost;
    const hud = openSignedHud(g.boxSk, unb64(h.sealed), refereePk);
    if (hud.logSize !== BigInt(leaves.length) || !equal(hud.root, merkleRoot(leaves)))
      throw new Error(`FAIL: ${g.account}'s HUD names another log`);
    g.huds.push(hud);
    if (hud.status === 1) g.out = true;
  }
  for (const h of t.hints) {
    const { result: v, call: vc } = await ok("voice", { state: t.state, blob: h.blob });
    const asker = ghosts.find((x) => x.index === h.player) as Ghost;
    const line = openSignedVoiceLine(asker.boxSk, unb64(v.sealed), refereePk);
    receipts.push(v.log_sealed);
    signedText = v.signed_text;
    voiceRow = `"${line.text}" (${v.source}, model ${v.latency_ms} ms, call ${vc.wall.toFixed(0)} ms, ${v.signed_text ? "signed" : (v.signature_error ?? v.fallback_reason)})`;
  }
  const kinds = t.verdicts.map((s: string) => decodeSignedVerdict(unb64(s)).body.kind).join(",");
  rows.push({
    tick: k,
    t: (now - startMs) / 1000,
    wall: c.wall,
    enclave: c.enclave,
    state: t.state_bytes,
    batches: batches.length,
    kinds,
    lock: hunter.huds.at(-1)?.lock ?? 0,
    heat: target.huds.at(-1)?.heat ?? 0,
  });
  console.log(
    `tick ${k} t=${(now - startMs) / 1000}s wall ${c.wall.toFixed(0)} enclave ${c.enclave} state ${t.state_bytes}B verdicts [${kinds}] lock ${rows.at(-1)?.lock} heat ${rows.at(-1)?.heat}${t.refused.length ? ` refused ${JSON.stringify(t.refused)}` : ""}`,
  );
  if (k > 40) throw new Error("match did not end");
}
const stalePrev = await refused("tick", { match_id: b64(matchId), state: st.state, last_seq: seq });

// ── end ─────────────────────────────────────────────────────────────────────────
const { result: e, call: endCall } = await ok("end", {
  match_id: b64(matchId),
  state,
  last_seq: seq,
  receipts,
});
take(e, endCall);
const dropped = await refused("declassify", { match_id: b64(matchId), log_sealed: logSealed.slice(0, -1) });
const { result: d } = await ok("declassify", { match_id: b64(matchId), log_sealed: logSealed });
const log: LogEntry[] = d.log.map((x: string) => decodeLogEntry(unb64(x)));

// Trails: every kept sealed batch, plus one sealed for another match and one garbage blob.
const foreign: Batch = {
  matchId: new Uint8Array(randomBytes(16)),
  player: 0,
  seq: 0,
  prev: new Uint8Array(32),
  tMs: BigInt(startMs),
  fixes: [],
  sightings: [],
  actions: [],
};
const foreignSealed = b64(
  seal(boxPk, encodeBatchEnvelope({ batch: foreign, assertion: new Uint8Array(0) }), "tail/batch"),
);
const { result: trails, call: trailsCall } = await ok("declassify_batches", {
  match_id: b64(matchId),
  state: e.state,
  sealed: [...keptSealed, foreignSealed, b64(randomBytes(64))],
});

// Chunk measurement: 500 batches shaped like a 12-player match at 5 s cadence (5 fixes, a
// sighting of each of 11 others in two epochs, a 115-byte assertion). Their contents are not
// in this match's log; they only size the largest call the relay makes.
const big: string[] = [];
for (let n = 0; n < 500; n++) {
  const t = startMs + n * 5000;
  const batch: Batch = {
    matchId,
    player: n % 12,
    seq: n,
    prev: new Uint8Array(randomBytes(32)),
    tMs: BigInt(t),
    fixes: Array.from({ length: 5 }, (_, i) => ({
      tMs: BigInt(t - 4000 + i * 1000),
      latE7: ZONE.lat_e7 + n,
      lonE7: ZONE.lon_e7 - n,
      accM: 8,
      speedCmps: 120,
      flags: 0,
    })),
    sightings: Array.from({ length: 22 }, (_, i) => ({
      epoch: Math.floor(n / 3) + (i % 2),
      token: new Uint8Array(randomBytes(16)),
      rssiMax: -60,
      rssiMed: -70,
      n: 4,
    })),
    actions: [],
  };
  big.push(
    b64(
      seal(boxPk, encodeBatchEnvelope({ batch, assertion: new Uint8Array(randomBytes(115)) }), "tail/batch"),
    ),
  );
}
const bigInput = { cmd: "declassify_batches", match_id: b64(matchId), state: e.state, sealed: big };
const { result: bigOut, call: bigCall } = await ok("declassify_batches", bigInput);
const chunkRow = `500 batches: request ${(JSON.stringify(bigInput).length / 1024).toFixed(0)} KB, response ${(JSON.stringify(bigOut).length / 1024).toFixed(0)} KB, wall ${bigCall.wall.toFixed(0)} ms, enclave ${bigCall.enclave} ms, returned ${bigOut.batches.length}`;
const overCap = await refused("declassify_batches", { match_id: b64(matchId), sealed: [...big, big[0]] });

// ── checks ──────────────────────────────────────────────────────────────────────
console.log("\nchecks");
check(
  verdicts.every(({ v }, i) => v.seq === i + 1),
  `${verdicts.length} verdicts, seq contiguous from 1`,
);
check(
  verdicts.every(({ v, call }) => equal(v.matchId, matchId) && equal(v.callId, uuidBytes(call))),
  "every verdict names this match and the OutLayer call that produced it",
);
check(
  verdicts.every(({ v }) => ed25519Verify(refereePk, verdictDigest(v), v.sig)),
  "every verdict signature verifies with referee_pk over verdictDigest",
);
check(
  verdictChainBreak(
    verdicts.map(({ v }) => v),
    refereePk,
  ) === undefined,
  "every verdict's prev is the digest of the one before (zeros for Start)",
);
let anchored: { size: number; root: Hash } = { size: 0, root: merkleEmptyRoot() };
const consistent = anchors.every((a) => {
  const good =
    a.from === anchored.size &&
    equal(merkleRoot(leaves.slice(0, a.size)), a.root) &&
    verifyConsistency(a.from, a.size, anchored.root, a.root, a.path);
  anchored = a;
  return good;
});
check(
  consistent && anchors.length >= 2,
  `${anchors.length} anchored roots, each proved consistent with the last`,
);
const kinds = verdicts.map(({ v }) => v.body.kind);
console.log(`  verdicts: ${kinds.join(", ")}`);
const startV = verdicts[0]?.v.body;
check(
  startV?.kind === "Start" && startV.endMs - startV.startMs === BigInt(DURATION_MS),
  "Start: end_ms − start_ms = duration_ms",
);
const hintV = verdicts.find(({ v }) => v.body.kind === "Hint")?.v.body;
const price = (STAKE * 200n) / 10_000n;
check(
  hinted &&
    hintV?.kind === "Hint" &&
    hintV.from === hunter.index &&
    hintV.to === target.index &&
    hintV.amount === price &&
    hintV.hint === 0,
  `Hint verdict: ${hunter.index} → ${target.index}, ${price}`,
);
const tagV = verdicts.find(({ v }) => v.body.kind === "Tag")?.v.body;
check(
  tagV?.kind === "Tag" && tagV.hunter === hunter.index && tagV.target === target.index,
  `Tag verdict: ${hunter.index} tags ${target.index}`,
);
const locks = hunter.huds.map((h) => h.lock);
const heats = target.huds.map((h) => h.heat);
check(
  Math.max(...locks) >= LOCK_EPOCHS && (locks[0] ?? 0) < LOCK_EPOCHS,
  `hunter's lock rose: ${locks.join(" ")}`,
);
check(Math.max(...heats) >= LOCK_EPOCHS, `target's heat rose: ${heats.join(" ")}`);
check(
  hunter.huds.at(-1)?.head === 2n * STAKE,
  `hunter's head after hint and tag: ${hunter.huds.at(-1)?.head} (= 2 × stake)`,
);
check(
  target.huds.at(-1)?.status === 1,
  `the target's last HUD says OUT (status ${target.huds.at(-1)?.status})`,
);
check(
  target.huds.at(-1)?.taggedBy === hunter.account,
  `the target's last HUD names the hunter (${target.huds.at(-1)?.taggedBy})`,
);
check(stalePrev.includes("rollback"), "an old state blob is refused as a rollback");
const endV = verdicts.at(-1)?.v.body;
if (endV?.kind !== "End") throw new Error("FAIL: last verdict is not End");
check(dropped.includes("End verdict signed"), "declassify refuses a log with a blob missing");
check(
  log.length === leaves.length && log.every((x, i) => equal(merkleLeaf(x), leaves[i] as Hash)),
  "the declassified log is exactly the leaves the relay held during play",
);
const before = log.slice(0, Number(endV.logSize));
check(
  log.length === Number(endV.logSize) + 1,
  `log: ${log.length} entries = End.log_size + 1 (End's own entry)`,
);
check(
  equal(merkleRoot(before.map(merkleLeaf)), endV.root),
  "End root = Merkle root of every returned log entry before End",
);
check(endV.alpha.endsWith(`:${toHex(matchId)}`), "VRF alpha ends with ':' + match id hex");
check(
  ed25519Verify(fromHex(keys.vrf_pk), utf8(endV.alpha), endV.vrfSignature),
  "VRF signature verifies with the OutLayer VRF key",
);
check(
  startV?.kind === "Start" && equal(ringCommit(endV.vrfSignature), startV.ringCommit),
  "ring_commit opens to the revealed VRF signature",
);
check(
  JSON.stringify(d.ring) === JSON.stringify(buildRing(accounts, endV.vrfSignature)),
  "declassified ring = buildRing(players, vrf_signature)",
);
check(
  log.some((x) => x.kind === "HintReceipt"),
  "the voice receipt joined the log",
);
check(
  log
    .slice(0, ghosts.length)
    .every((x, i) => x.kind === "Enrolled" && x.player === i && x.account === sorted[i] && !x.attested),
  "the log opens with one Enrolled per player, in index order (ghosts: attested false)",
);
const tagAt = log.findIndex(
  (x) => x.kind === "Verdict" && verdicts.find(({ v }) => v.seq === x.seq)?.v.body.kind === "Tag",
);
const ev = log[tagAt - 1];
const pair = [Math.min(hunter.index, target.index), Math.max(hunter.index, target.index)];
check(
  ev?.kind === "Evidence" &&
    ev.hunter === hunter.index &&
    ev.target === target.index &&
    ev.epochs.length >= LOCK_EPOCHS &&
    ev.epochs.every((x) =>
      log.some((c) => c.kind === "Contact" && c.epoch === x && c.a === pair[0] && c.b === pair[1]),
    ),
  `the Tag follows its Evidence (${ev?.kind === "Evidence" ? ev.epochs.join(" ") : "?"}), each a logged contact`,
);
check(log.filter((x) => x.kind === "Tick").length === rows.length, "one Tick entry per tick");
check(
  signedText === null || /^.+:[0-9a-f]{64}:[0-9a-f]{64}$/.test(signedText),
  `signed_text is model:sha256(request):sha256(response) (${signedText === null ? "template line" : "model line"})`,
);
const logged = new Set(log.flatMap((x) => (x.kind === "Batch" ? [toHex(x.hash)] : [])));
const returned = trails.batches.map((b: string) => toHex(sha256(unb64(b))));
check(
  returned.length === keptSealed.length &&
    returned.every((h: string) => logged.has(h) && sentHashes.has(h)) &&
    logged.size === returned.length &&
    trails.assertions.length === returned.length,
  `declassify_batches: all ${returned.length} batches returned with their assertions, each SHA256 a LogEntry::Batch hash`,
);
check(
  trails.refused.length === 2 &&
    trails.refused[0].index === keptSealed.length &&
    String(trails.refused[0].reason).includes("another match") &&
    trails.refused[1].index === keptSealed.length + 1,
  "a batch of another match and a garbage blob are refused one by one",
);
check(
  bigOut.batches.length === 500 && bigOut.refused.length === 0,
  `a 500-batch chunk opens in one call (${chunkRow})`,
);
check(overCap.includes("at most 500"), "a 501-batch call is refused");

// ── table ───────────────────────────────────────────────────────────────────────
console.log(`\nvoice: ${voiceRow}`);
console.log(
  "\n| tick | sim t | batches | wall | enclave | state | verdicts | lock (hunter) | heat (target) |\n|---|---|---|---|---|---|---|---|---|",
);
for (const r of rows)
  console.log(
    `| ${r.tick} | ${r.t} s | ${r.batches} | ${r.wall.toFixed(0)} ms | ${r.enclave} ms | ${r.state} B | ${r.kinds} | ${r.lock} | ${r.heat} |`,
  );
const walls = rows.map((r) => r.wall).sort((a, b) => a - b);
const encl = rows.map((r) => r.enclave).sort((a, b) => a - b);
const q = (a: number[], p: number) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
console.log(
  `\ntick wall p50 ${q(walls, 0.5)?.toFixed(0)} ms, p95 ${q(walls, 0.95)?.toFixed(0)} ms; enclave p50 ${q(encl, 0.5)} ms`,
);
console.log(`start ${startCall.wall.toFixed(0)} ms, end ${endCall.wall.toFixed(0)} ms wall`);
console.log(
  `declassify_batches: ${keptSealed.length + 2} sealed in ${trailsCall.wall.toFixed(0)} ms wall; ${chunkRow}`,
);
const s = spend();
console.log(
  `\nALL OK. ${s.calls} calls, $${s.usd.toFixed(4)} (compute_cost sum). balance after: ${await balance()}`,
);
