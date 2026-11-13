// Home: Create and Scan to join are the two big actions; you and your balance (both open your
// profile, where top-up and withdraw live); recent matches.
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { FINDING_LOBBY, NEAR_NETWORK, type RecentMatch, useApp } from "../state/app";
import { handleOf, money } from "../tail/huntModel";
import { ContractMismatch } from "../ui/contract";
import { RollingMoney } from "../ui/game";
import {
  Avatar,
  Body,
  Button,
  Caption,
  Eyebrow,
  Field,
  Gap,
  IconButton,
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
  /** Something the app did on its own, in one line (a re-enrolment). */
  notice?: string | null;
  recent: RecentMatch[];
  /** The relay's contract when it differs from this app's (ui/contract.tsx). */
  contractMismatch: string | null;
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
  onProfile,
  onSettings,
  onOpen,
  onUseRelayContract,
  onRefresh,
}: {
  m: HomeModel;
  nowMs: number;
  onCreate: () => void;
  onScan: () => void;
  onCode: (code: string) => void;
  onProfile: () => void;
  onSettings: () => void;
  onOpen: (matchId: string) => void;
  onUseRelayContract: () => void;
  onRefresh?: () => Promise<unknown>;
}) {
  const [code, setCode] = useState("");
  const reduceMotion = useReduceMotion();
  const finding = m.busy === FINDING_LOBBY;
  return (
    <Screen onRefresh={onRefresh}>
      <Row style={styles.header}>
        <Pressable
          onPress={onProfile}
          accessibilityRole="button"
          accessibilityLabel={`${m.handle}, profile`}
          style={({ pressed }) => [styles.me, pressed && styles.pressed]}
        >
          <Avatar name={m.handle} size={32} mark />
          <Strong>{m.handle}</Strong>
        </Pressable>
        <IconButton symbol="gearshape" label="Settings" onPress={onSettings} />
      </Row>

      {/* The park: the game in one glance, playing while you decide. */}
      <View style={styles.park}>
        <ChaseBand height={150} reduceMotion={reduceMotion} track="loop" crowd={4} />
      </View>

      <Pressable
        onPress={onProfile}
        accessibilityRole="button"
        accessibilityLabel={m.balance === null ? "Balance loading" : `Balance ${money(m.balance)}`}
        accessibilityHint="Top up or withdraw"
        style={({ pressed }) => [styles.wallet, pressed && styles.pressed]}
      >
        <Eyebrow muted>{NEAR_NETWORK === "testnet" ? "Test balance" : "Balance"}</Eyebrow>
        {m.balance === null ? <Num>-</Num> : <RollingMoney units={m.balance} reduceMotion={reduceMotion} />}
      </Pressable>
      {m.contractMismatch ? <ContractMismatch relay={m.contractMismatch} onUse={onUseRelayContract} /> : null}
      {m.error ? <Notice title="Something didn't go through" detail={m.error} /> : null}
      {m.notice ? <Notice icon="verified" title={m.notice} /> : null}

      <Gap size="m" />
      <Button symbol="plus" title="Create a match" onPress={onCreate} style={styles.big} />
      <Button
        kind="secondary"
        symbol="qrcode.viewfinder"
        title="Scan to join"
        onPress={onScan}
        style={styles.big}
      />

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
  useEffect(() => {
    void app.refreshAccount();
  }, [app]);
  return (
    <HomeView
      m={{
        handle: handleOf(app.me ?? ""),
        balance: app.wallet?.balance ?? null,
        busy: app.busy,
        error: app.error,
        notice: app.notice,
        recent: app.recent,
        contractMismatch: app.contractMismatch,
      }}
      nowMs={Date.now()}
      onCreate={() => app.openPage("create")}
      onScan={() => app.openPage("scan")}
      onCode={(c) => void app.openMatch(c)}
      onProfile={() => app.openPage("profile")}
      onSettings={() => app.toggleSettings(true)}
      onOpen={(id) => void app.openMatch(id)}
      onUseRelayContract={() => app.switchToRelayContract()}
      onRefresh={() => app.refreshAccount()}
    />
  );
}

const styles = StyleSheet.create({
  header: { justifyContent: "space-between", flexWrap: "nowrap" },
  grow: { flex: 1 },
  park: { borderRadius: radius.l, backgroundColor: color.sand, overflow: "hidden", padding: space.s },
  me: { flexDirection: "row", alignItems: "center", gap: space.s, minHeight: HIT },
  wallet: { alignSelf: "flex-start", paddingTop: space.s },
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
