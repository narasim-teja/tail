import { describe, expect, test } from "bun:test";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import {
  BATCH_MS,
  batchHash,
  beaconTag,
  beaconToken,
  decodeBatchEnvelope,
  derivePlayerKey,
  deriveTagKey,
  EPOCH_MS,
  encodeCarryAck,
  encodeHud,
  type Hud,
  LOCK_EPOCHS,
  open,
  openCarry,
  type PlayerKeys,
  RejectCode,
  SealContext,
  seal,
  sealSignedVoiceLine,
  sha256,
  signCarryAck,
  signVoiceLine,
  TargetStatus,
  toHex,
  tokenToUuid,
} from "@tail/protocol";
import type {
  AppStateEvent,
  LocationStateEvent,
  ProximityEvent,
  RadioFix,
  RadioSighting,
} from "../../modules/tail-radio";
import { fakeTime } from "../../test/fake-time";
import { hudOf, refereePk, refereeSk, sealedHud } from "../../test/referee";
import { type Assert, genesis, type OutboxItem } from "../proximity/batch";
import { decodeMeshMessage, encodeMeshMessage, type MeshLink } from "../proximity/carry/mesh";
import { STALL_MS, unconfirmed } from "../proximity/chain";
import type { CarryPlan, RadioPort } from "../proximity/client";
import type { HudMessage } from "../proximity/hud";
import { OFFLINE_CARRY_MS } from "../proximity/outbox";
import { type CarryReply, RelayError, type SignedRequest } from "../proximity/relay";
import { NOT_SIGNED } from "./hud";
import { type HuntRecord, TailHunt } from "./hunt";

const START = 1_800_000_000_000;
const km = sha256(new TextEncoder().encode("session K_m"));
const kTag = deriveTagKey(km);
const keys: PlayerKeys = {
  matchId: new Uint8Array(16).fill(4),
  player: 0,
  startMs: BigInt(START),
  endMs: BigInt(START + 30 * 60_000),
  kTag,
  kPlayer: derivePlayerKey(km, 0),
  target: "bob.tail.testnet",
};

function fakeRadio() {
  const calls: string[] = [];
  const tokens: string[] = [];
  let filter: string[] = [];
  let sight: ((s: RadioSighting) => void) | undefined;
  let fix: ((f: RadioFix) => void) | undefined;
  let radioState: ((role: "peripheral" | "central", state: string) => void) | undefined;
  let locationState: ((e: LocationStateEvent) => void) | undefined;
  let appState: ((e: AppStateEvent) => void) | undefined;
  let proximity: ((e: ProximityEvent) => void) | undefined;
  const radio: RadioPort = {
    startBeacon: () => calls.push("startBeacon"),
    setToken: (u) => tokens.push(u),
    stopBeacon: () => calls.push("stopBeacon"),
    setScanFilter: (p) => {
      filter = p;
    },
    startScan: () => calls.push("startScan"),
    stopScan: () => calls.push("stopScan"),
    startLocation: () => calls.push("startLocation"),
    stopLocation: () => calls.push("stopLocation"),
    setPocketMode: (on) => calls.push(`pocket:${on}`),
    onSighting: (fn) => {
      sight = fn;
      return () => (sight = undefined);
    },
    onFix: (fn) => {
      fix = fn;
      return () => (fix = undefined);
    },
    onRadioState: (fn) => {
      radioState = fn;
      return () => (radioState = undefined);
    },
    onLocationState: (fn) => {
      locationState = fn;
      return () => (locationState = undefined);
    },
    onAppState: (fn) => {
      appState = fn;
      return () => (appState = undefined);
    },
    onProximity: (fn) => {
      proximity = fn;
      return () => (proximity = undefined);
    },
  };
  return {
    radio,
    calls,
    tokens,
    filter: () => filter,
    sight: (s: RadioSighting) => sight?.(s),
    fix: (f: RadioFix) => fix?.(f),
    radioState: (role: "peripheral" | "central", state: string) => radioState?.(role, state),
    locationState: (e: LocationStateEvent) => locationState?.(e),
    appState: (e: AppStateEvent) => appState?.(e),
    proximity: (e: ProximityEvent) => proximity?.(e),
  };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

const fresh = (): HuntRecord => ({
  chain: genesis(),
  outbox: [],
  confirmed: unconfirmed(),
  reports: [],
  hudTick: 0,
  tags: 0,
  lastFixMs: null,
  actions: [],
});

/** The relay's carry keys and a stand-in for `POST /carry`: opens the envelope, signs the receipt. */
const relayBoxSk = x25519.utils.randomSecretKey();
const relayAckSk = ed25519.utils.randomSecretKey();
const carryKey = { boxPk: x25519.getPublicKey(relayBoxSk), ackPk: ed25519.getPublicKey(relayAckSk) };

/** A mesh with one neighbour, `peer`, whose messages the test answers by hand. */
function fakeMesh() {
  const sent: { peer: string; content: string }[] = [];
  let on: Parameters<MeshLink["start"]>[0] | undefined;
  const link: MeshLink = {
    start: async (o) => {
      on = o;
    },
    send: async (peer, content) => {
      sent.push({ peer, content });
    },
    stop: async () => {},
  };
  return {
    link,
    sent,
    neighbour: (peer: string) => on?.neighbour(peer),
    receive: (sender: string, content: string) => on?.message(sender, content),
  };
}

function rig(
  o: {
    upload?: (r: SignedRequest) => Promise<unknown>;
    record?: HuntRecord;
    assert?: Assert;
    startMs?: number;
    carry?: (mesh: ReturnType<typeof fakeMesh>) => CarryPlan;
    boxSk?: Uint8Array;
    refereeBoxSk?: Uint8Array;
  } = {},
) {
  const t = fakeTime(o.startMs ?? START);
  const radio = fakeRadio();
  const refereeBoxSk = o.refereeBoxSk ?? x25519.utils.randomSecretKey();
  const boxSk = o.boxSk ?? x25519.utils.randomSecretKey();
  const boxPk = x25519.getPublicKey(boxSk);
  const uploaded: Uint8Array[] = [];
  const saved: HuntRecord[] = [];
  const mesh = fakeMesh();
  let hud: ((m: HudMessage) => void) | undefined;
  const s = new TailHunt({
    keys,
    stake: 5_000_000n,
    boxSk,
    refereeBoxPk: x25519.getPublicKey(refereeBoxSk),
    refereePk,
    record: o.record ?? fresh(),
    radio: radio.radio,
    assert: o.assert ?? (async (cdh) => Uint8Array.from([...cdh.slice(0, 4)])),
    batchRequest: async (sealed) => ({
      method: "POST",
      path: "/batch",
      signedPath: "/batch",
      body: toHex(sealed),
      account: "alice.tail.testnet",
      timeMs: t.now(),
      sig: new Uint8Array(64),
    }),
    upload:
      o.upload ??
      (async (r) => {
        uploaded.push(Uint8Array.from(Buffer.from(r.body, "hex")));
      }),
    save: (rec) => saved.push(structuredClone(rec)),
    hud: (onMessage) => {
      hud = onMessage;
      return { open: () => {}, close: () => {} };
    },
    carry: o.carry?.(mesh) ?? { kind: "off", why: "Mesh carry is off in Settings." },
    zone: { latE7: 423_550_000, lonE7: -710_660_000, radiusM: 300 },
    now: t.now,
    timers: t.timers,
  });
  const openBatch = (sealed: Uint8Array) =>
    decodeBatchEnvelope(open(refereeBoxSk, sealed, SealContext.batch)).batch;
  const batches = () => uploaded.map(openBatch);
  let tick = 0;
  const sendHud = (h: Partial<Hud> = {}) => {
    tick = h.tick ?? tick + 1;
    hud?.({ type: "hud", tick, sealed: sealedHud(boxPk, hudOf({ tick, ...h })) });
  };
  return {
    t,
    radio,
    s,
    mesh,
    boxPk,
    uploaded,
    openBatch,
    batches,
    saved,
    last: () => saved.at(-1) as HuntRecord,
    sendHud,
    hud: (m: HudMessage) => hud?.(m),
    /** Runs `n` batch rounds. */
    rounds: async (n: number) => {
      for (let i = 0; i < n; i++) {
        t.advance(BATCH_MS);
        await flush();
      }
    },
  };
}

describe("hunt", () => {
  test("starting turns on pocket mode, location, beacon and scan, and advertises this epoch's token", () => {
    const r = rig();
    r.s.start();
    expect(r.radio.calls).toEqual(["pocket:true", "startLocation", "startBeacon", "startScan"]);
    expect(r.radio.tokens).toEqual([tokenToUuid(beaconToken(kTag, keys.kPlayer, 0))]);
    expect(r.radio.filter()).toEqual([toHex(beaconTag(kTag, 0)), toHex(beaconTag(kTag, 1))]);
  });

  test("the token and scan filter rotate at every epoch boundary", () => {
    const r = rig();
    r.s.start();
    r.t.advance(2 * EPOCH_MS + 10);
    expect(r.radio.tokens.slice(1)).toEqual(
      [1, 2].map((e) => tokenToUuid(beaconToken(kTag, keys.kPlayer, e))),
    );
    expect(r.radio.filter()).toEqual([1, 2, 3].map((e) => toHex(beaconTag(kTag, e))));
  });

  test("every BATCH_MS a chained batch with this window's fixes and sightings is uploaded", async () => {
    const r = rig();
    r.s.start();
    const peer = tokenToUuid(beaconToken(kTag, derivePlayerKey(km, 1), 0));
    r.radio.fix({
      tMs: START + 1_000,
      lat: 42.355,
      lon: -71.066,
      acc: 5,
      speed: 0,
      course: 30,
      simulated: null,
      accessory: null,
    });
    r.radio.sight({ uuid: peer, rssi: -61, tMs: START + 1_100 });
    r.radio.sight({ uuid: peer, rssi: -63, tMs: START + 1_200 });
    r.radio.sight({ uuid: "11111111-2222-3333-4444-555555555555", rssi: -40, tMs: START + 1_300 });
    r.t.advance(BATCH_MS);
    await flush();
    r.t.advance(BATCH_MS);
    await flush();
    const [a, b] = r.batches();
    expect(a?.seq).toBe(0);
    expect(a?.sightings.map((x) => x.n)).toEqual([2]);
    expect(a?.fixes).toHaveLength(1);
    expect(b?.seq).toBe(1);
    expect(b?.prev).toEqual(batchHash(a as NonNullable<typeof a>));
    // Saved on every commit and every ack; the last save holds the advanced chain.
    expect(r.last().chain.seq).toBe(2);
    expect(r.s.snapshot().queued).toBe(0);
    expect(r.s.snapshot().lastFix).toMatchObject({ lat: 42.355, lon: -71.066, heading: 30 });
  });

  test("a strike goes out at once in its own batch", async () => {
    const r = rig();
    r.s.start();
    r.t.advance(1_000);
    r.s.strike();
    await flush();
    expect(r.batches().map((b) => b.actions.map((a) => a.kind))).toEqual([["Strike"]]);
  });

  test("a signed HUD drives lock, heat and the STRIKE button", () => {
    const r = rig();
    r.s.start();
    r.sendHud({ tick: 3, epoch: 2, lock: LOCK_EPOCHS, heat: 1 });
    expect(r.s.snapshot().hud).toMatchObject({
      lock: LOCK_EPOCHS,
      heat: 1,
      canStrike: true,
      target: "bob.tail.testnet",
    });
  });

  test("a refusal in the signed HUD and a signed Handler line show up as notes, once each", () => {
    const r = rig();
    r.s.start();
    r.sendHud({ rejected: { seq: 2, code: RejectCode.ClockSkew } });
    r.sendHud({ rejected: { seq: 2, code: RejectCode.ClockSkew } });
    const line = { matchId: keys.matchId, player: 0, hintId: 1, text: "Getting warmer." };
    r.hud({ type: "handler", sealed: sealSignedVoiceLine(r.boxPk, signVoiceLine(line, refereeSk)) });
    expect(r.s.snapshot().notes.map((n) => n.text)).toEqual([
      "Getting warmer.",
      "Phone clock is off. Set it to automatic.",
    ]);
  });

  test("a HUD or Handler line the referee did not sign is named as such and changes nothing", () => {
    const r = rig();
    r.s.start();
    r.sendHud({ lock: 1 });
    const forged = hudOf({ tick: 9, lock: LOCK_EPOCHS, tags: 3 });
    r.hud({ type: "hud", tick: 9, sealed: seal(r.boxPk, encodeHud(forged), SealContext.hud) });
    r.hud({ type: "hud", tick: 9, sealed: sealedHud(r.boxPk, forged, ed25519.utils.randomSecretKey()) });
    const line = { matchId: keys.matchId, player: 0, hintId: 1, text: "Go north." };
    r.hud({
      type: "handler",
      sealed: sealSignedVoiceLine(r.boxPk, signVoiceLine(line, ed25519.utils.randomSecretKey())),
    });
    expect(r.s.snapshot().hud?.lock).toBe(1);
    expect(r.s.snapshot().tags).toBe(0);
    expect(r.s.snapshot().notes.map((n) => n.text)).toEqual([
      `${NOT_SIGNED}.`,
      `${NOT_SIGNED}.`,
      `${NOT_SIGNED}.`,
    ]);
  });

  test("an older signed HUD replayed by the relay is ignored", () => {
    const r = rig();
    r.s.start();
    r.sendHud({ tick: 5, lock: 3 });
    r.sendHud({ tick: 4, lock: 1 });
    expect(r.s.snapshot().hud?.lock).toBe(3);
  });

  test("being out stops the radio and the reports", () => {
    const r = rig();
    r.s.start();
    r.sendHud({ tick: 3, heat: 4, head: 0n, status: TargetStatus.Out, target: "bob" });
    expect(r.radio.calls.slice(-4)).toEqual(["stopScan", "stopBeacon", "stopLocation", "pocket:false"]);
  });

  test("a tag the referee counts lands the strike and clears the sent state", () => {
    const r = rig();
    r.s.start();
    r.sendHud({ lock: LOCK_EPOCHS, target: "bob.tail.testnet" });
    r.s.strike();
    expect(r.s.snapshot().strikeSentAtMs).not.toBeNull();
    r.sendHud({ head: 10_000_000n, target: "carol.tail.testnet", tags: 1 });
    const snap = r.s.snapshot();
    expect(snap.strikeSentAtMs).toBeNull();
    expect(snap.landed?.target).toBe("carol.tail.testnet");
    expect(snap.tags).toBe(1);
    expect(r.last().tags).toBe(1);
  });

  test("leaving the zone starts the out-of-zone clock and coming back stops it", () => {
    const r = rig();
    r.s.start();
    const at = (tMs: number, lat: number) =>
      r.radio.fix({ tMs, lat, lon: -71.066, acc: 5, speed: 1, course: 0, simulated: null, accessory: null });
    at(START + 1_000, 42.355);
    expect(r.s.snapshot().outSinceMs).toBeNull();
    at(START + 3_000, 42.36);
    expect(r.s.snapshot().outSinceMs).toBe(START + 3_000);
    at(START + 5_000, 42.355);
    expect(r.s.snapshot().outSinceMs).toBeNull();
  });

  test("Bluetooth switched off or denied blocks the hunt", () => {
    const r = rig();
    r.s.start();
    r.radio.radioState("central", "poweredOn");
    expect(r.s.snapshot().blocked).toBeNull();
    r.radio.radioState("peripheral", "unauthorized");
    expect(r.s.snapshot().blocked).toBe("bluetooth");
  });

  test("a target lost to a forfeit is not a tag: the referee's count does not move", () => {
    const r = rig();
    r.s.start();
    r.sendHud({ target: "bob.tail.testnet" });
    r.sendHud({ head: 10_000_000n, target: "carol.tail.testnet" });
    expect(r.s.snapshot().tags).toBe(0);
    expect(r.s.snapshot().landed).toBeNull();
    expect(r.s.snapshot().notes[0]?.text).toContain("forfeited");
  });

  test("the dark banner follows the referee's dark_ms, not the phone's relay contact", () => {
    const r = rig();
    r.s.start();
    r.sendHud({ darkMs: 0 });
    r.sendHud({ darkMs: 10_000 });
    r.sendHud({ darkMs: 20_000 });
    expect(r.s.snapshot().dark).toMatchObject({ totalMs: 20_000, runMs: 20_000, counting: true });
    r.sendHud({ darkMs: 20_000 });
    expect(r.s.snapshot().dark).toMatchObject({ runMs: 0, counting: false });
  });

  test("tags won before a relaunch are still counted after it", () => {
    const r = rig({ record: { ...fresh(), tags: 2 } });
    expect(r.s.snapshot().tags).toBe(2);
  });

  test("locked or backgrounded, then back: it says how long you were invisible", () => {
    const r = rig();
    r.s.start();
    r.radio.appState({ state: "inactive", event: "willResignActive", tMs: START + 1_000 });
    r.radio.appState({ state: "background", event: "didEnterBackground", tMs: START + 1_500 });
    r.radio.appState({ state: "background", event: "willEnterForeground", tMs: START + 43_000 });
    r.radio.appState({ state: "active", event: "didBecomeActive", tMs: START + 43_600 });
    expect(r.s.snapshot().invisible?.seconds).toBe(42);
    expect(r.s.snapshot().notes[0]?.text).toContain("You were invisible 42 s");
    // Pulling down Control Centre only makes the app inactive: the beacon keeps going.
    r.radio.appState({ state: "inactive", event: "willResignActive", tMs: START + 50_000 });
    r.radio.appState({ state: "active", event: "didBecomeActive", tMs: START + 52_000 });
    expect(r.s.snapshot().invisible?.seconds).toBe(42);
  });

  test("a phone that cannot turn on proximity monitoring is flagged", () => {
    const r = rig();
    r.s.start();
    r.radio.proximity({ near: false, pocketMode: true, proximitySupported: true, tMs: START });
    expect(r.s.snapshot().noPocketSensor).toBe(false);
    r.radio.proximity({ near: false, pocketMode: true, proximitySupported: false, tMs: START });
    expect(r.s.snapshot().noPocketSensor).toBe(true);
  });

  test("location allowed only as approximate blocks the hunt", () => {
    const r = rig();
    r.s.start();
    r.radio.locationState({ status: "authorizedWhenInUse", fullAccuracy: true, tMs: START });
    expect(r.s.snapshot().blocked).toBeNull();
    r.radio.locationState({ status: "authorizedWhenInUse", fullAccuracy: false, tMs: START });
    expect(r.s.snapshot().blocked).toBe("approximate");
    // Not asked yet is not blocked: iOS has not said anything about accuracy.
    r.radio.locationState({ status: "notDetermined", fullAccuracy: false, tMs: START });
    expect(r.s.snapshot().blocked).toBeNull();
  });

  const at = (tMs: number): RadioFix => ({
    tMs,
    lat: 42.355,
    lon: -71.066,
    acc: 5,
    speed: 0,
    course: -1,
    simulated: null,
    accessory: null,
  });

  test("after a relaunch the cached first fix and anything already sent stay out of the batch", async () => {
    const T = START + 60_000;
    const r = rig({
      startMs: T,
      record: { ...fresh(), lastFixMs: T - 2_000 },
    });
    r.s.start();
    r.radio.fix(at(T - 120_000)); // the cached fix iOS hands over first
    r.radio.fix(at(T - 2_000)); // already sent before the relaunch
    r.radio.fix(at(T + 500));
    r.t.advance(BATCH_MS);
    await flush();
    expect(r.batches()[0]?.fixes.map((f) => Number(f.tMs))).toEqual([T + 500]);
    expect(r.last().lastFixMs).toBe(T + 500);
    expect(r.s.snapshot().fixes).toBe(2);
  });

  test("a strike from a failed build is saved as unsent and goes out after a relaunch", async () => {
    let fail = true;
    const r = rig({
      assert: async (cdh) => {
        if (fail) throw new Error("App Attest busy");
        return cdh.slice(0, 4);
      },
    });
    r.s.start();
    r.t.advance(1_000);
    r.s.strike();
    await flush();
    expect(r.batches()).toHaveLength(0);
    expect(r.s.snapshot().pendingActions).toBe(1);
    const saved = r.last();
    expect(saved.actions.map((a) => a.kind)).toEqual(["Strike"]);
    r.s.stop();
    fail = false;
    const again = rig({ record: saved, startMs: START + 1_000 });
    again.s.start();
    again.t.advance(BATCH_MS);
    await flush();
    expect(again.batches()[0]?.actions).toEqual(saved.actions);
    expect(again.last().actions).toEqual([]);
  });
});

const notes = (r: ReturnType<typeof rig>) => r.s.snapshot().notes.map((n) => n.text);
const seqs = (items: readonly OutboxItem[]) => items.map((i) => i.seq);

describe("chain recovery", () => {
  test("a report refused for its device check: the chain carries on from the referee's next_seq and tip", async () => {
    const r = rig();
    r.s.start();
    await r.rounds(1);
    r.s.strike();
    await flush();
    await r.rounds(1);
    const [b0, b1, b2] = r.batches();
    expect([b0?.seq, b1?.seq, b2?.seq]).toEqual([0, 1, 2]);
    expect(b1?.actions.map((a) => a.kind)).toEqual(["Strike"]);
    const tip = batchHash(b0 as NonNullable<typeof b0>);
    // The referee took 0 and refused 1 for its assertion, so 2 (chained to 1) can never land.
    r.sendHud({ nextSeq: 1, chainTip: tip, rejected: { seq: 1, code: RejectCode.Assertion } });
    await flush();
    expect(seqs(r.last().outbox)).toEqual([]);
    expect(r.last().chain).toEqual({ seq: 1, prev: tip });
    expect(notes(r)).toContain("Your strike didn't reach the referee. Strike again if your lock is full.");
    expect(notes(r)).toContain("2 reports didn't reach the referee. Carrying on from report 1.");
    await r.rounds(1);
    const again = r.batches().at(-1);
    expect(again?.seq).toBe(1);
    expect(again?.prev).toEqual(tip);
    // The next HUD still names that refusal while the new 1 is on its way: no second rebuild.
    r.sendHud({ nextSeq: 1, chainTip: tip, rejected: { seq: 1, code: RejectCode.Assertion } });
    await flush();
    await r.rounds(1);
    expect(
      r
        .batches()
        .slice(-2)
        .map((b) => b.seq),
    ).toEqual([1, 2]);
    r.sendHud({ nextSeq: 2, chainTip: batchHash(again as NonNullable<typeof again>) });
    await flush();
    expect(seqs(r.last().outbox)).toEqual([2]);
  });

  test("restart mid-chain: unconfirmed reports survive the relaunch and the chain goes on from the referee", async () => {
    const boxSk = x25519.utils.randomSecretKey();
    const refereeBoxSk = x25519.utils.randomSecretKey();
    const a = rig({ boxSk, refereeBoxSk });
    a.s.start();
    await a.rounds(4);
    const bs = a.batches();
    a.sendHud({ nextSeq: 2, chainTip: batchHash(bs[1] as NonNullable<(typeof bs)[1]>) });
    await flush();
    expect(seqs(a.last().outbox)).toEqual([2, 3]);
    a.s.stop();
    const saved = a.last();
    const b = rig({ boxSk, refereeBoxSk, record: saved, startMs: a.t.now() });
    b.s.start();
    // Sent before the relaunch, so not sent again: they wait for the referee.
    expect(b.s.snapshot().queued).toBe(0);
    const tip = batchHash(bs[3] as NonNullable<(typeof bs)[3]>);
    b.sendHud({ tick: 10, nextSeq: 4, chainTip: tip });
    await flush();
    expect(seqs(b.last().outbox)).toEqual([]);
    await b.rounds(1);
    expect(b.batches()[0]).toMatchObject({ seq: 4, prev: tip });
    expect(b.last().reports.map((x) => x.seq)).toEqual([0, 1, 2, 3, 4]);
  });

  test("a phone that lost its match file rebuilds from the referee's next_seq and tip", async () => {
    const r = rig();
    r.s.start();
    await r.rounds(2);
    const tip = new Uint8Array(32).fill(9);
    r.sendHud({ nextSeq: 5, chainTip: tip });
    await flush();
    await r.rounds(1);
    expect(r.batches().at(-1)).toMatchObject({ seq: 5, prev: tip });
  });

  test("a report the referee never got is sent again once, then the chain is rebuilt", async () => {
    const r = rig();
    r.s.start();
    await r.rounds(1);
    const first = r.uploaded[0] as Uint8Array;
    r.t.advance(STALL_MS);
    await flush();
    const before = r.uploaded.length;
    r.sendHud({ nextSeq: 0, chainTip: new Uint8Array(32) });
    await flush();
    expect(r.uploaded.slice(before).some((u) => toHex(u) === toHex(first))).toBe(true);
    r.t.advance(STALL_MS);
    await flush();
    r.sendHud({ nextSeq: 0, chainTip: new Uint8Array(32) });
    await flush();
    await r.rounds(1);
    const rebuilt = r.batches().at(-1);
    expect(rebuilt?.seq).toBe(0);
    expect(toHex(r.uploaded.at(-1) as Uint8Array)).not.toBe(toHex(first));
  });
});

describe("mesh carry", () => {
  const carryOn =
    (forward: (e: Uint8Array) => Promise<CarryReply> = async () => Promise.reject(new Error("offline"))) =>
    (mesh: ReturnType<typeof fakeMesh>): CarryPlan => ({
      kind: "on",
      key: carryKey,
      link: mesh.link,
      forward,
    });

  /** A session whose relay is out of reach until `online.value` is set. */
  function offlineRig() {
    const online = { value: false };
    const r = rig({
      upload: async (req) => {
        if (!online.value) throw new RelayError(null, "Can't reach the relay.");
        r.uploaded.push(Uint8Array.from(Buffer.from(req.body, "hex")));
      },
      carry: carryOn(),
    });
    return { r, online };
  }

  const envelopes = (r: ReturnType<typeof rig>) =>
    r.mesh.sent.flatMap((m) => {
      const msg = decodeMeshMessage(m.content);
      return msg?.kind === "request" ? [msg.envelope] : [];
    });

  test("offline, reports go to mesh neighbours sealed for the relay, with no account or match id in the clear", async () => {
    const { r } = offlineRig();
    r.s.start();
    await flush();
    r.mesh.neighbour("off1peer");
    await r.rounds(1 + Math.ceil(OFFLINE_CARRY_MS / BATCH_MS));
    const sent = envelopes(r);
    expect(sent.length).toBeGreaterThan(0);
    for (const m of r.mesh.sent) {
      expect(m.content).not.toContain("alice");
      expect(m.content).not.toContain(toHex(keys.matchId));
    }
    for (const env of sent) expect(env.length).toBe(32 + 4096 + 16);
    const inner = openCarry(relayBoxSk, sent[0] as Uint8Array);
    expect([inner.account, inner.method, inner.path]).toEqual(["alice.tail.testnet", "POST", "/batch"]);
    expect(r.openBatch(Uint8Array.from(Buffer.from(new TextDecoder().decode(inner.body), "hex"))).seq).toBe(
      0,
    );
  });

  test("a carried report counts only when the relay's signed receipt verifies, and its HUD is opened", async () => {
    const { r } = offlineRig();
    r.s.start();
    await flush();
    r.mesh.neighbour("off1peer");
    await r.rounds(1 + Math.ceil(OFFLINE_CARRY_MS / BATCH_MS));
    const env = envelopes(r)[0] as Uint8Array;
    const reply = (sk: Uint8Array, hud: Uint8Array | null) =>
      encodeMeshMessage({
        kind: "reply",
        digest: sha256(env),
        ack: encodeCarryAck(signCarryAck(sk, env, 200, 1n)),
        hud,
      });
    r.mesh.receive("off1peer", reply(ed25519.utils.randomSecretKey(), null));
    expect(r.last().reports).toHaveLength(0);
    r.mesh.receive("off1peer", reply(relayAckSk, sealedHud(r.boxPk, hudOf({ tick: 7, lock: 2 }))));
    expect(r.last().reports.map((x) => x.seq)).toEqual([0]);
    expect(r.s.snapshot().hud?.lock).toBe(2);
    expect(r.s.snapshot().carry).toMatchObject({ kind: "on", carried: 1 });
  });

  test("a report the mesh delivered is not sent over HTTP when the relay comes back, nor counted twice", async () => {
    const { r, online } = offlineRig();
    r.s.start();
    await flush();
    r.mesh.neighbour("off1peer");
    await r.rounds(1 + Math.ceil(OFFLINE_CARRY_MS / BATCH_MS));
    const env = envelopes(r)[0] as Uint8Array;
    const inner = openCarry(relayBoxSk, env);
    const carriedSealed = new TextDecoder().decode(inner.body);
    r.mesh.receive(
      "off1peer",
      encodeMeshMessage({
        kind: "reply",
        digest: sha256(env),
        ack: encodeCarryAck(signCarryAck(relayAckSk, env, 200, 1n)),
        hud: null,
      }),
    );
    online.value = true;
    await r.rounds(3);
    expect(r.uploaded.some((u) => toHex(u) === carriedSealed)).toBe(false);
    const reported = r.last().reports.map((x) => x.seq);
    expect(reported.filter((x) => x === 0)).toHaveLength(1);
    expect(new Set(reported).size).toBe(reported.length);
  });
});
