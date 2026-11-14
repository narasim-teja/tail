// Design preview. Every screen and every state from docs/briefs/mobile.md 6, rendered through the
// same views the live app uses, with fixture data. The simulator has no Bluetooth, so this is how
// the hunt's states are inspected and screenshotted. App.tsx loads it only in development builds
// or a build made with EXPO_PUBLIC_DESIGN_PREVIEW=1; a normal Release bundle never contains it.
//
// Open a state:  tail://preview/<name>?frame=small        (development builds)
//                simctl launch … -tailPreview <name> -tailFrame pro|small   (launch arguments)

import type { ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { BriefingView } from "../screens/Briefing";
import { CreateView } from "../screens/Create";
import { EnrolView } from "../screens/Enrol";
import { HomeView } from "../screens/Home";
import { BlockedView, HuntView, TaggedView } from "../screens/Hunt";
import { type LobbyModel, LobbyView } from "../screens/Lobby";
import { PrimerView } from "../screens/Primer";
import { ProfileView } from "../screens/Profile";
import { ResultsView } from "../screens/Results";
import { ScanView } from "../screens/Scan";
import { type SettingsModel, SettingsView } from "../screens/Settings";
import type { HuntModel } from "../tail/huntModel";
import { hintOptions } from "../tail/huntModel";
import type { Receipts } from "../tail/results";
import { color, space, text } from "../ui/theme";

const NOW = 1_800_000_000_000;
const SETTINGS: SettingsModel = {
  settings: {
    relayUrl: "http://192.168.1.20:8787",
    rpcUrl: "https://test.rpc.fastnear.com",
    meshCarry: false,
  },
  status: { kind: "up", referee: "local" },
  contractId: "tail.tail-dev-a38d13.testnet",
  contractMismatch: null,
  version: "0.1.0",
};
const noop = () => {};
const ID = "7f3a9c21e4b85d60a1c2e3f405162738";
/** A finished receipt check: most reports logged, one refused for the clock. */
const RECEIPTS: Receipts = {
  kind: "done",
  result: {
    size: 2_140,
    final: true,
    total: 180,
    included: Array.from({ length: 179 }, (_, i) => i),
    refused: [{ seq: 179, code: 7 }],
    missing: [],
    badProof: [],
  },
};
const ZONE = {
  zone: { latE7: 423_550_800, lonE7: -710_655_000, radiusM: 420 },
  safehouses: [{ latE7: 423_566_000, lonE7: -710_628_000, radiusM: 25 }],
};
const ME = { lat: 42.35468, lon: -71.06612, heading: 60 };

const LEAVE = { forfeitIn: "3:00", due: false, endsFirst: false, endsIn: "23:41" };

const hunt = (o: Partial<HuntModel> = {}): HuntModel => ({
  target: "maya.tail-dev.testnet",
  timeLeft: "23:41 left",
  lock: 1,
  heat: 0,
  max: 4,
  head: "$5.00",
  canStrike: false,
  strikeSent: false,
  frozenFor: null,
  landedAtMs: null,
  tags: 0,
  tagged: false,
  taggedBy: null,
  waiting: false,
  banner: null,
  me: ME,
  zone: ZONE,
  leak: null,
  dispatch: null,
  log: [],
  hints: hintOptions(5_000_000n),
  status: "",
  blocked: null,
  leaveNow: LEAVE,
  leaving: null,
  left: false,
  ...o,
});

const huntActions = {
  onStrike: noop,
  onHint: noop,
  onOpenSettings: noop,
  onResults: noop,
  onLeave: noop,
  onRejoin: noop,
};

const lobby = (o: Partial<LobbyModel> = {}): LobbyModel => ({
  matchId: ID,
  code: "K7M-4QX",
  stake: 5_000_000n,
  minutes: 30,
  players: [
    { id: "teja.tail-dev.testnet", host: true, me: true },
    { id: "maya.tail-dev.testnet", host: false, me: false },
  ],
  minPlayers: 3,
  requires: null,
  record: null,
  state: { kind: "waiting", need: 1 },
  may: { join: false, leave: true, start: false, callOff: false },
  isHost: true,
  joined: true,
  balance: 20_000_000n,
  testPlayers: true,
  busy: null,
  error: null,
  ...o,
});
const NO_MOVES = { join: false, leave: false, start: false, callOff: false };
const lobbyActions = {
  onJoin: noop,
  onLeave: noop,
  onStart: noop,
  onCallOff: noop,
  onTopUp: noop,
  onAddTestPlayer: noop,
  onBack: noop,
};
const three = [
  { id: "teja.tail-dev.testnet", host: true, me: true },
  { id: "maya.tail-dev.testnet", host: false, me: false },
  { id: "sam-k.tail-dev.testnet", host: false, me: false },
];

const H = (m: HuntModel, extra: { sheet?: boolean; nowMs?: number } = {}) => (
  <HuntView
    m={m}
    nowMs={extra.nowMs ?? NOW}
    reduceMotion
    actions={huntActions}
    sheetOpen={extra.sheet ?? false}
  />
);

export const STATES: Record<string, () => ReactNode> = {
  enrol: () => (
    <EnrolView
      m={{ busy: null, handleError: null, error: null, relaySet: true, unsupported: false }}
      onJoin={noop}
      onSettings={noop}
    />
  ),
  "enrol-checking": () => (
    <EnrolView
      m={{ busy: "Checking this phone", handleError: null, error: null, relaySet: true, unsupported: false }}
      onJoin={noop}
      onSettings={noop}
    />
  ),
  "enrol-taken": () => (
    <EnrolView
      m={{
        busy: null,
        handleError: "That handle is taken. Try another.",
        error: null,
        relaySet: true,
        unsupported: false,
      }}
      onJoin={noop}
      onSettings={noop}
    />
  ),
  "enrol-unsupported": () => (
    <EnrolView
      m={{ busy: null, handleError: null, error: null, relaySet: true, unsupported: true }}
      onJoin={noop}
      onSettings={noop}
    />
  ),
  "primer-1": () => <PrimerView step={0} onDone={noop} />,
  "primer-2": () => <PrimerView step={1} onDone={noop} />,
  "primer-3": () => <PrimerView step={2} onDone={noop} />,
  home: () => (
    <HomeView
      m={{
        handle: "teja",
        balance: 12_500_000n,
        busy: null,
        error: null,
        recent: [
          { matchId: ID, atMs: NOW - 40 * 60_000 },
          { matchId: "0b1c2d3e4f5061728394a5b6c7d8e9f0", atMs: NOW - 26 * 3_600_000 },
        ],
        contractMismatch: null,
      }}
      nowMs={NOW}
      onCreate={noop}
      onScan={noop}
      onCode={noop}
      onProfile={noop}
      onSettings={noop}
      onOpen={noop}
    />
  ),
  "home-first": () => (
    <HomeView
      m={{ handle: "teja", balance: 0n, busy: null, error: null, recent: [], contractMismatch: null }}
      nowMs={NOW}
      onCreate={noop}
      onScan={noop}
      onCode={noop}
      onProfile={noop}
      onSettings={noop}
      onOpen={noop}
    />
  ),
  profile: () => (
    <ProfileView
      m={{
        accountId: "teja.tail-dev-a38d13.testnet",
        balance: 12_500_000n,
        network: "testnet",
        contractId: "tail.tail-dev-a38d13.testnet",
        busy: null,
        error: null,
        contractMismatch: null,
        testRelay: true,
        payout: "teja.testnet",
      }}
      actions={{
        onTopUp: noop,
        onWithdraw: noop,
        checkPayout: () => null,
        onStartOver: noop,
        onBack: noop,
      }}
    />
  ),
  "profile-payout": () => (
    <ProfileView
      m={{
        accountId: "teja.tail-dev-a38d13.testnet",
        balance: 12_500_000n,
        network: "testnet",
        contractId: "tail.tail-dev-a38d13.testnet",
        busy: null,
        error: null,
        contractMismatch: null,
        testRelay: true,
        payout: "teja.tail-dev-a38d13.testnet",
      }}
      actions={{
        onTopUp: noop,
        onWithdraw: noop,
        checkPayout: () => null,
        onStartOver: noop,
        onBack: noop,
      }}
    />
  ),
  settings: () => <SettingsView m={SETTINGS} onSave={noop} onCancel={noop} />,
  "settings-down": () => (
    <SettingsView
      m={{ ...SETTINGS, status: { kind: "down", why: "Can't reach the relay (Network request failed)." } }}
      onSave={noop}
      onCancel={noop}
    />
  ),
  "settings-first": () => (
    <SettingsView
      m={{ ...SETTINGS, settings: { ...SETTINGS.settings, relayUrl: "" }, status: { kind: "unset" } }}
      onSave={noop}
      onCancel={noop}
    />
  ),
  create: () => (
    <CreateView
      m={{
        here: { lat: ME.lat, lon: ME.lon, acc: 6 },
        busy: null,
        error: null,
        openLobby: null,
        record: null,
      }}
      onCreate={noop}
      onOpenLobby={noop}
      onBack={noop}
    />
  ),
  "create-record-below": () => (
    <CreateView
      m={{
        here: { lat: ME.lat, lon: ME.lon, acc: 6 },
        busy: null,
        error: null,
        openLobby: null,
        record: { matches: 1, survived: 0 },
      }}
      initialRule={{ minMatches: 3, minSurvived: 1 }}
      onCreate={noop}
      onOpenLobby={noop}
      onBack={noop}
    />
  ),
  "create-open-lobby": () => (
    <CreateView
      m={{
        here: { lat: ME.lat, lon: ME.lon, acc: 6 },
        busy: null,
        error: null,
        openLobby: "ab".repeat(16),
        record: null,
      }}
      onCreate={noop}
      onOpenLobby={noop}
      onBack={noop}
    />
  ),
  "scan-ask": () => <ScanView permission="ask" onAllow={noop} onScanned={noop} onBack={noop} />,
  "lobby-waiting": () => <LobbyView m={lobby()} actions={lobbyActions} />,
  "lobby-ready": () => (
    <LobbyView
      m={lobby({
        players: three,
        state: { kind: "ready" },
        may: { join: false, leave: true, start: true, callOff: false },
      })}
      actions={lobbyActions}
    />
  ),
  "lobby-join": () => (
    <LobbyView
      m={lobby({
        players: three.map((p) => ({ ...p, me: false })),
        isHost: false,
        joined: false,
        state: { kind: "ready" },
        may: { join: true, leave: false, start: false, callOff: false },
      })}
      actions={lobbyActions}
    />
  ),
  "lobby-join-record": () => (
    <LobbyView
      m={lobby({
        players: three.map((p) => ({ ...p, me: false })),
        isHost: false,
        joined: false,
        requires: { minMatches: 3, minSurvived: 1 },
        record: { matches: 1, survived: 0 },
        state: { kind: "ready" },
        may: { join: true, leave: false, start: false, callOff: false },
        error:
          "This lobby needs 3 matches played and 1 survived. You have 1 played and 0 survived. Only matches that paid out count.",
      })}
      actions={lobbyActions}
    />
  ),
  "lobby-starting": () => (
    <LobbyView
      m={lobby({ players: three, state: { kind: "starting" }, may: { ...NO_MOVES } })}
      actions={lobbyActions}
    />
  ),
  "lobby-retry": () => (
    <LobbyView
      m={lobby({
        players: three,
        state: { kind: "retry", reason: "The referee didn't answer." },
        may: { join: false, leave: false, start: true, callOff: false },
      })}
      actions={lobbyActions}
    />
  ),
  "lobby-dead": () => (
    <LobbyView
      nowMs={NOW}
      m={lobby({
        players: three,
        state: { kind: "dead", reason: "The referee turned the start down.", freeAtMs: NOW + 7 * 60_000 },
        may: { ...NO_MOVES },
      })}
      actions={lobbyActions}
    />
  ),
  "lobby-lapsed": () => (
    <LobbyView
      m={lobby({
        players: three,
        state: { kind: "lapsed", why: "lock" },
        may: { join: false, leave: true, start: false, callOff: true },
      })}
      actions={lobbyActions}
    />
  ),
  "lobby-lapsed-player": () => (
    <LobbyView
      m={lobby({
        players: three.map((p) => ({ ...p, me: p.id.startsWith("maya") })),
        isHost: false,
        state: { kind: "lapsed", why: "lock" },
        may: { join: false, leave: true, start: false, callOff: false },
      })}
      actions={lobbyActions}
    />
  ),
  "lobby-aborted": () => (
    <LobbyView
      m={lobby({ players: three, state: { kind: "aborted" }, may: { ...NO_MOVES } })}
      actions={lobbyActions}
    />
  ),
  briefing: () => (
    <BriefingView
      m={{
        target: "maya.tail-dev.testnet",
        head: 5_000_000n,
        startsInMs: 42_000,
        busy: null,
        error: null,
        leave: { head: "$5.00", time: LEAVE },
      }}
      onHunt={noop}
      onRetry={noop}
      onSettings={noop}
      onLeave={noop}
    />
  ),
  hunt: () => H(hunt({ lock: 2, heat: 1 })),
  "hunt-waiting": () => H(hunt({ lock: 0, heat: 0, waiting: true })),
  "hunt-heat": () => H(hunt({ lock: 1, heat: 3, head: "$5.40" })),
  "hunt-lockfull": () => H(hunt({ lock: 4, heat: 1, canStrike: true })),
  "hunt-strike-sent": () => H(hunt({ lock: 4, heat: 1, canStrike: true, strikeSent: true })),
  "hunt-landed": () =>
    H(hunt({ lock: 0, heat: 1, head: "$10.40", target: "sam-k.tail-dev.testnet", tags: 1, landedAtMs: NOW })),
  "hunt-dark": () =>
    H(
      hunt({
        banner: { kind: "dark", title: "Dark 25 s", detail: "Your area shows in 20 s" },
        status: "4 waiting",
      }),
    ),
  "hunt-dark-leaked": () =>
    H(
      hunt({
        banner: { kind: "dark", title: "Dark 52 s", detail: "Your area was shown to your hunter" },
        status: "9 waiting",
      }),
    ),
  "hunt-zone": () =>
    H(
      hunt({
        banner: {
          kind: "zone",
          title: "Out of zone. Back SW, 80 m",
          detail: "Back in 30 s or your area shows",
        },
      }),
    ),
  "hunt-invisible": () =>
    H(
      hunt({
        banner: {
          kind: "dark",
          title: "You were invisible 42 s",
          detail: "Locked or in the background, your phone can't be heard. Keep TAIL open.",
        },
      }),
    ),
  "hunt-vehicle": () => H(hunt({ lock: 2, frozenFor: "1:45" })),
  "hunt-target-dark": () => H(hunt({ lock: 0, leak: { lat: 42.3562, lon: -71.0641 } })),
  "hunt-dispatch": () =>
    H(
      hunt({
        dispatch: { atMs: NOW - 1_000, text: "Northeast, darling. Walk like you mean it." },
        log: [{ tMs: NOW - 1_000, kind: "handler", text: "Northeast, darling. Walk like you mean it." }],
      }),
    ),
  "hunt-sheet": () => H(hunt({ lock: 1 }), { sheet: true }),
  "hunt-tagged": () => <TaggedView head="$5.40" taggedBy="maya.tail-dev.testnet" onResults={noop} />,
  "hunt-leaving": () =>
    H(
      hunt({ leaveNow: null, leaving: { forfeitIn: "2:14", due: false, endsFirst: false, endsIn: "23:41" } }),
    ),
  "hunt-leaving-due": () =>
    H(hunt({ leaveNow: null, leaving: { forfeitIn: "0:00", due: true, endsFirst: false, endsIn: "23:41" } })),
  "hunt-leaving-ends-first": () =>
    H(hunt({ leaveNow: null, leaving: { forfeitIn: "2:14", due: false, endsFirst: true, endsIn: "1:05" } })),
  "hunt-left": () => <TaggedView head="$5.40" taggedBy="maya.tail-dev.testnet" left onResults={noop} />,
  "hunt-blocked-bt": () => <BlockedView what="bluetooth" onOpenSettings={noop} />,
  "hunt-blocked-loc": () => <BlockedView what="location" onOpenSettings={noop} />,
  "hunt-blocked-approx": () => <BlockedView what="approximate" onOpenSettings={noop} />,
  "hunt-blocked-key": () => <BlockedView what="device-key" onOpenSettings={noop} />,
  "results-survived": () => (
    <ResultsView
      m={{
        outcome: "survived",
        money: { label: "Final head", units: 10_400_000n, note: null },
        tags: 1,
        replayUrl: "https://replay.example/?match=x",
        seed: 0,
        referee: "local",
        receipts: RECEIPTS,
        met: ["maya.tail-dev.testnet"],
        forked: false,
        relayNote: null,
        handlerProblem: null,
      }}
      onReplay={noop}
      onDone={noop}
      onProve={noop}
      onExportFork={noop}
    />
  ),
  "results-out": () => (
    <ResultsView
      m={{
        outcome: "out",
        money: { label: "Final head", units: 0n, note: null },
        tags: 0,
        replayUrl: "https://replay.example/?match=x",
        seed: 0,
        referee: "local",
        receipts: RECEIPTS,
        met: ["maya.tail-dev.testnet"],
        forked: false,
        relayNote: null,
        handlerProblem: null,
      }}
      onReplay={noop}
      onDone={noop}
      onProve={noop}
      onExportFork={noop}
    />
  ),
  "results-refunded": () => (
    <ResultsView
      m={{
        outcome: "survived",
        money: {
          label: "Refunded",
          units: 5_000_000n,
          note: "Refunded: the referee broke a rule (a Tag did not follow the ring), so every player got their stake back.",
        },
        tags: 1,
        replayUrl: "https://replay.example/?match=x",
        seed: 0,
        referee: "local",
        receipts: RECEIPTS,
        met: [],
        forked: false,
        relayNote: null,
        handlerProblem: null,
      }}
      onReplay={noop}
      onDone={noop}
      onProve={noop}
      onExportFork={noop}
    />
  ),
  "results-relay": () => (
    <ResultsView
      m={{
        outcome: "survived",
        money: { label: "Final head", units: 10_400_000n, note: null },
        tags: 0,
        replayUrl: "https://replay.example/?match=x",
        seed: 0,
        referee: "local",
        receipts: RECEIPTS,
        met: [],
        forked: false,
        relayNote: "The relay sent a log proof that didn't check out 2 times. A later check passed.",
        handlerProblem: "The relay delivered a different Handler line than the referee logged.",
      }}
      onReplay={noop}
      onDone={noop}
      onProve={noop}
      onExportFork={noop}
    />
  ),
  "results-running": () => (
    <ResultsView
      m={{
        outcome: "running",
        money: { label: "Final head", units: 0n, note: null },
        tags: 0,
        replayUrl: null,
        seed: 0,
        referee: null,
        receipts: { kind: "checking" },
        met: [],
        forked: true,
        relayNote: null,
        handlerProblem: null,
      }}
      onReplay={noop}
      onDone={noop}
      onProve={noop}
      onExportFork={noop}
    />
  ),
};

/** Phone sizes to lay a state out at: points and safe-area insets of the real devices. */
export const FRAMES = {
  pro: { w: 402, h: 874, insets: { top: 62, bottom: 34, left: 0, right: 0 } },
  small: { w: 375, h: 667, insets: { top: 20, bottom: 0, left: 0, right: 0 } },
} as const;
export type FrameName = keyof typeof FRAMES;

/** Lays the state out at the frame's exact size, then scales it to fit this screen. */
function Frame({ name, children }: { name: FrameName; children: ReactNode }) {
  const win = useWindowDimensions();
  const f = FRAMES[name];
  const scale = Math.min(1, win.width / f.w, win.height / f.h);
  return (
    <View style={styles.backdrop}>
      <View style={{ width: f.w * scale, height: f.h * scale, overflow: "hidden" }}>
        <View
          style={{
            width: f.w,
            height: f.h,
            transform: [
              { translateX: (f.w * (scale - 1)) / 2 },
              { translateY: (f.h * (scale - 1)) / 2 },
              { scale },
            ],
          }}
        >
          <SafeAreaInsetsContext.Provider value={f.insets}>
            <View style={[styles.framed, { width: f.w, height: f.h }]}>{children}</View>
          </SafeAreaInsetsContext.Provider>
        </View>
      </View>
    </View>
  );
}

export function Preview({
  name,
  frame,
  onPick,
}: {
  name: string | null;
  frame: FrameName | null;
  onPick: (n: string) => void;
}) {
  const inset = useSafeAreaInsets();
  const render = name ? STATES[name] : undefined;
  if (render) return frame ? <Frame name={frame}>{render()}</Frame> : render();
  return (
    <ScrollView
      style={{ backgroundColor: color.paper }}
      contentContainerStyle={{ paddingTop: inset.top + space.l, padding: space.xl, gap: space.s }}
    >
      <Text style={[text.title, { color: color.ink }]}>Design preview</Text>
      {Object.keys(STATES).map((k) => (
        <Pressable key={k} onPress={() => onPick(k)} accessibilityRole="button" style={styles.item}>
          <Text style={[text.label, { color: color.ink }]}>{k}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: color.ink, alignItems: "flex-start", justifyContent: "flex-start" },
  framed: { overflow: "hidden", backgroundColor: color.paper },
  item: { minHeight: 44, justifyContent: "center" },
});
