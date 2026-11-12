// Briefing: your target's name is the whole screen; your head and the start countdown below.
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { money } from "../game/huntModel";
import { clock } from "../game/rules";
import { useApp } from "../state/app";
import { Body, Button, Eyebrow, Notice, Num, Poster, Row, Screen } from "../ui/kit";
import { space } from "../ui/theme";

export interface BriefingModel {
  target: string | null;
  head: bigint | null;
  /** Milliseconds to the start, or 0 once started. */
  startsInMs: number;
  busy: string | null;
  error: string | null;
}

export function BriefingView({
  m,
  onHunt,
  onRetry,
}: {
  m: BriefingModel;
  onHunt: () => void;
  onRetry: () => void;
}) {
  if (!m.target) {
    return (
      <Screen scroll={false} footer={m.error ? <Button title="Try again" onPress={onRetry} /> : null}>
        <View style={styles.center}>
          <Eyebrow muted>Briefing</Eyebrow>
          {m.error ? (
            <Notice title="Your orders didn't open" detail={m.error} />
          ) : (
            <Body muted>{m.busy ?? "Waiting for your orders"}</Body>
          )}
        </View>
      </Screen>
    );
  }
  const handle = m.target.split(".")[0] ?? m.target;
  return (
    <Screen
      scroll={false}
      footer={
        <Button
          title={m.startsInMs > 0 ? "Get ready" : "Hunt"}
          onPress={onHunt}
          hint="Starts your beacon, scan and location"
        />
      }
    >
      <View style={styles.center} accessible accessibilityLabel={`Your target is ${handle}`}>
        <Eyebrow muted>Your target</Eyebrow>
        <Poster>{handle}</Poster>
        <Body muted>{m.target}</Body>
      </View>
      <Row gap="xxl" style={styles.figures}>
        <View accessible accessibilityLabel={`Your head ${m.head === null ? "" : money(m.head)}`}>
          <Eyebrow muted>Your head</Eyebrow>
          <Num>{m.head === null ? "-" : money(m.head)}</Num>
        </View>
        {m.startsInMs > 0 ? (
          <View accessible accessibilityLabel={`Starts in ${clock(m.startsInMs)}`}>
            <Eyebrow muted>Starts in</Eyebrow>
            <Num>{clock(m.startsInMs)}</Num>
          </View>
        ) : null}
      </Row>
      <Body muted>Someone has you too. Keep TAIL open; in your pocket the screen goes dark on its own.</Body>
    </Screen>
  );
}

export function Briefing() {
  const app = useApp();
  const b = app.briefing;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!b && !app.busy && !app.error) void app.brief();
  }, [b, app]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  return (
    <BriefingView
      m={{
        target: b?.keys.target ?? null,
        head: app.match?.chain?.stake ?? null,
        startsInMs: b ? Math.max(0, Number(b.keys.startMs) - now) : 0,
        busy: app.busy,
        error: app.error,
      }}
      onHunt={() => app.beginHunt()}
      onRetry={() => void app.brief()}
    />
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: "center", gap: space.s },
  figures: { paddingVertical: space.l },
});
