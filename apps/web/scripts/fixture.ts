// Builds realistic, valid ReplayBundles for a five-player, twenty-minute match on Boston Common:
// real walking paths (scripts/data/common-paths.json, from OpenStreetMap), real beacon tokens,
// real borsh batches with hash chains, a real RFC 6962 log and real ed25519-signed verdicts. It
// mirrors the referee's tick order (receipts, batches, contacts, actions, dark rules, checkpoint)
// so every root and signature checks out in the browser.
//
// THE KEYS HERE ARE TEST FIXTURES. The referee, VRF and Handler-model keys are derived from public
// strings in this file, so anyone can sign with them; they are not, and never were, used on NEAR
// or NEAR AI. The bundles name no transactions, and the page reports them as a fixture that is
// not on NEAR.
//
// Protocol v2: verdicts chained by `prev`, Tick entries opening every tick, Enrolled entries at
// start, an Evidence entry before each Tag, the leaf hashes beside the log. Money moves like the
// referee and contract move it: a Hint pays into the hint pool and doesn't say whom it was about,
// a Tag or Forfeit carries the hints paid onto its loser as `credit`, and End lists every hint's
// target. One variant is built in the v1 format (matches recorded before protocol v2), which the
// page reads read only; there a hint names its target and pays it directly.
//
// Pure and deterministic: the same bytes on every call. The tests build their bundles from it in
// memory; scripts/make-fixture.ts writes them to public/fixtures for the page.

import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  type Action,
  type Batch,
  batchHash,
  beaconToken,
  buildRing,
  CHECKPOINT_MS,
  concat,
  DARK_FORFEIT_MS,
  deriveLogKey,
  derivePlayerKey,
  deriveTagKey,
  EPOCH_MS,
  encodeBatch,
  encodeLogEntry,
  encodeSignedVerdict,
  type Fix,
  HINT_NEAR_M,
  HintKind,
  hintPrice,
  LOCK_EPOCHS,
  type LogEntry,
  logSalt,
  playersHash,
  type ReplayBundle,
  type ReplayBundleV2,
  recentHints,
  ringCommit,
  type Sighting,
  type SignedVerdict,
  sha256,
  sortAccounts,
  TICK_MS,
  toHex,
  utf8,
  type Verdict,
  verdictDigest,
  WINDOW_EPOCHS,
} from "@tail/protocol";
import {
  encodeLogEntryV1,
  encodeSignedVerdictV1,
  NO_SALT,
  type SignedVerdictV1,
  type VerdictV1,
  verdictDigestV1,
} from "../src/verify/v1.ts";
import paths from "./data/common-paths.json" with { type: "json" };

export interface Fixtures {
  /** The match with every released batch (trails). */
  full: ReplayBundleV2;
  /** The same match as the relay serves it before batches are declassified. */
  noTrails: ReplayBundleV2;
  /** One Tag verdict rewritten after signing. */
  tampered: ReplayBundleV2;
  /**
   * The log rewritten after a checkpoint: an entry logged between the 4th and 5th checkpoints was
   * changed after the 5th was signed and every later checkpoint signed over the new log, so the
   * 4th is no longer a prefix of the 5th, nor the 5th of the 6th.
   */
  tamperedLog: ReplayBundleV2;
  /**
   * Signed and anchored like the honest match, but End names Bo as the first hint's target while
   * Eli, who asked it, was hunting Ana. The contract's End replay finds the hint off its asker's
   * target and refunds every stake.
   */
  refunded: ReplayBundleV2;
  /** The same match in the v1 format, as recorded before protocol v2. */
  v1: ReplayBundle;
  /** A few lines describing what was built. */
  summary: string[];
}

/** File names under public/fixtures, by variant; the page loads them as `?fixture=<name>`. */
export const FIXTURE_FILES: Record<Exclude<keyof Fixtures, "summary">, string> = {
  full: "boston-common.json",
  noTrails: "boston-common-no-trails.json",
  tampered: "boston-common-tampered.json",
  tamperedLog: "boston-common-tampered-log.json",
  refunded: "boston-common-refunded.json",
  v1: "boston-common-v1.json",
};

/** Which checkpoint (1-based) the tampered-log variant rewrites history behind. */
export const REWRITTEN_CHECKPOINT = 5;

export function makeFixtures(): Fixtures {
  const v2 = generate({ version: 2 });
  const rewritten = generate({ version: 2, rewriteBefore: REWRITTEN_CHECKPOINT });
  const v1 = generate({ version: 1 });
  return {
    full: v2.bundle,
    noTrails: { ...v2.bundle, batches: [] },
    tampered: v2.tampered,
    tamperedLog: rewritten.bundle,
    refunded: forgedFixture("hint-target"),
    v1: v1.v1 as ReplayBundle,
    summary: [...v2.summary, `tampered log: ${rewritten.rewrite}`],
  };
}

/**
 * A match whose referee signed a verdict that breaks a rule, everything else as honest; End's
 * replay sees the first two, the tag's evidence check the third. hint-target: End names Bo as the first hint's target (Eli asked it while
 * hunting Ana). tag: the second Tag names Dee as the hunter (Eli made the strike; Dee was hunting
 * Eli). evidence: the first Tag's Evidence entry cites a window just outside the lock window in
 * place of one inside it, so the tag no longer meets the rule. All are validly signed, chained
 * and anchored.
 */
export function forgedFixture(forge: Forge): ReplayBundleV2 {
  return generate({ version: 2, forge }).bundle;
}

type Forge = "hint-target" | "tag" | "evidence";

interface Options {
  version: 1 | 2;
  /** Rewrite one Contact entry logged before this checkpoint, right after it is signed. */
  rewriteBefore?: number;
  forge?: Forge;
}

function generate(opts: Options) {
  const V2 = opts.version === 2;
  // ── Fixture constants ────────────────────────────────────────────────────────────

  const REFEREE_SK = sha256(utf8("TAIL replay fixture referee key. Test only, public, never on NEAR."));
  const VRF_SK = sha256(utf8("TAIL replay fixture VRF key. Test only, public, never on NEAR."));
  const MODEL_SK = sha256(
    utf8("TAIL replay fixture Handler model key. Test only, public, never on NEAR AI."),
  );
  const MODEL = "fixture (written by hand, not a model)";
  const K_M = sha256(utf8("TAIL replay fixture match key"));
  const MATCH_ID = sha256(utf8("TAIL replay fixture: Boston Common, five players")).slice(0, 16);
  const MATCH_HEX = toHex(MATCH_ID);
  // Saturday 8 November 2026, 3:04 pm in Boston.
  const START_MS = Date.UTC(2026, 10, 8, 20, 4, 0);
  const DURATION_MS = 20 * 60_000;
  const END_MS = START_MS + DURATION_MS;
  const STAKE = 5_000_000n; // 5.00 USDC (6 decimals)
  const NAMES = ["ana", "bo", "cy", "dee", "eli"] as const;
  const ACCOUNTS = NAMES.map((n) => `${n}.tail-fixture.testnet`);
  const BLE_RANGE_M = 28;
  const BATCH_MS = 5_000;
  const FIX_EVERY_MS = 2_000;
  const TICK_LATENCY_MS = 1_300;

  /** Seeded PRNG (mulberry32), so the fixture is the same bytes on every run. */
  function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rand = rng(20261108);
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const randomBytes = (n: number) => Uint8Array.from({ length: n }, () => Math.floor(rand() * 256));
  /** A UUID v4 shaped call id, like OUTLAYER_CALL_ID. */
  function callId(): Uint8Array {
    const b = randomBytes(16);
    b[6] = ((b[6] as number) & 0x0f) | 0x40;
    b[8] = ((b[8] as number) & 0x3f) | 0x80;
    return b;
  }

  // ── Local plane (metres east/north of the zone centre) ───────────────────────────

  const ZONE = { latE7: 423_550_500, lonE7: -710_656_500, radiusM: 360 };
  const LAT0 = ZONE.latE7 / 1e7;
  const LON0 = ZONE.lonE7 / 1e7;
  const M_LAT = 111_132.954 - 559.822 * Math.cos((2 * LAT0 * Math.PI) / 180);
  const M_LON = 111_412.84 * Math.cos((LAT0 * Math.PI) / 180);
  type P = { x: number; y: number };
  const toP = (lon: number, lat: number): P => ({ x: (lon - LON0) * M_LON, y: (lat - LAT0) * M_LAT });
  const toLonLat = (p: P) => ({ lon: LON0 + p.x / M_LON, lat: LAT0 + p.y / M_LAT });
  const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);

  const SAFEHOUSE = { latE7: 423_554_600, lonE7: -710_638_870, radiusM: 18 }; // Visitor Information Center
  const SAFE_P = toP(SAFEHOUSE.lonE7 / 1e7, SAFEHOUSE.latE7 / 1e7);

  // ── Path graph ───────────────────────────────────────────────────────────────────

  const nodes: P[] = [];
  const index = new Map<string, number>();
  const adj: { to: number; w: number }[][] = [];
  function node(lonE7: number, latE7: number): number {
    const k = `${lonE7},${latE7}`;
    let i = index.get(k);
    if (i === undefined) {
      i = nodes.length;
      index.set(k, i);
      nodes.push(toP(lonE7 / 1e7, latE7 / 1e7));
      adj.push([]);
    }
    return i;
  }
  for (const way of paths.paths) {
    for (let i = 1; i < way.length; i++) {
      const [ax, ay] = way[i - 1] as number[];
      const [bx, by] = way[i] as number[];
      const a = node(ax as number, ay as number);
      const b = node(bx as number, by as number);
      const w = dist(nodes[a] as P, nodes[b] as P);
      if (w > 60) continue; // a way cut at the park edge would otherwise jump across a street
      adj[a]?.push({ to: b, w });
      adj[b]?.push({ to: a, w });
    }
  }
  // Walk only the largest connected piece, so every route exists.
  const comp = new Int32Array(nodes.length).fill(-1);
  let best = 0;
  let bestSize = 0;
  for (let s = 0, c = 0; s < nodes.length; s++) {
    if (comp[s] !== -1) continue;
    const stack = [s];
    comp[s] = c;
    let size = 0;
    while (stack.length) {
      const u = stack.pop() as number;
      size++;
      for (const { to } of adj[u] ?? [])
        if (comp[to] === -1) {
          comp[to] = c;
          stack.push(to);
        }
    }
    if (size > bestSize) {
      bestSize = size;
      best = c;
    }
    c++;
  }
  function nearestNode(p: P): number {
    let bi = -1;
    let bd = Number.POSITIVE_INFINITY;
    nodes.forEach((n, i) => {
      const d = dist(n, p);
      if (comp[i] === best && d < bd) {
        bd = d;
        bi = i;
      }
    });
    return bi;
  }
  function route(from: number, to: number): P[] {
    const d = new Float64Array(nodes.length).fill(Number.POSITIVE_INFINITY);
    const prev = new Int32Array(nodes.length).fill(-1);
    const done = new Uint8Array(nodes.length);
    d[from] = 0;
    for (;;) {
      let u = -1;
      for (let i = 0; i < nodes.length; i++)
        if (!done[i] && (u < 0 || (d[i] as number) < (d[u] as number))) u = i;
      if (u < 0 || d[u] === Number.POSITIVE_INFINITY || u === to) break;
      done[u] = 1;
      for (const { to: v, w } of adj[u] ?? []) {
        if ((d[u] as number) + w < (d[v] as number)) {
          d[v] = (d[u] as number) + w;
          prev[v] = u;
        }
      }
    }
    const out: P[] = [];
    for (let v = to; v !== -1; v = prev[v] as number) out.push(nodes[v] as P);
    return out.reverse();
  }

  // Landmarks, snapped to the nearest walkable path.
  const L = (lat: number, lon: number) => nearestNode(toP(lon, lat));
  const BREWER = L(42.3562, -71.0631);
  const VISITOR_PATH = L(42.35575, -71.06375);
  const POND_E = L(42.35612, -71.06535);
  const POND_N = L(42.3566, -71.0659);
  const POND_W = L(42.35605, -71.0666);
  const POND_S = L(42.35555, -71.06595);
  const CAROUSEL = L(42.35595, -71.06705);
  const MONUMENT = L(42.35525, -71.06635);
  const BANDSTAND = L(42.3545, -71.06545);
  const BURYING = L(42.35325, -71.06585);
  const SE = L(42.3529, -71.0643);
  const SW = L(42.3531, -71.0679);
  const NW = L(42.3561, -71.0686);
  const NORTH = L(42.3571, -71.0648);
  const WEST = L(42.3546, -71.0675);

  // ── Movement plans ───────────────────────────────────────────────────────────────

  type Key = { t: number; p: P };
  class Plan {
    keys: Key[];
    constructor(start: number) {
      this.keys = [{ t: 0, p: nodes[start] as P }];
    }
    get last(): Key {
      return this.keys.at(-1) as Key;
    }
    /** Walk to a landmark along the paths at `mps`. */
    walk(to: number, mps = 1.3): this {
      const r = route(nearestNode(this.last.p), to);
      let { t, p } = this.last;
      for (const q of r) {
        const d = dist(p, q);
        if (d < 0.5) continue;
        t += d / mps;
        this.keys.push({ t, p: q });
        p = q;
      }
      return this;
    }
    pause(s: number): this {
      this.keys.push({ t: this.last.t + s, p: this.last.p });
      return this;
    }
    /** Shadow another player's track `lag` seconds behind them, `offset` metres aside. */
    follow(other: Plan, until: number, lag: (t: number) => number, offset: P): this {
      for (let t = this.last.t + 2; t <= until; t += 2) {
        const q = other.at(t - lag(t));
        this.keys.push({ t, p: { x: q.x + offset.x, y: q.y + offset.y } });
      }
      return this;
    }
    /** Wait until absolute time `t` at the current spot. */
    until(t: number): this {
      if (t > this.last.t) this.keys.push({ t, p: this.last.p });
      return this;
    }
    at(t: number): P {
      const k = this.keys;
      if (t <= (k[0] as Key).t) return (k[0] as Key).p;
      for (let i = 1; i < k.length; i++) {
        const b = k[i] as Key;
        if (t <= b.t) {
          const a = k[i - 1] as Key;
          const f = b.t === a.t ? 1 : (t - a.t) / (b.t - a.t);
          return { x: a.p.x + (b.p.x - a.p.x) * f, y: a.p.y + (b.p.y - a.p.y) * f };
        }
      }
      return this.last.p;
    }
  }

  // The story, in seconds from the start. Roles come from the ring (found below): ana hunts bo,
  // bo hunts cy, cy hunts dee, dee hunts eli, eli hunts ana.
  const ana = new Plan(BREWER).pause(25).walk(VISITOR_PATH, 1.2).pause(40).walk(POND_E, 1.25).until(345);
  const bo = new Plan(POND_W)
    .pause(30)
    .walk(POND_N, 1.0)
    .walk(POND_E, 1.0)
    .walk(POND_S, 1.0)
    .walk(POND_W, 1.0)
    .until(330)
    .walk(CAROUSEL, 1.5)
    .walk(NW, 1.7)
    .pause(400);
  // Ana closes in on Bo: the lag shrinks from 14 s to 4 s as she catches up behind the carousel.
  ana.follow(bo, 470, (t) => Math.max(4, 14 - (t - 345) / 10), { x: 5, y: -4 });
  ana
    .pause(35)
    .walk(MONUMENT, 1.3)
    .walk(BURYING, 1.35)
    .pause(60)
    .walk(WEST, 1.3)
    .walk(BANDSTAND, 1.2)
    .until(905);
  const cy = new Plan(BURYING)
    .pause(40)
    .walk(SE, 1.2)
    .walk(BANDSTAND, 1.25)
    .pause(50)
    .walk(BURYING, 1.1)
    .pause(600);
  const dee = new Plan(SW).pause(60).walk(WEST, 1.1).walk(MONUMENT, 1.2).pause(90).walk(SW, 1.3).until(880);
  dee.walk(WEST, 1.6).walk(CAROUSEL, 1.5).walk(NW, 1.4).pause(400);
  const eli = new Plan(NW)
    .pause(45)
    .walk(NORTH, 1.25)
    .walk(POND_N, 1.2)
    .pause(80)
    .walk(CAROUSEL, 1.2)
    .until(820);
  eli.walk(MONUMENT, 1.45).walk(BANDSTAND, 1.4).until(945);
  // Ana walks after Dee towards the west; Eli comes up behind her.
  ana.follow(dee, 1080, () => 26, { x: -3, y: 8 });
  eli.follow(ana, 1100, (t) => Math.max(4, 16 - (t - 945) / 8), { x: -4, y: -5 });
  eli.pause(30).walk(SE, 1.2).walk(VISITOR_PATH, 1.1).pause(400);
  ana.pause(400);
  const plans = [ana, bo, cy, dee, eli];

  // Cy's phone dies in a bag near the burying ground.
  const CY_DARK_S = 652;

  // ── Ring: search VRF request ids until the shuffle is ana → bo → cy → dee → eli ────

  const vrfPk = ed25519.getPublicKey(VRF_SK);
  const refereePk = ed25519.getPublicKey(REFEREE_SK);
  const sorted = sortAccounts(ACCOUNTS);
  const want = ACCOUNTS.join(">");
  let alpha = "";
  let vrfSignature = new Uint8Array(64);
  let ring: string[] = [];
  for (let req = 1; ; req++) {
    alpha = `vrf:${req}:tail-fixture.testnet:${MATCH_HEX}`;
    vrfSignature = ed25519.sign(utf8(alpha), VRF_SK);
    ring = buildRing(ACCOUNTS, vrfSignature);
    const k = ring.indexOf(ACCOUNTS[0] as string);
    if ([...ring.slice(k), ...ring.slice(0, k)].join(">") === want) break;
  }
  // Player index = position in the sorted account list (here the same as NAMES order).
  const idx = (name: (typeof NAMES)[number]) => sorted.indexOf(`${name}.tail-fixture.testnet`);
  const N = sorted.length;
  const planOf = (i: number) =>
    plans[NAMES.indexOf((sorted[i] as string).split(".")[0] as (typeof NAMES)[number])] as Plan;

  // ── Contacts from geometry, then strike times from the lock rule ────────────────────

  const midS = (e: number) => (e * EPOCH_MS + EPOCH_MS / 2) / 1000;
  const inSafehouse = (p: P) => dist(p, SAFE_P) <= SAFEHOUSE.radiusM;

  // When each player stops reporting (out or dark), in seconds; refined as tags are planned.
  const silentFrom = new Array<number>(N).fill(DURATION_MS / 1000 + 1);
  silentFrom[idx("cy")] = CY_DARK_S;
  const transmitting = (i: number, s: number) => s < (silentFrom[i] as number);

  function contactAt(a: number, b: number, e: number): boolean {
    const s = midS(e);
    if (!transmitting(a, s + 7.5) || !transmitting(b, s + 7.5)) return false;
    const pa = planOf(a).at(s);
    const pb = planOf(b).at(s);
    return dist(pa, pb) <= BLE_RANGE_M && !inSafehouse(pa) && !inSafehouse(pb);
  }

  // A strike lands in the hunter's first batch after the HUD showed a full lock: the referee
  // counts lock at the strike's epoch from contacts already logged, which reach one epoch back.
  const strikes: { hunter: number; target: number; tS: number }[] = [];
  function planStrike(h: number, t: number, fromS: number) {
    for (let tS = Math.ceil(fromS / 5) * 5; tS < DURATION_MS / 1000; tS += 5) {
      const e = Math.floor((tS * 1000) / EPOCH_MS);
      let lock = 0;
      for (let w = Math.max(0, e - WINDOW_EPOCHS + 1); w < e; w++) if (contactAt(h, t, w)) lock++;
      // Two epochs of reporting lag plus a beat to press STRIKE after the HUD fills.
      const settled = (tS * 1000) % EPOCH_MS >= 9_000;
      if (lock >= LOCK_EPOCHS && contactAt(h, t, e - 1) && settled) {
        strikes.push({ hunter: h, target: t, tS });
        silentFrom[t] = Math.ceil((tS + 10) / 10) * 10 + 5;
        return;
      }
    }
    throw new Error(`no lock for ${sorted[h]} on ${sorted[t]}`);
  }
  planStrike(idx("ana"), idx("bo"), 300);
  planStrike(idx("eli"), idx("ana"), 940);

  // Hints: Eli asks about Ana twice (his target until he tags her), then once about Dee, whom he
  // hunts after that. Ana's hint money is credited to her as she goes out; Dee's is still owed to
  // her at End. Values computed like the referee.
  const hints: { player: number; kind: number; tS: number; question?: string }[] = [
    { player: idx("eli"), kind: HintKind.Near, tS: 205, question: "Is Ana anywhere near me?" },
    { player: idx("eli"), kind: HintKind.Bearing, tS: 905 },
    { player: idx("eli"), kind: HintKind.Bearing, tS: 1125 },
  ];
  function bearing8(from: P, to: P) {
    const deg = ((Math.atan2(to.x - from.x, to.y - from.y) * 180) / Math.PI + 360) % 360;
    return Math.round(deg / 45) % 8;
  }
  const DIRS = ["North", "Northeast", "East", "Southeast", "South", "Southwest", "West", "Northwest"];
  function handlerLine(kind: number, value: number): string {
    if (kind === HintKind.Near)
      return value
        ? "Close. Inside a long throw of you. Put the phone away and look up."
        : "Not close. Ana is more than a block away and walking like she owns the place.";
    return `${DIRS[value]}. Your target is moving, so don't jog. Joggers get noticed.`;
  }

  // ── Batches ──────────────────────────────────────────────────────────────────────

  const kTag = deriveTagKey(K_M);
  const kPlayers = sorted.map((_, i) => derivePlayerKey(K_M, i));
  interface Made {
    batch: Batch;
    arrive: number; // ms after start the relay has it
  }
  const batches: Made[] = [];
  for (let i = 0; i < N; i++) {
    const plan = planOf(i);
    let prev: Uint8Array = new Uint8Array(32);
    let lastFix = -FIX_EVERY_MS;
    let noise: P = { x: 0, y: 0 };
    let seq = 0;
    for (let t = BATCH_MS; t <= DURATION_MS; t += BATCH_MS) {
      if (!transmitting(i, t / 1000)) break;
      const fixes: Fix[] = [];
      for (let f = lastFix + FIX_EVERY_MS; f <= t; f += FIX_EVERY_MS) {
        // GPS error drifts slowly, as it does under trees.
        noise = { x: noise.x * 0.85 + gauss() * 0.9, y: noise.y * 0.85 + gauss() * 0.9 };
        const p = plan.at(f / 1000);
        const ll = toLonLat({ x: p.x + noise.x, y: p.y + noise.y });
        const q = plan.at((f - 1000) / 1000);
        fixes.push({
          tMs: BigInt(START_MS + f),
          latE7: Math.round(ll.lat * 1e7),
          lonE7: Math.round(ll.lon * 1e7),
          accM: 5 + Math.floor(rand() * 6),
          speedCmps: Math.round(dist(p, q) * 100),
          flags: 0,
        });
        lastFix = f;
      }
      const sightings: Sighting[] = [];
      const e = Math.floor((t - 2500) / EPOCH_MS);
      for (let j = 0; j < N; j++) {
        if (j === i || !transmitting(j, t / 1000)) continue;
        const d = dist(plan.at(t / 1000), planOf(j).at(t / 1000));
        if (d > BLE_RANGE_M) continue;
        const rssi = Math.round(-52 - 18 * Math.log10(Math.max(1, d)));
        sightings.push({
          epoch: e,
          token: beaconToken(kTag, kPlayers[j] as Uint8Array, e),
          rssiMax: rssi + 3,
          rssiMed: rssi,
          n: 3 + Math.floor(rand() * 3),
        });
      }
      const actions: Action[] = [];
      for (const h of hints)
        if (h.player === i && h.tS * 1000 > t - BATCH_MS && h.tS * 1000 <= t)
          actions.push({
            kind: "Hint",
            hint: h.kind,
            nonce: 100 + hints.indexOf(h),
            ...(h.question ? { text: h.question } : {}),
          });
      for (const s of strikes)
        if (s.hunter === i && s.tS * 1000 === t)
          actions.push({ kind: "Strike", nonce: 200 + strikes.indexOf(s) });
      const batch: Batch = {
        matchId: MATCH_ID,
        player: i,
        seq,
        prev,
        tMs: BigInt(START_MS + t),
        fixes,
        sightings,
        actions,
      };
      prev = batchHash(batch);
      seq++;
      batches.push({ batch, arrive: t + 600 + Math.floor(rand() * 900) });
    }
  }

  // ── Referee: ticks over the batches, in the engine's order ─────────────────────────

  const log: LogEntry[] = [];
  const kLog = deriveLogKey(K_M);
  /** The salt of the entry appended next, as the referee gives it (a v1 log had none). */
  const nextSalt = () => (V2 ? logSalt(kLog, log.length) : NO_SALT);
  const encodeEntry = V2 ? encodeLogEntry : encodeLogEntryV1;
  const signed: (SignedVerdict | SignedVerdictV1)[] = [];
  const handler: ReplayBundle["handler"] = [];
  let nextSeq = 1;
  let prevDigest = new Uint8Array(32);
  /** Signs the v2 body, or in a v1 fixture the v1 one (where v2 changed the shape). */
  function verdict(body: Verdict, call: Uint8Array, v1Body?: VerdictV1) {
    const base = { matchId: MATCH_ID, seq: nextSeq++, prev: prevDigest, callId: call };
    const payload = V2 || !v1Body ? { ...base, body } : { ...base, body: v1Body };
    const digest = V2 ? verdictDigest({ ...base, body }) : verdictDigestV1(payload as SignedVerdictV1);
    prevDigest = digest;
    log.push({ kind: "Verdict", seq: payload.seq, digest });
    signed.push({ ...payload, sig: ed25519.sign(digest, REFEREE_SK) });
  }
  const encodeVerdict = (v: SignedVerdict | SignedVerdictV1) =>
    V2 ? encodeSignedVerdict(v as SignedVerdict) : encodeSignedVerdictV1(v as SignedVerdictV1);
  const leaves = () => log.map((e) => sha256(Uint8Array.of(0, ...encodeEntry(e))));
  function root(): Uint8Array {
    const merkle = (l: Uint8Array[]): Uint8Array => {
      if (l.length === 0) return sha256(new Uint8Array(0));
      if (l.length === 1) return l[0] as Uint8Array;
      let k = 1;
      while (k << 1 < l.length) k <<= 1;
      return sha256(Uint8Array.of(1, ...merkle(l.slice(0, k)), ...merkle(l.slice(k))));
    };
    return merkle(leaves());
  }

  // Each phone's enrolment, checked by the referee against Apple's App Attest root.
  if (V2)
    for (const [player, account] of sorted.entries())
      log.push({
        kind: "Enrolled",
        player,
        account,
        keyHash: sha256(utf8(`TAIL replay fixture device key ${account}`)),
        attested: true,
      });
  verdict(
    {
      kind: "Start",
      playersHash: playersHash(sorted),
      ringCommit: ringCommit(vrfSignature),
      startMs: BigInt(START_MS),
      endMs: BigInt(END_MS),
    },
    callId(),
  );

  const alive = new Array<boolean>(N).fill(true);
  const heads = new Array<bigint>(N).fill(STAKE);
  // v2: hint money sits in the pool, owed to each target until it goes out or the match ends.
  const pending = new Array<bigint>(N).fill(0n);
  const hintTargets: number[] = [];
  /** When each hint was charged (referee clock), for its demand price. */
  const hintTimes: bigint[] = [];
  /** Moves the pool's debt to `loser` onto their head; the verdict carries it as `credit`. */
  const creditOf = (loser: number) => {
    const credit = V2 ? (pending[loser] as bigint) : 0n;
    heads[loser] = (heads[loser] as bigint) + credit;
    pending[loser] = 0n;
    return credit;
  };
  const target = new Array<number>(N).fill(-1);
  ring.forEach((acc, k) => {
    target[sorted.indexOf(acc)] = sorted.indexOf(ring[(k + 1) % N] as string);
  });
  const present = new Array<number>(N).fill(0);
  // First epoch that counts toward each hunter's lock on their current target.
  const lockFrom = new Array<number>(N).fill(0);
  const ingestedTo = new Array<number>(N).fill(0); // latest batch time seen, ms after start
  const contacts = new Set<string>();
  let pendingReceipts: { hintId: number; text: string }[] = [];
  // Signs a chat the way NEAR AI Cloud does (F2): personal_sign over `model:sha256(req):sha256(resp)`.
  const modelAddress = `0x${toHex(keccak_256(secp256k1.getPublicKey(MODEL_SK, false).slice(1)).slice(12))}`;
  const signedTexts = new Map<number, string>();
  function chatReceipt(r: { hintId: number; text: string }): LogEntry {
    const chatId = `chatcmpl-fixture-${r.hintId}`;
    const req = JSON.stringify({ model: MODEL, hint_id: r.hintId });
    const resp = JSON.stringify({ id: chatId, choices: [{ message: { content: r.text } }] });
    const signedText = `${MODEL}:${toHex(sha256(utf8(req)))}:${toHex(sha256(utf8(resp)))}`;
    signedTexts.set(r.hintId, signedText);
    const msg = utf8(signedText);
    const digest = keccak_256(concat(utf8(`\x19Ethereum Signed Message:\n${msg.length}`), msg));
    const rsig = secp256k1.sign(digest, MODEL_SK, { prehash: false, format: "recovered" });
    return {
      kind: "HintReceipt",
      hintId: r.hintId,
      chatId,
      textHash: sha256(utf8(r.text)),
      signature: concat(rsig.slice(1), Uint8Array.of(27 + (rsig[0] as number))),
      signingAddress: modelAddress,
      salt: nextSalt(),
    };
  }
  let nextHintId = 0;
  let tagsSigned = 0;
  let nextCheckpoint = CHECKPOINT_MS;
  const hunterOf = (p: number) => target.findIndex((t, h) => alive[h] && t === p);
  const lockEpochs = (h: number, t: number, e: number) => {
    const out: number[] = [];
    const [a, b] = h < t ? [h, t] : [t, h];
    for (let w = Math.max(0, e - WINDOW_EPOCHS + 1, lockFrom[h] as number); w <= e; w++)
      if (contacts.has(`${a}:${b}:${w}`)) out.push(w);
    return out;
  };
  const pos = (i: number, s: number) => planOf(i).at(s);

  /**
   * The tampered-log variant: after a checkpoint is signed, change the last Contact entry logged
   * since the checkpoint before it whose pair never tagged, and carry on. Every later root covers
   * the rewritten log; every earlier one stays a prefix of it.
   */
  const tagPairs = new Set(strikes.map((s) => [s.hunter, s.target].sort((x, y) => x - y).join(":")));
  function rewriteHistory(since: number, size: number): string {
    for (let i = size - 1; i > since; i--) {
      const e = log[i] as LogEntry;
      if (e.kind !== "Contact" || tagPairs.has(`${e.a}:${e.b}`)) continue;
      log[i] = { ...e, epoch: e.epoch + 1 };
      return `entry ${i} (contact ${sorted[e.a]?.split(".")[0]}–${sorted[e.b]?.split(".")[0]}, epoch ${e.epoch} → ${e.epoch + 1}) rewritten after checkpoint ${checkpoints} at size ${size}`;
    }
    throw new Error("no contact to rewrite");
  }

  const used = new Set<Made>();
  let checkpoints = 0;
  let lastCheckpointSize = 0;
  let rewrite = "";
  for (let k = 1; ; k++) {
    const now = k * TICK_MS + TICK_LATENCY_MS;
    const call = callId();
    const cur = Math.floor(now / EPOCH_MS);
    if (V2) log.push({ kind: "Tick", tickNo: k, nowMs: BigInt(START_MS + now), callId: call });
    for (const r of pendingReceipts) log.push(chatReceipt(r));
    pendingReceipts = [];
    const tickBatches = batches
      .filter((m) => !used.has(m) && m.arrive <= now && alive[m.batch.player])
      .sort((x, y) => x.batch.player - y.batch.player || x.batch.seq - y.batch.seq);
    const acts: { t: number; player: number; seq: number; action: Action }[] = [];
    for (const m of tickBatches) {
      used.add(m);
      const b = m.batch;
      log.push({ kind: "Batch", player: b.player, seq: b.seq, hash: batchHash(b) });
      const t = Number(b.tMs) - START_MS;
      ingestedTo[b.player] = t;
      if (dist(pos(b.player, t / 1000), { x: 0, y: 0 }) <= ZONE.radiusM) present[b.player] = now;
      for (const a of b.actions) acts.push({ t, player: b.player, seq: b.seq, action: a });
    }
    // Contacts for epochs both players have reported past, in (a, b, epoch) order.
    const found: [number, number, number][] = [];
    for (let a = 0; a < N; a++)
      for (let b = a + 1; b < N; b++) {
        if (!alive[a] || !alive[b]) continue;
        const upTo = Math.floor(Math.min(ingestedTo[a] as number, ingestedTo[b] as number) / EPOCH_MS);
        for (let e = Math.max(0, upTo - 12); e < upTo; e++)
          if (!contacts.has(`${a}:${b}:${e}`) && contactAt(a, b, e)) found.push([a, b, e]);
      }
    found.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
    for (const [a, b, e] of found) {
      contacts.add(`${a}:${b}:${e}`);
      log.push({ kind: "Contact", a, b, epoch: e, salt: nextSalt() });
    }
    acts.sort((x, y) => x.t - y.t || x.player - y.player);
    for (const { t, player: p, seq, action } of acts) {
      const tg = target[p] as number;
      if (!alive[p] || tg < 0) continue;
      if (action.kind === "Strike") {
        const e = Math.floor(t / EPOCH_MS);
        const epochs = lockEpochs(p, tg, e);
        const touching = epochs.includes(e) || epochs.includes(e - 1);
        if (epochs.length < LOCK_EPOCHS || !touching)
          throw new Error(`strike by ${sorted[p]} at ${t} would be refused`);
        const credit = creditOf(tg);
        heads[p] = (heads[p] as bigint) + (heads[tg] as bigint);
        heads[tg] = 0n;
        alive[tg] = false;
        target[p] = target[tg] === p ? -1 : (target[tg] as number);
        target[tg] = -1;
        lockFrom[p] = cur + 1;
        if (V2)
          log.push({
            kind: "Evidence",
            hunter: p,
            target: tg,
            strikeSeq: seq,
            strikeEpoch: e,
            // The forged variant cites, for the first Tag, a window just outside the lock window.
            epochs:
              opts.forge === "evidence" && tagsSigned === 0
                ? [e - WINDOW_EPOCHS, ...epochs.slice(1)]
                : epochs,
            salt: nextSalt(),
          });
        tagsSigned++;
        // The forged variant signs the second Tag for a hunter who wasn't hunting this target.
        const hunter = opts.forge === "tag" && tagsSigned === 2 ? idx("dee") : p;
        verdict({ kind: "Tag", hunter, target: tg, credit }, call, { kind: "Tag", hunter, target: tg });
      } else {
        // v2 prices follow demand over the last 5 minutes, on the referee clock (clamped to the
        // end like the referee does); v1 hints paid the base price.
        const chargedMs = BigInt(START_MS + Math.min(now, DURATION_MS));
        const price = hintPrice(STAKE, action.hint as HintKind, V2 ? recentHints(hintTimes, chargedMs) : 0);
        hintTimes.push(chargedMs);
        const a = pos(p, t / 1000);
        const b = pos(tg, t / 1000);
        const value = action.hint === HintKind.Near ? Number(dist(a, b) <= HINT_NEAR_M) : bearing8(a, b);
        heads[p] = (heads[p] as bigint) - price;
        if (V2) pending[tg] = (pending[tg] as bigint) + price;
        else heads[tg] = (heads[tg] as bigint) + price;
        hintTargets.push(tg);
        const hintId = nextHintId++;
        verdict({ kind: "Hint", from: p, amount: price, hintId, hint: action.hint, tMs: chargedMs }, call, {
          kind: "Hint",
          from: p,
          to: tg,
          amount: price,
          hintId,
          hint: action.hint,
        });
        const text = handlerLine(action.hint, value);
        pendingReceipts.push({ hintId, text });
        handler.push({
          hintId,
          text,
          chatId: `chatcmpl-fixture-${hintId}`,
          model: MODEL,
        });
      }
    }
    // Dark rules: reporting nothing from inside the zone for DARK_FORFEIT_MS forfeits the head.
    for (let i = 0; i < N; i++) {
      if (!alive[i] || alive.filter(Boolean).length <= 1) continue;
      if (now - (present[i] as number) >= DARK_FORFEIT_MS) {
        const to = hunterOf(i);
        if (to < 0) continue;
        const credit = creditOf(i);
        heads[to] = (heads[to] as bigint) + (heads[i] as bigint);
        heads[i] = 0n;
        alive[i] = false;
        target[to] = target[i] === to ? -1 : (target[i] as number);
        target[i] = -1;
        lockFrom[to] = cur + 1;
        verdict({ kind: "Forfeit", player: i, to, credit }, call, { kind: "Forfeit", player: i, to });
      }
    }
    const over = now >= DURATION_MS || alive.filter(Boolean).length <= 1;
    if (over) break;
    if (now >= nextCheckpoint) {
      const from = log.length;
      verdict({ kind: "Checkpoint", logSize: BigInt(log.length), root: root() }, call);
      nextCheckpoint = (Math.floor(now / CHECKPOINT_MS) + 1) * CHECKPOINT_MS;
      if (++checkpoints === opts.rewriteBefore) rewrite = rewriteHistory(lastCheckpointSize, from);
      lastCheckpointSize = from;
    }
  }
  const endCall = callId();
  for (const r of pendingReceipts) log.push(chatReceipt(r));
  // What the pool still owes a survivor goes onto their head when the contract settles.
  for (let i = 0; i < N; i++) creditOf(i);
  const endTargets = opts.forge === "hint-target" ? [idx("bo"), ...hintTargets.slice(1)] : hintTargets;
  const end = { alpha, vrfSignature, logSize: BigInt(log.length), root: root() };
  verdict({ kind: "End", ...end, hintTargets: endTargets }, endCall, { kind: "End", ...end });

  // ── Bundle ───────────────────────────────────────────────────────────────────────

  const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
  const bundle: ReplayBundleV2 = {
    version: 2,
    match: {
      id: MATCH_HEX,
      contract: "tail.tail-dev-a38d13.testnet",
      network: "testnet",
      token: "usdc.fakes.testnet",
      stake: STAKE.toString(),
      startMs: START_MS,
      endMs: END_MS,
      zone: ZONE,
      safehouses: [SAFEHOUSE],
      publicReplay: true,
      players: sorted,
    },
    referee: {
      project: "tail-fixture/referee",
      api: "https://testnet-api.outlayer.ai",
      refereePk: toHex(refereePk),
      vrfPk: toHex(vrfPk),
    },
    verdicts: signed.map((v) => ({ signed: b64(encodeVerdict(v)), txHash: null })),
    leaves: leaves().map(toHex),
    log: log.map((e) => b64(encodeEntry(e))),
    batches: batches.filter((m) => used.has(m)).map((m) => b64(encodeBatch(m.batch))),
    reveal: { vrfAlpha: alpha, vrfSignature: toHex(vrfSignature), ring, kM: toHex(K_M) },
    devices: sorted.map((accountId) => ({ accountId, kind: "phone", attested: true })),
    // The Handler's words were sealed to the asker; the bundle has only what the model signed.
    handler: handler.map((h) => ({ hintId: h.hintId, signedText: signedTexts.get(h.hintId) ?? null })),
  };
  if (!V2) {
    // The v1 shape: the relay held the quotes, and had no leaves, devices or signed text.
    const { leaves: _l, devices: _d, reveal, ...rest } = bundle;
    const { kM: _k, ...reveal1 } = reveal;
    const v1: ReplayBundle = { ...rest, reveal: reveal1, version: 1, handler };
    return { bundle, v1, tampered: bundle, rewrite, summary: [] };
  }

  // Tampered: someone rewrote the second tag to credit Dee, keeping the referee's old signature.
  const tags = signed.filter((v) => v.body.kind === "Tag");
  const forged = tags[1] as SignedVerdict;
  const forgedBody: Verdict = { ...(forged.body as Extract<Verdict, { kind: "Tag" }>), hunter: idx("dee") };
  const tampered: ReplayBundleV2 = {
    ...bundle,
    verdicts: bundle.verdicts.map((v, i) =>
      signed[i] === forged ? { ...v, signed: b64(encodeSignedVerdict({ ...forged, body: forgedBody })) } : v,
    ),
  };

  const fmt = (n: bigint) => (Number(n) / 1e6).toFixed(2);
  return {
    bundle,
    v1: null,
    tampered,
    rewrite,
    summary: [
      `ring: ${ring.map((a) => a.split(".")[0]).join(" → ")}`,
      `verdicts: ${signed.length} (${signed.map((v) => v.body.kind[0]).join("")}), log: ${log.length}, batches: ${used.size}`,
      `strikes at ${strikes.map((s) => s.tS).join(", ")} s; heads: ${sorted.map((a, i) => `${a.split(".")[0]} ${fmt(heads[i] as bigint)}`).join(", ")}`,
    ],
  };
}
