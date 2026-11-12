// Lobby: a big QR first (friends scan it in person), then the short code large enough to read
// across a park and a Share link carrying it, players as initials with names, stake and
// length, Start for the host (enabled at min players), Leave. The QR keeps the full match id:
// it never expires, while the short code works only while the lobby is open.
import { Share, StyleSheet, View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import { money } from "../game/huntModel";
import { joinLink } from "../relay/client";
import { useApp } from "../state/app";
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
import { qrPath } from "../ui/qr";
import { color, radius, space } from "../ui/theme";

export type LobbyState =
  | { kind: "loading" }
  | { kind: "waiting"; need: number }
  | { kind: "ready" }
  | { kind: "starting" }
  | { kind: "failed"; error: string }
  | { kind: "aborted" };

export interface LobbyModel {
  matchId: string;
  /** "K7M-4QX"; null for a match the relay made before lobby codes. */
  code: string | null;
  stake: bigint | null;
  minutes: number | null;
  players: { id: string; host: boolean; me: boolean }[];
  minPlayers: number;
  state: LobbyState;
  isHost: boolean;
  joined: boolean;
  balance: bigint | null;
  busy: string | null;
  error: string | null;
}

export interface LobbyActions {
  onJoin: () => void;
  onLeave: () => void;
  onStart: () => void;
  onTopUp: () => void;
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

function stateLine(s: LobbyState): { title: string; detail?: string } | null {
  switch (s.kind) {
    case "loading":
      return { title: "Loading the lobby" };
    case "waiting":
      return { title: `Waiting for ${s.need} more ${s.need === 1 ? "player" : "players"}` };
    case "ready":
      return { title: "Ready to start" };
    case "starting":
      return { title: "Starting", detail: "The referee is dealing targets." };
    case "failed":
      return { title: "Start failed", detail: s.error };
    case "aborted":
      return { title: "Match called off", detail: "Every stake went back to its player's balance." };
  }
}

export function LobbyView({ m, actions }: { m: LobbyModel; actions: LobbyActions }) {
  const link = joinLink(m.matchId);
  const open = m.state.kind === "waiting" || m.state.kind === "ready" || m.state.kind === "failed";
  const line = stateLine(m.state);
  const short = m.stake !== null && m.balance !== null && !m.joined && m.balance < m.stake;
  const footer = (
    <>
      {open && !m.joined ? (
        short ? (
          <Button
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
      {open && m.joined && m.isHost ? (
        <Button
          title={m.busy ?? (m.state.kind === "failed" ? "Try start again" : "Start")}
          busy={!!m.busy}
          disabled={m.state.kind === "waiting"}
          hint={m.state.kind === "waiting" ? "Needs more players" : undefined}
          onPress={actions.onStart}
        />
      ) : null}
      {open && m.joined ? (
        <Button
          kind="quiet"
          title="Leave"
          disabled={!!m.busy}
          onPress={actions.onLeave}
          hint="Your stake goes back to your balance"
        />
      ) : (
        <Button kind="quiet" title="Back" onPress={actions.onBack} />
      )}
    </>
  );
  return (
    <Screen footer={footer}>
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
          <View
            key={p.id}
            style={styles.player}
            accessible
            accessibilityLabel={`${p.id}${p.host ? ", host" : ""}${p.me ? ", you" : ""}`}
          >
            <Avatar name={p.id} mark={p.me} />
            <View style={styles.grow}>
              <Label>{p.id.split(".")[0] ?? p.id}</Label>
              {p.host || p.me ? (
                <Caption muted>
                  {[p.host ? "Host" : null, p.me ? "You" : null].filter(Boolean).join(" · ")}
                </Caption>
              ) : null}
            </View>
          </View>
        ))}
        {m.players.length === 0 && m.state.kind !== "loading" ? (
          <Body muted>Nobody yet. Share the code.</Body>
        ) : null}
      </View>
      {m.error ? <Notice title="That didn't go through" detail={m.error} /> : null}
    </Screen>
  );
}

export function Lobby() {
  const app = useApp();
  const m = app.match;
  const chain = m?.chain;
  const me = app.me;
  const players = (chain?.players ?? []).map((p) => ({
    id: p.accountId,
    host: p.accountId === m?.host,
    me: p.accountId === me,
  }));
  const state: LobbyState = !m
    ? { kind: "loading" }
    : chain?.phase === "aborted"
      ? { kind: "aborted" }
      : m.phase === "starting" || (chain?.lockedUntilMs ?? null) !== null
        ? { kind: "starting" }
        : m.phase === "failed"
          ? { kind: "failed", error: m.error ?? "The referee did not answer." }
          : chain && players.length < chain.minPlayers
            ? { kind: "waiting", need: chain.minPlayers - players.length }
            : chain
              ? { kind: "ready" }
              : { kind: "loading" };
  return (
    <LobbyView
      m={{
        matchId: app.matchId ?? "",
        code: m?.code ?? null,
        stake: chain?.stake ?? null,
        minutes: chain ? Math.round(chain.durationMs / 60_000) : null,
        players,
        minPlayers: chain?.minPlayers ?? 3,
        state,
        isHost: m?.host === me,
        joined: players.some((p) => p.me),
        balance: app.balance,
        busy: app.busy,
        error: app.error,
      }}
      actions={{
        onJoin: () => void app.join(),
        onLeave: () => void app.leave(),
        onStart: () => void app.start(),
        onTopUp: () => void app.topUp(10_000_000n),
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
});
