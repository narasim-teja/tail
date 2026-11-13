// Home: Create and Scan to join are the two big actions; balance and Withdraw; recent matches.
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { money } from "../game/huntModel";
import { FINDING_LOBBY, type RecentMatch, useApp } from "../state/app";
import { Mark } from "../ui/brand";
import { RollingMoney } from "../ui/game";
import {
  Body,
  Button,
  Caption,
  Eyebrow,
  Field,
  Gap,
  Label,
  Notice,
  Num,
  Row,
  Rule,
  Screen,
  Strong,
} from "../ui/kit";
import { useReduceMotion } from "../ui/motion";
import { ChaseBand } from "../ui/scene";
import { color, HIT, radius, space, text } from "../ui/theme";

/** First run: the whole loop in three numbered lines, where the recent list will be. */
const HOW = [
  "Start a lobby, or scan a friend's.",
  "Everyone stakes. The referee deals each of you a secret target.",
  "Tail yours. Strike at full lock and their head is yours.",
];

export interface HomeModel {
  handle: string;
  balance: bigint | null;
  busy: string | null;
  error: string | null;
  recent: RecentMatch[];
}

const shortCode = (id: string) => `${id.slice(0, 4)} ${id.slice(4, 8)}`.toUpperCase();

function ago(ms: number, now: number): string {
  const m = Math.round((now - ms) / 60_000);
  if (m < 60) return `${Math.max(1, m)} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

export function HomeView({
  m,
  nowMs,
  onCreate,
  onScan,
  onCode,
  onWithdraw,
  onSettings,
  onOpen,
}: {
  m: HomeModel;
  nowMs: number;
  onCreate: () => void;
  onScan: () => void;
  onCode: (code: string) => void;
  onWithdraw: () => void;
  onSettings: () => void;
  onOpen: (matchId: string) => void;
}) {
  const [code, setCode] = useState("");
  const reduceMotion = useReduceMotion();
  const finding = m.busy === FINDING_LOBBY;
  return (
    <Screen>
      <Row style={styles.header}>
        <Row gap="s">
          <Mark size={28} />
          <Strong>{m.handle}</Strong>
        </Row>
        <Button kind="quiet" title="Settings" onPress={onSettings} />
      </Row>

      {/* The park: the game in one glance, playing while you decide. */}
      <View style={styles.park}>
        <ChaseBand height={150} reduceMotion={reduceMotion} track="loop" crowd={4} />
      </View>

      <View style={styles.wallet}>
        <View
          accessible
          accessibilityLabel={m.balance === null ? "Balance loading" : `Balance ${money(m.balance)}`}
        >
          <Eyebrow muted>Balance</Eyebrow>
          {m.balance === null ? <Num>-</Num> : <RollingMoney units={m.balance} reduceMotion={reduceMotion} />}
        </View>
        <Button
          kind="secondary"
          title={m.busy === "Withdrawing" ? "Withdrawing" : "Withdraw"}
          busy={m.busy === "Withdrawing"}
          disabled={!m.balance}
          hint="Sends your balance to your NEAR account"
          onPress={onWithdraw}
        />
      </View>
      {m.error ? <Notice title="Something didn't go through" detail={m.error} /> : null}

      <Gap size="m" />
      <Button title="Create a match" onPress={onCreate} style={styles.big} />
      <Button kind="secondary" title="Scan to join" onPress={onScan} style={styles.big} />

      <Gap size="m" />
      <Field
        label="Or enter a code"
        value={code}
        onChangeText={setCode}
        placeholder="K7M-4QX"
        autoCapitalize="characters"
        returnKeyType="go"
        onSubmitEditing={() => code.trim() && onCode(code)}
      />
      {code.trim() ? (
        <Button
          kind="secondary"
          title={finding ? "Finding the lobby" : "Open lobby"}
          busy={finding}
          onPress={() => onCode(code)}
        />
      ) : null}

      {m.recent.length > 0 ? (
        <>
          <Gap size="l" />
          <Eyebrow muted>Recent</Eyebrow>
          {m.recent.map((r, i) => (
            <View key={r.matchId}>
              {i > 0 ? <Rule /> : null}
              <Pressable
                onPress={() => onOpen(r.matchId)}
                accessibilityRole="button"
                accessibilityLabel={`Match ${shortCode(r.matchId)}, ${ago(r.atMs, nowMs)}`}
                style={({ pressed }) => [styles.recent, pressed && styles.pressed]}
              >
                <Label>{shortCode(r.matchId)}</Label>
                <Caption muted>{ago(r.atMs, nowMs)}</Caption>
              </Pressable>
            </View>
          ))}
        </>
      ) : (
        <>
          <Gap size="l" />
          <Eyebrow muted>How a match goes</Eyebrow>
          {HOW.map((line, i) => (
            <View key={line} style={styles.how}>
              <Text style={styles.howNum} allowFontScaling={false}>
                {i + 1}
              </Text>
              <Body style={styles.grow}>{line}</Body>
            </View>
          ))}
        </>
      )}
    </Screen>
  );
}

export function Home() {
  const app = useApp();
  useEffect(() => app.refreshWallet(), [app]);
  return (
    <HomeView
      m={{
        handle: app.me ?? "",
        balance: app.wallet?.balance ?? null,
        busy: app.busy,
        error: app.error,
        recent: app.recent,
      }}
      nowMs={Date.now()}
      onCreate={() => app.openPage("create")}
      onScan={() => app.openPage("scan")}
      onCode={(c) => void app.openMatch(c)}
      onWithdraw={() => void app.withdraw()}
      onSettings={() => app.toggleSettings(true)}
      onOpen={(id) => void app.openMatch(id)}
    />
  );
}

const styles = StyleSheet.create({
  header: { justifyContent: "space-between", flexWrap: "nowrap" },
  grow: { flex: 1 },
  park: { borderRadius: radius.l, backgroundColor: color.sand, overflow: "hidden", padding: space.s },
  wallet: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    paddingTop: space.s,
  },
  how: { flexDirection: "row", gap: space.m, alignItems: "flex-start" },
  howNum: {
    ...text.figure,
    width: 28,
    height: 28,
    lineHeight: 28,
    borderRadius: 14,
    overflow: "hidden",
    textAlign: "center",
    backgroundColor: color.ink,
    color: color.paper,
  },
  big: { minHeight: 64 },
  recent: { minHeight: HIT + 8, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  pressed: { opacity: 0.6 },
});
