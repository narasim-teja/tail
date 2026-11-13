// Lobby: a big QR first (friends scan it in person), then the short code large enough to read
// across a park and a Share link carrying it, players as initials with names, stake and
// length, Start for the host (enabled at min players), Leave. A lobby that can no longer start
// offers only what the chain still allows (tail/lobby.ts): leave, or the host calls it off. The QR keeps the full match id:
// it never expires, while the short code works only while the lobby is open.
import { useEffect, useRef, useState } from "react";
import { Animated, Share, StyleSheet, View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import { joinLink } from "../relay/client";
import { TOP_UP, useApp } from "../state/app";
import { handleOf, money } from "../tail/huntModel";
import { type LobbyMay, type LobbyState, lobbyState } from "../tail/lobby";
import { haptic } from "../ui/haptics";
import {
  Avatar,
  Body,
  Button,
  Caption,
  Eyebrow,
  Figure,
  Label,
  Notice,
  Num,
  Row,
  Screen,
  Strong,
  Title,
} from "../ui/kit";
import { rise, useArrive, useReduceMotion } from "../ui/motion";
import { qrPath } from "../ui/qr";
import { Ripple } from "../ui/scene";
import { color, radius, space } from "../ui/theme";

/** Open seats drawn before the rest fold into a count. */
const SEATS_SHOWN = 3;

export interface LobbyModel {
  matchId: string;
  /** "K7M-4QX"; null for a match the relay made before lobby codes. */
  code: string | null;
  stake: bigint | null;
  minutes: number | null;
  players: { id: string; host: boolean; me: boolean }[];
  minPlayers: number;
  state: LobbyState;
  /** What this person can do now, as the chain would take it (tail/lobby.ts). */
  may: LobbyMay;
  isHost: boolean;
  joined: boolean;
  balance: bigint | null;
  /** A test relay: the host may fill an open seat with a test player. */
  testPlayers: boolean;
  busy: string | null;
  error: string | null;
  /** Something the app did on its own, in one line (a re-enrolment). */
  notice?: string | null;
}

export interface LobbyActions {
  onJoin: () => void;
  onLeave: () => void;
  onStart: () => void;
  onCallOff: () => void;
  onTopUp: () => void;
  onAddTestPlayer: () => void;
  onRefresh?: () => Promise<unknown>;
  onBack: () => void;
}

/** "ABCD EFGH …": a full match id in groups of four, for a lobby that has no short code. */
export const groupCode = (id: string) => (id.toUpperCase().match(/.{1,4}/g) ?? []).join(" ");

/** What Share sends: the code to type and a link that opens the lobby. */
export function shareMessage(m: Pick<LobbyModel, "matchId" | "code">): string {
  return m.code
    ? `Join my TAIL hunt. Code ${m.code}, or open ${joinLink(m.code)}`
    : `Join my TAIL hunt: ${joinLink(m.matchId)}`;
}

function Qr({ value, size }: { value: string; size: number }) {
  const q = qrPath(value);
  const n = q.count + 8;
  return (
    <View accessible accessibilityRole="image" accessibilityLabel="Lobby code to scan" style={styles.qr}>
      <Svg width={size} height={size} viewBox={`0 0 ${n} ${n}`}>
        <Rect width={n} height={n} fill={color.paper} />
        <Path d={q.d} fill={color.ink} />
      </Svg>
    </View>
  );
}

function stateLine(
  m: Pick<LobbyModel, "state" | "isHost" | "joined">,
  nowMs: number,
): {
  title: string;
  detail?: string;
} | null {
  const s = m.state;
  switch (s.kind) {
    case "loading":
      return { title: "Loading the lobby" };
    case "waiting":
      return { title: `Waiting for ${s.need} more ${s.need === 1 ? "player" : "players"}` };
    case "ready":
      return { title: "Ready to start" };
    case "starting":
      return { title: "Starting", detail: "The referee is dealing targets." };
    case "retry":
      return {
        title: "Start didn't go through",
        detail: m.isHost ? s.reason : `${s.reason} The host can try again.`,
      };
    case "dead": {
      if (s.freeAtMs === null)
        return { title: "This lobby can't start", detail: `${s.reason} Leave to get your stake back.` };
      const min = Math.max(1, Math.ceil((s.freeAtMs - nowMs) / 60_000));
      const then = m.isHost ? "call it off and every stake goes back" : "leave and get your stake back";
      return { title: "This lobby can't start", detail: `${s.reason} In ${min} min you can ${then}.` };
    }
    case "lapsed": {
      const title = s.why === "lock" ? "The start ran out of time" : "The start time passed";
      const detail = m.isHost
        ? "Nobody can join or start it now. Call it off and every stake goes back."
        : m.joined
          ? "Nobody can join or start it now. Leave to get your stake back, or the host can call it off."
          : "Nobody can join or start it now.";
      return { title, detail };
    }
    case "aborted":
      return { title: "Match called off", detail: "Every stake went back to its player's balance." };
  }
}

type Player = LobbyModel["players"][number];

/** A player arriving slides up into the list; while targets are dealt, rings run round them. */
function PlayerRow({ p, dealing, reduceMotion }: { p: Player; dealing: boolean; reduceMotion: boolean }) {
  const t = useArrive(p.id, reduceMotion, { ms: 320 });
  return (
    <Animated.View
      style={[styles.player, rise(t, 10)]}
      accessible
      accessibilityLabel={`${p.id}${p.host ? ", host" : ""}${p.me ? ", you" : ""}`}
    >
      <View style={styles.seat}>
        <Ripple size={64} tint={color.ink} rings={1} reduceMotion={reduceMotion || !dealing} ms={1_600}>
          <Avatar name={p.id} mark={p.me} />
        </Ripple>
      </View>
      <View style={styles.grow}>
        <Label>{handleOf(p.id)}</Label>
        {p.host || p.me ? (
          <Caption muted>{[p.host ? "Host" : null, p.me ? "You" : null].filter(Boolean).join(" · ")}</Caption>
        ) : null}
      </View>
    </Animated.View>
  );
}

/** A seat still to fill: a dashed ring, softly calling. */
function OpenSeat({ reduceMotion }: { reduceMotion: boolean }) {
  return (
    <View style={styles.player} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={styles.seat}>
        <Ripple size={64} tint={color.mute} rings={1} reduceMotion={reduceMotion} ms={2_600}>
          <View style={styles.open} />
        </Ripple>
      </View>
      <Label muted>Open seat</Label>
    </View>
  );
}

export function LobbyView({
  m,
  actions,
  nowMs = Date.now(),
}: {
  m: LobbyModel;
  actions: LobbyActions;
  /** The clock a held lobby counts down by. */
  nowMs?: number;
}) {
  const reduceMotion = useReduceMotion();
  // Someone sat down: a tick in the hand of everyone waiting.
  const count = useRef(m.players.length);
  useEffect(() => {
    if (m.players.length > count.current) haptic.select();
    count.current = m.players.length;
  }, [m.players.length]);
  const need = m.state.kind === "waiting" ? m.state.need : 0;
  const link = joinLink(m.matchId);
  const startable = m.state.kind === "waiting" || m.state.kind === "ready" || m.state.kind === "retry";
  // A lobby that can't start: getting the stakes back is the one thing left, so it leads.
  const over = m.state.kind === "dead" || m.state.kind === "lapsed";
  const line = stateLine(m, nowMs);
  const short = m.stake !== null && m.balance !== null && !m.joined && m.balance < m.stake;
  const footer = (
    <>
      {m.may.join ? (
        short ? (
          <Button
            symbol="plus.circle"
            title={m.busy ?? "Top up 10"}
            busy={!!m.busy}
            onPress={actions.onTopUp}
            hint="Test USDC on testnet"
          />
        ) : (
          <Button
            title={m.busy ?? `Join for ${m.stake === null ? "" : money(m.stake)}`}
            busy={!!m.busy}
            onPress={actions.onJoin}
          />
        )
      ) : null}
      {startable && m.joined && m.isHost ? (
        <Button
          title={m.busy ?? (m.state.kind === "retry" ? "Try again" : "Start")}
          busy={!!m.busy}
          disabled={!m.may.start}
          hint={m.state.kind === "waiting" ? "Needs more players" : undefined}
          onPress={actions.onStart}
        />
      ) : null}
      {m.may.callOff ? (
        <Button
          title={m.busy ?? "Call it off"}
          busy={!!m.busy}
          onPress={actions.onCallOff}
          hint="Every stake goes back to its player's balance"
        />
      ) : null}
      {m.may.leave ? (
        <Button
          kind={over && !m.may.callOff ? "primary" : "quiet"}
          title={over && !m.may.callOff && m.busy ? m.busy : "Leave"}
          busy={over && !m.may.callOff && !!m.busy}
          disabled={!!m.busy}
          onPress={actions.onLeave}
          hint="Your stake goes back to your balance"
        />
      ) : (
        <Button kind="quiet" symbol="chevron.left" title="Back" onPress={actions.onBack} />
      )}
    </>
  );
  return (
    <Screen footer={footer} onRefresh={actions.onRefresh}>
      <Title>Lobby</Title>
      <View style={styles.qrWrap}>
        <Qr value={link} size={232} />
      </View>
      <View style={styles.codeRow}>
        {m.code ? (
          <View
            style={styles.grow}
            accessible
            accessibilityLabel={`Code ${[...m.code.replace("-", "")].join(" ")}`}
          >
            <Eyebrow muted>Code</Eyebrow>
            <Num>{m.code}</Num>
          </View>
        ) : (
          <View style={styles.grow}>
            <Eyebrow muted>Code</Eyebrow>
            <Figure>{groupCode(m.matchId)}</Figure>
          </View>
        )}
        <Button
          kind="secondary"
          symbol="square.and.arrow.up"
          title="Share"
          onPress={() => void Share.share({ message: shareMessage(m) })}
        />
      </View>

      <Row gap="xl" style={styles.figures}>
        <View accessible accessibilityLabel={`Stake ${m.stake === null ? "loading" : money(m.stake)}`}>
          <Eyebrow muted>Stake</Eyebrow>
          <Strong>{m.stake === null ? "-" : money(m.stake)}</Strong>
        </View>
        <View accessible accessibilityLabel={`${m.minutes ?? "-"} minutes`}>
          <Eyebrow muted>Length</Eyebrow>
          <Strong>{m.minutes === null ? "-" : `${m.minutes} min`}</Strong>
        </View>
        <View accessible accessibilityLabel={`${m.players.length} players, ${m.minPlayers} to start`}>
          <Eyebrow muted>Players</Eyebrow>
          <Strong>{`${m.players.length} of ${m.minPlayers}`}</Strong>
        </View>
      </Row>

      {line ? <Notice title={line.title} detail={line.detail} /> : null}

      <View style={styles.players}>
        {m.players.map((p) => (
          <PlayerRow key={p.id} p={p} dealing={m.state.kind === "starting"} reduceMotion={reduceMotion} />
        ))}
        {Array.from({ length: Math.min(need, SEATS_SHOWN) }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: open seats are interchangeable
          <OpenSeat key={i} reduceMotion={reduceMotion} />
        ))}
        {need > SEATS_SHOWN ? <Caption muted>{`and ${need - SEATS_SHOWN} more`}</Caption> : null}
        {need > 0 && m.isHost && m.joined && m.testPlayers ? (
          <Button
            kind="secondary"
            symbol="person.badge.plus"
            title={m.busy === "Adding a test player" ? "Adding a test player" : "Add a test player"}
            busy={m.busy === "Adding a test player"}
            hint="Testing only: a stand-in that never moves and drops out after a few minutes"
            onPress={actions.onAddTestPlayer}
          />
        ) : null}
        {m.players.length === 0 && m.state.kind !== "loading" ? (
          <Body muted>Nobody yet. Share the code.</Body>
        ) : null}
      </View>
      {m.error ? <Notice title="That didn't go through" detail={m.error} /> : null}
      {m.notice ? <Notice icon="verified" title={m.notice} /> : null}
    </Screen>
  );
}

export function Lobby() {
  const app = useApp();
  useEffect(() => {
    void app.checkRelay();
  }, [app]);
  // A held lobby frees itself on the chain's clock, not on a relay answer: count it down here.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  const m = app.match;
  const chain = m?.chain;
  const me = app.me;
  const players = (chain?.players ?? []).map((p) => ({
    id: p.accountId,
    host: p.accountId === m?.host,
    me: p.accountId === me,
  }));
  const isHost = !!m && m.host === me;
  const joined = players.some((p) => p.me);
  const { state, may } = lobbyState({
    match: m
      ? {
          phase: m.phase,
          chain: chain
            ? {
                phase: chain.phase,
                lockedUntilMs: chain.lockedUntilMs,
                startByMs: chain.startByMs,
                minPlayers: chain.minPlayers,
                players: players.length,
              }
            : null,
        }
      : null,
    isHost,
    joined,
    startPending: app.startPending,
    startError: app.startError,
    nowMs: now,
  });
  return (
    <LobbyView
      nowMs={now}
      m={{
        matchId: app.matchId ?? "",
        code: m?.code ?? null,
        stake: chain?.stake ?? null,
        minutes: chain ? Math.round(chain.durationMs / 60_000) : null,
        players,
        minPlayers: chain?.minPlayers ?? 3,
        state,
        may,
        isHost,
        joined,
        balance: app.balance,
        testPlayers: app.testPlayers,
        busy: app.busy,
        error: app.error,
        notice: app.notice,
      }}
      actions={{
        onJoin: () => void app.join(),
        onLeave: () => void app.leave(),
        onStart: () => void app.start(),
        onCallOff: () => void app.callOff(),
        onTopUp: () => void app.topUp(TOP_UP),
        onAddTestPlayer: () => void app.addTestPlayer(),
        onRefresh: () => app.refreshLobby(),
        onBack: () => app.closeMatch(),
      }}
    />
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  qrWrap: { alignItems: "center", paddingVertical: space.s },
  qr: {
    padding: space.s,
    borderRadius: radius.l,
    backgroundColor: color.paper,
    borderWidth: 1,
    borderColor: color.line,
  },
  codeRow: { flexDirection: "row", alignItems: "center", gap: space.m },
  figures: { paddingVertical: space.s },
  players: { gap: space.m },
  player: { flexDirection: "row", alignItems: "center", gap: space.m },
  // The ring's 64 pt room around a 40 pt avatar, taken back so the avatar lines up with the
  // page edge and rows stay tight.
  seat: { margin: -space.m },
  open: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 2,
    borderStyle: "dashed",
    borderColor: color.mute,
  },
});
