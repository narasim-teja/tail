// ProximityClient on its own, the way a game other than TAIL would drive it. The full behaviour
// (chain recovery, mesh carry, relaunches) is exercised through TAIL in tail/hunt.test.ts.

import { describe, expect, test } from "bun:test";
import { x25519 } from "@noble/curves/ed25519.js";
import {
  type Action,
  BATCH_MS,
  beaconToken,
  decodeBatchEnvelope,
  derivePlayerKey,
  deriveTagKey,
  HintKind,
  type Hud,
  open,
  type PlayerKeys,
  RejectCode,
  SealContext,
  sha256,
  toHex,
  tokenToUuid,
} from "@tail/protocol";
import type { RadioSighting } from "../../modules/tail-radio";
import { fakeTime } from "../../test/fake-time";
import { hudOf, refereePk, sealedHud } from "../../test/referee";
import { genesis } from "./batch";
import { unconfirmed } from "./chain";
import { ProximityClient, type ProximityNotice, type ProximityRecord, type RadioPort } from "./client";
import type { HudMessage } from "./hud";
import type { Report } from "./receipts";

const START = 1_800_000_000_000;
const km = sha256(new TextEncoder().encode("proximity K_m"));
const kTag = deriveTagKey(km);
const keys: PlayerKeys = {
  matchId: new Uint8Array(16).fill(4),
  player: 0,
  startMs: BigInt(START),
  endMs: BigInt(START + 10 * 60_000),
  kTag,
  kPlayer: derivePlayerKey(km, 0),
  target: "",
};

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

const genesisRecord = (): ProximityRecord => ({
  chain: genesis(),
  outbox: [],
  confirmed: unconfirmed(),
  reports: [],
  hudTick: 0,
  lastFixMs: null,
  actions: [],
});

function rig(record: ProximityRecord = genesisRecord()) {
  const t = fakeTime(START);
  const calls: string[] = [];
  const tokens: string[] = [];
  let sight: ((s: RadioSighting) => void) | undefined;
  const off = () => () => undefined;
  const radio: RadioPort = {
    startBeacon: () => calls.push("startBeacon"),
    setToken: (u) => tokens.push(u),
    stopBeacon: () => calls.push("stopBeacon"),
    setScanFilter: () => undefined,
    startScan: () => calls.push("startScan"),
    stopScan: () => calls.push("stopScan"),
    startLocation: () => calls.push("startLocation"),
    stopLocation: () => calls.push("stopLocation"),
    setPocketMode: (on) => calls.push(`pocket:${on}`),
    onSighting: (fn) => {
      sight = fn;
      return () => (sight = undefined);
    },
    onFix: off,
    onRadioState: off,
    onLocationState: off,
    onAppState: off,
    onProximity: off,
  };
  const refereeBoxSk = x25519.utils.randomSecretKey();
  const boxSk = x25519.utils.randomSecretKey();
  const boxPk = x25519.getPublicKey(boxSk);
  const uploaded: Uint8Array[] = [];
  const saved: ProximityRecord[] = [];
  let frame: ((m: HudMessage) => void) | undefined;
  const client = new ProximityClient({
    boxSk,
    refereeBoxPk: x25519.getPublicKey(refereeBoxSk),
    refereePk,
    record,
    radio,
    assert: async (cdh) => cdh.slice(0, 4),
    batchRequest: async (sealed) => ({
      method: "POST",
      path: "/batch",
      signedPath: "/batch",
      body: toHex(sealed),
      account: "ann.example.testnet",
      timeMs: t.now(),
      sig: new Uint8Array(64),
    }),
    upload: async (r) => {
      uploaded.push(Uint8Array.from(Buffer.from(r.body, "hex")));
    },
    save: (r) => saved.push(structuredClone(r)),
    hud: (onMessage) => {
      frame = onMessage;
      return { open: () => undefined, close: () => undefined };
    },
    carry: { kind: "off", why: "not used here" },
    now: t.now,
    timers: t.timers,
  });
  const batches = () =>
    uploaded.map((s) => decodeBatchEnvelope(open(refereeBoxSk, s, SealContext.batch)).batch);
  const hud = (h: Partial<Hud>) =>
    frame?.({ type: "hud", tick: h.tick ?? 1, sealed: sealedHud(boxPk, hudOf(h)) });
  return {
    t,
    client,
    calls,
    tokens,
    sight: (s: RadioSighting) => sight?.(s),
    batches,
    saved,
    hud,
    frame: (m: HudMessage) => frame?.(m),
  };
}

describe("proximity client", () => {
  test("before start it reports what the saved record holds", () => {
    const r = rig({ ...genesisRecord(), chain: { seq: 3, prev: new Uint8Array(32) } });
    r.client.queueAction({ kind: "Strike", nonce: 1 });
    expect(r.client.status()).toMatchObject({ seq: 3, pendingActions: 1, epoch: null, over: false });
    expect(r.saved.at(-1)?.actions).toEqual([{ kind: "Strike", nonce: 1 }]);
  });

  test("start brings up the radio with this epoch's token, and sightings and actions go out in a batch", async () => {
    const r = rig();
    const receipts: Report[] = [];
    r.client.onReceipt((x) => receipts.push(x));
    r.client.start(keys);
    expect(r.calls).toEqual(["pocket:true", "startLocation", "startBeacon", "startScan"]);
    expect(r.tokens).toEqual([tokenToUuid(beaconToken(kTag, keys.kPlayer, 0))]);
    r.sight({ uuid: tokenToUuid(beaconToken(kTag, derivePlayerKey(km, 1), 0)), rssi: -60, tMs: START + 100 });
    // The client carries the game's action as it is, without reading it.
    const action: Action = { kind: "Hint", hint: HintKind.Near, nonce: 42, text: "check-in at the fountain" };
    r.client.queueAction(action);
    r.t.advance(BATCH_MS);
    await flush();
    const [b] = r.batches();
    expect(b?.actions).toEqual([action]);
    expect(b?.sightings.map((s) => s.n)).toEqual([1]);
    expect(receipts.map((x) => x.seq)).toEqual([0]);
    expect(r.client.status()).toMatchObject({ seq: 1, queued: 0, pendingActions: 0 });
  });

  test("only signed HUDs newer than the last reach the game; anything else is a notice", () => {
    const r = rig();
    const huds: [number, number | null][] = [];
    const notices: ProximityNotice[] = [];
    r.client.onHud((h, prev) => huds.push([h.tick, prev?.tick ?? null]));
    r.client.onNotice((n) => notices.push(n));
    r.client.start(keys);
    r.hud({ tick: 2 });
    r.hud({ tick: 1 });
    r.hud({ tick: 3, player: 1 });
    r.hud({ tick: 4, rejected: { seq: 0, code: RejectCode.ClockSkew } });
    r.hud({ tick: 5, rejected: { seq: 0, code: RejectCode.ClockSkew } });
    expect(huds).toEqual([
      [2, null],
      [4, 2],
      [5, 4],
    ]);
    expect(notices).toEqual([{ kind: "unsigned" }, { kind: "rejected", seq: 0, code: RejectCode.ClockSkew }]);
    expect(r.saved.at(-1)?.hudTick).toBe(5);
  });

  test("the game's own frames pass through; over stops reporting but keeps the socket", () => {
    const r = rig();
    const frames: string[] = [];
    r.client.onFrame((m) => frames.push(m.type));
    r.client.start(keys);
    r.frame({ type: "refused", nonce: 1, action: "check-in", reason: null });
    r.frame({ type: "over" });
    expect(frames).toEqual(["refused"]);
    expect(r.client.status().over).toBe(true);
    expect(r.calls.slice(-4)).toEqual(["stopScan", "stopBeacon", "stopLocation", "pocket:false"]);
  });

  test("one client is for one match", () => {
    const r = rig();
    r.client.start(keys);
    r.client.stop();
    expect(() => r.client.start({ ...keys, matchId: new Uint8Array(16).fill(5) })).toThrow("another match");
    expect(() => r.client.start(keys)).not.toThrow();
  });
});
