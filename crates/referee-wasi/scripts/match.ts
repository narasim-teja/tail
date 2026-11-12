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
// Run from the repo root: `bun crates/referee-wasi/scripts/match.ts`.
import { createPublicKey, generateKeyPairSync, randomBytes, verify } from "node:crypto";
// Already installed under the protocol package; imported by path rather than installed here.
import { p256 } from "../../../packages/protocol/node_modules/@noble/curves/nist.js";
import {
  type Action,
  type Batch,
  batchClientDataHash,
  batchHash,
  beaconToken,
  boxPublicKey,
  buildRing,
  concat,
  decodeHud,
  decodeLogEntry,
  decodePlayerKeys,
  decodeSignedVerdict,
  encodeBatchEnvelope,
  epochAt,
  equal,
  fromHex,
  type Hud,
  type LogEntry,
  merkleLeaf,
  merkleRoot,
  open,
  type PlayerKeys,
  ringCommit,
  type Sighting,
  type SignedVerdict,
  seal,
  sha256,
  sortAccounts,
  toHex,
  utf8,
  verdictDigest,
} from "../../../packages/protocol/src/index.ts";
import { balance, type Call, type Json, OWNER, ok, refused, spend } from "./lib.ts";

const APP_ID = "LKABS9RZAC.com.lkabs9rzac.tail";
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

// ── App Attest assertion, byte for byte as the Secure Enclave builds it ──────────
const cborHead = (major: number, len: number) =>
  len < 24
    ? [(major << 5) | len]
    : len < 256
      ? [(major << 5) | 24, len]
      : [(major << 5) | 25, len >> 8, len & 0xff];
const cborBytes = (b: Uint8Array) => [...cborHead(2, b.length), ...b];
const cborText = (s: string) => [...cborHead(3, utf8(s).length), ...utf8(s)];
const u32be = (n: number) => Uint8Array.of(n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);

/** authenticatorData = SHA256(app_id) ‖ flags 0 ‖ u32be(counter); ECDSA over SHA256(SHA256(auth ‖ cdh)). */
function assertion(sk: Uint8Array, clientDataHash: Uint8Array, counter: number): Uint8Array {
  const auth = concat(sha256(utf8(APP_ID)), Uint8Array.of(0), u32be(counter));
  const nonce = sha256(concat(auth, clientDataHash));
  // prehash: the verifier's ECDSA hashes its message (the nonce) with SHA-256 once more.
  const sig = p256.sign(nonce, sk, { prehash: true, format: "der" });
  return Uint8Array.from([
    0xa2,
    ...cborText("signature"),
    ...cborBytes(sig),
    ...cborText("authenticatorData"),
    ...cborBytes(auth),
  ]);
}

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
  g.seq++;
  g.prev = batchHash(batch);
  return b64(seal(boxPk, encodeBatchEnvelope(env), "tail/batch"));
}

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
const log: LogEntry[] = st.log.map((e: string) => decodeLogEntry(unb64(e)));
const verdicts: { v: SignedVerdict; call: string }[] = [];
const take = (list: string[], c: Call) => {
  for (const s of list) verdicts.push({ v: decodeSignedVerdict(unb64(s)), call: c.id });
};
take(st.verdicts, startCall);
for (const g of ghosts) {
  g.index = sorted.indexOf(g.account);
  const entry = st.keys.find((k: Json) => k.account_id === g.account);
  g.keys = decodePlayerKeys(open(g.boxSk, unb64(entry.sealed), "tail/keys"));
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
  take(t.verdicts, c);
  // A tagged player stops sending; its batches would only be rejected as PlayerOut.
  for (const s of t.verdicts) {
    const body = decodeSignedVerdict(unb64(s)).body;
    if (body.kind === "Tag") for (const g of ghosts) if (g.index === body.target) g.out = true;
  }
  log.push(...t.log.map((e: string) => decodeLogEntry(unb64(e))));
  if (t.unopened.length || t.rejected.length)
    throw new Error(`tick ${k}: ${JSON.stringify([t.unopened, t.rejected])}`);
  for (const h of t.huds) {
    const g = ghosts.find((x) => x.index === h.player) as Ghost;
    const hud = decodeHud(open(g.boxSk, unb64(h.sealed), "tail/hud"));
    g.huds.push(hud);
    if (hud.status === 1) g.out = true;
  }
  for (const h of t.hints) {
    const { result: v, call: vc } = await ok("voice", {
      hint_id: h.hint_id,
      hint: h.hint,
      value: h.value,
      question: h.text,
    });
    receipts.push(v.receipt);
    voiceRow = `"${v.text}" (${v.source}, model ${v.latency_ms} ms, call ${vc.wall.toFixed(0)} ms, ${v.signature_kind ?? v.signature_error ?? v.fallback_reason})`;
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
take(e.verdicts, endCall);
log.push(...e.log.map((x: string) => decodeLogEntry(unb64(x))));
const { result: d } = await ok("declassify", { match_id: b64(matchId) });

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
    hintV.amount === price,
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
check(stalePrev.includes("rollback"), "an old state blob is refused as a rollback");
const endV = verdicts.at(-1)?.v.body;
if (endV?.kind !== "End") throw new Error("FAIL: last verdict is not End");
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
const s = spend();
console.log(
  `\nALL OK. ${s.calls} calls, $${s.usd.toFixed(4)} (compute_cost sum). balance after: ${await balance()}`,
);
