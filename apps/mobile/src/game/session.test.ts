import { describe, expect, test } from "bun:test";
import { x25519 } from "@noble/curves/ed25519.js";
import {
  BATCH_MS,
  batchHash,
  beaconTag,
  beaconToken,
  decodeBatchEnvelope,
  derivePlayerKey,
  deriveTagKey,
  EPOCH_MS,
  encodeHud,
  LOCK_EPOCHS,
  open,
  type PlayerKeys,
  seal,
  sha256,
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
import { RelayError, type SignedRequest } from "../relay/client";
import type { HudMessage } from "../relay/hud";
import { type Assert, genesis, type OutboxItem } from "./batch";
import { HuntSession, type RadioPort, type SessionRecord } from "./session";

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

function rig(
  o: {
    upload?: (r: SignedRequest) => Promise<unknown>;
    record?: SessionRecord;
    assert?: Assert;
    startMs?: number;
  } = {},
) {
  const t = fakeTime(o.startMs ?? START);
  const radio = fakeRadio();
  const refereeSk = x25519.utils.randomSecretKey();
  const boxSk = x25519.utils.randomSecretKey();
  const uploaded: OutboxItem[] = [];
  const saved: SessionRecord[] = [];
  let hud: ((m: HudMessage) => void) | undefined;
  const carryOffline: boolean[] = [];
  const s = new HuntSession({
    matchIdHex: toHex(keys.matchId),
    keys,
    stake: 5_000_000n,
    boxSk,
    refereeBoxPk: x25519.getPublicKey(refereeSk),
    record: o.record ?? { chain: genesis(), outbox: [], tags: 0, lastFixMs: null, actions: [] },
    radio: radio.radio,
    assert: o.assert ?? (async (cdh) => Uint8Array.from([...cdh.slice(0, 4)])),
    batchRequest: (sealed) => ({
      method: "POST",
      path: "/batch",
      body: toHex(sealed),
      account: "alice",
      timeMs: t.now(),
      sig: new Uint8Array(64),
    }),
    upload:
      o.upload ??
      (async (r) => {
        uploaded.push({ seq: uploaded.length, sealed: Uint8Array.from(Buffer.from(r.body, "hex")) });
      }),
    save: (rec) => saved.push(rec),
    hud: (onMessage) => {
      hud = onMessage;
      return { open: () => {}, close: () => {} };
    },
    carry: () => ({
      status: { kind: "standby" },
      update: async (offline) => {
        carryOffline.push(offline);
      },
      shutdown: async () => {},
    }),
    carryConfig: { nodeAddress: "off1node", serverUrl: "" },
    zone: { latE7: 423_550_000, lonE7: -710_660_000, radiusM: 300 },
    now: t.now,
    timers: t.timers,
  });
  const batches = () =>
    uploaded.map((u) => decodeBatchEnvelope(open(refereeSk, u.sealed, "tail/batch")).batch);
  const sendHud = (h: Parameters<typeof encodeHud>[0]) =>
    hud?.({ type: "hud", tick: h.tick, sealed: seal(x25519.getPublicKey(boxSk), encodeHud(h), "tail/hud") });
  return {
    t,
    radio,
    s,
    batches,
    saved,
    last: () => saved.at(-1) as SessionRecord,
    sendHud,
    carryOffline,
    hud: (m: HudMessage) => hud?.(m),
  };
}

describe("hunt session", () => {
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

  test("a sealed HUD drives lock, heat and the STRIKE button", () => {
    const r = rig();
    r.s.start();
    r.sendHud({
      tick: 3,
      epoch: 2,
      lock: LOCK_EPOCHS,
      heat: 1,
      head: 5_000_000n,
      status: TargetStatus.Hunting,
      target: "bob.tail.testnet",
    });
    expect(r.s.snapshot().hud).toMatchObject({
      lock: LOCK_EPOCHS,
      heat: 1,
      canStrike: true,
      target: "bob.tail.testnet",
    });
  });

  test("a rejected batch and a Handler line show up as notes", () => {
    const r = rig();
    r.s.start();
    r.hud({ type: "rejected", seq: 2, reason: "FixFlags { flags: 1 }" });
    r.hud({ type: "handler", hintId: 1, text: "Getting warmer." });
    expect(r.s.snapshot().notes.map((n) => n.text)).toEqual([
      "Getting warmer.",
      "Location looks simulated. Report rejected.",
    ]);
  });

  test("being out stops the radio and the reports", () => {
    const r = rig();
    r.s.start();
    r.sendHud({ tick: 3, epoch: 2, lock: 0, heat: 4, head: 0n, status: TargetStatus.Out, target: "bob" });
    expect(r.radio.calls.slice(-4)).toEqual(["stopScan", "stopBeacon", "stopLocation", "pocket:false"]);
  });

  test("after twenty seconds without the relay the mesh carry path is told the phone is offline", async () => {
    const r = rig({
      upload: async () => {
        throw new RelayError(null, "Can't reach the relay.");
      },
    });
    r.s.start();
    for (let i = 0; i < 6; i++) {
      r.t.advance(BATCH_MS);
      await flush();
    }
    expect(r.carryOffline.slice(0, 2)).toEqual([false, false]);
    expect(r.carryOffline.at(-1)).toBe(true);
    expect(r.s.snapshot().queued).toBeGreaterThan(1);
  });

  test("a new target on a later HUD counts as a landed strike and clears the sent state", () => {
    const r = rig();
    r.s.start();
    const base = { epoch: 2, lock: LOCK_EPOCHS, heat: 0, head: 5_000_000n, status: TargetStatus.Hunting };
    r.sendHud({ ...base, tick: 3, target: "bob.tail.testnet" });
    r.s.strike();
    expect(r.s.snapshot().strikeSentAtMs).not.toBeNull();
    r.sendHud({ ...base, tick: 4, lock: 0, head: 10_000_000n, target: "carol.tail.testnet" });
    const snap = r.s.snapshot();
    expect(snap.strikeSentAtMs).toBeNull();
    expect(snap.landed?.target).toBe("carol.tail.testnet");
    expect(snap.tags).toBe(1);
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

  const hunting = { epoch: 2, lock: 0, heat: 0, head: 5_000_000n, status: TargetStatus.Hunting };

  test("a target lost to a forfeit is not a tag; a strike that takes the target is, and is saved", () => {
    const r = rig();
    r.s.start();
    r.sendHud({ ...hunting, tick: 3, target: "bob.tail.testnet" });
    // Bob went dark too long: his head and his target come to you without a strike.
    r.sendHud({ ...hunting, tick: 4, head: 10_000_000n, target: "carol.tail.testnet" });
    expect(r.s.snapshot().tags).toBe(0);
    expect(r.s.snapshot().landed).toBeNull();
    expect(r.s.snapshot().notes[0]?.text).toContain("forfeited");
    r.s.strike();
    r.sendHud({ ...hunting, tick: 5, head: 15_000_000n, target: "dave.tail.testnet" });
    expect(r.s.snapshot().tags).toBe(1);
    expect(r.last().tags).toBe(1);
  });

  test("a refused strike does not make the next target change a tag", () => {
    const r = rig();
    r.s.start();
    r.sendHud({ ...hunting, tick: 3, target: "bob.tail.testnet" });
    r.s.strike();
    const nonce = r.last().actions[0]?.nonce ?? null;
    r.hud({ type: "refused", nonce, action: "strike", reason: "Lock { lock: 2 }" });
    r.sendHud({ ...hunting, tick: 5, target: "carol.tail.testnet" });
    expect(r.s.snapshot().tags).toBe(0);
  });

  test("tags won before a relaunch are still counted after it", () => {
    const r = rig({ record: { chain: genesis(), outbox: [], tags: 2, lastFixMs: null, actions: [] } });
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
      record: { chain: genesis(), outbox: [], tags: 0, lastFixMs: T - 2_000, actions: [] },
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
