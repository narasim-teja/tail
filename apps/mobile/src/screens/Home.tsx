// Home: Create and Scan to join are the two big actions; balance and Withdraw; recent matches.
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { money } from "../game/huntModel";
import { type RecentMatch, useApp } from "../state/app";
import { Mark } from "../ui/brand";
import {
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
import { HIT, space } from "../ui/theme";

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
  return (
    <Screen>
      <Row style={styles.header}>
        <Row gap="s">
          <Mark size={28} />
          <Strong>{m.handle}</Strong>
        </Row>
        <Button kind="quiet" title="Settings" onPress={onSettings} />
      </Row>

      <View style={styles.wallet}>
        <View
          accessible
          accessibilityLabel={m.balance === null ? "Balance loading" : `Balance ${money(m.balance)}`}
        >
          <Eyebrow muted>Balance</Eyebrow>
          <Num>{m.balance === null ? "-" : money(m.balance)}</Num>
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
        placeholder="32 letters and digits"
        returnKeyType="go"
        onSubmitEditing={() => code.trim() && onCode(code)}
      />
      {code.trim() ? <Button kind="secondary" title="Open lobby" onPress={() => onCode(code)} /> : null}

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
          <Caption muted>Your matches show here. Start one, or scan a friend's lobby code.</Caption>
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
      onCode={(c) => app.openMatch(c)}
      onWithdraw={() => void app.withdraw()}
      onSettings={() => app.toggleSettings(true)}
      onOpen={(id) => app.openMatch(id)}
    />
  );
}

const styles = StyleSheet.create({
  header: { justifyContent: "space-between", flexWrap: "nowrap" },
  wallet: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    paddingTop: space.l,
  },
  big: { minHeight: 64 },
  recent: { minHeight: HIT + 8, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  pressed: { opacity: 0.6 },
});
