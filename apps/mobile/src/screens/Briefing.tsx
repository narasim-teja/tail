// Briefing: your target's name is the whole screen; your head and the start countdown below.
// The reveal is the moment: the chase plays with your target's initials on the ink dot, the
// name slides up out of a mask with a tick in the hand, and the last seconds count down by feel.
import { useEffect, useState } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { money } from "../game/huntModel";
import { clock } from "../game/rules";
import { useApp } from "../state/app";
import { Mark } from "../ui/brand";
import { haptic } from "../ui/haptics";
import { Body, Button, Eyebrow, Notice, Num, Poster, Row, Screen } from "../ui/kit";
import { rise, useArrive, useReduceMotion } from "../ui/motion";
import { ChaseBand, Ripple } from "../ui/scene";
import { motion, space } from "../ui/theme";

/** Seconds before the start that tick in the hand. */
const FINAL = 5;

const initialsOf = (handle: string) =>
  handle
    .split(/[-_]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p.charAt(0).toUpperCase())
    .join("") || "?";

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
  const reduceMotion = useReduceMotion();
  const handle = m.target ? (m.target.split(".")[0] ?? m.target) : null;
  const reveal = useArrive(handle, reduceMotion, { ms: motion.slow * 1.4, delay: 120 });
  const secs = Math.ceil(m.startsInMs / 1_000);
  const step = useArrive(secs <= FINAL ? secs : 0, reduceMotion, { ms: motion.base });
  useEffect(() => {
    if (handle) haptic.tick();
  }, [handle]);
  useEffect(() => {
    if (secs > 0 && secs <= FINAL) haptic.tick();
  }, [secs]);
  if (!m.target || !handle) {
    return (
      <Screen scroll={false} footer={m.error ? <Button title="Try again" onPress={onRetry} /> : null}>
        <View style={[styles.center, !m.error && styles.middle]}>
          {m.error ? null : (
            <Ripple size={220} reduceMotion={reduceMotion}>
              <Mark size={64} />
            </Ripple>
          )}
          <Eyebrow muted center>
            Briefing
          </Eyebrow>
          {m.error ? (
            <Notice title="Your orders didn't open" detail={m.error} />
          ) : (
            <Body muted center>
              {m.busy ?? "Waiting for your orders"}
            </Body>
          )}
        </View>
      </Screen>
    );
  }
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
      <ChaseBand height={190} reduceMotion={reduceMotion} target={initialsOf(handle)} crowd={2} />
      <View style={styles.center} accessible accessibilityLabel={`Your target is ${handle}`}>
        <Eyebrow muted>Your target</Eyebrow>
        {/* The name rises out of a mask, like a card turned over. */}
        <View style={styles.mask}>
          <Animated.View
            style={{
              opacity: reveal,
              transform: [{ translateY: reveal.interpolate({ inputRange: [0, 1], outputRange: [72, 0] }) }],
            }}
          >
            <Poster lines={2} style={styles.name}>
              {handle}
            </Poster>
          </Animated.View>
        </View>
        <Animated.View style={rise(reveal, 6)}>
          <Body muted>{m.target}</Body>
        </Animated.View>
      </View>
      <Row gap="xxl" style={styles.figures}>
        <View accessible accessibilityLabel={`Your head ${m.head === null ? "" : money(m.head)}`}>
          <Eyebrow muted>Your head</Eyebrow>
          <Num>{m.head === null ? "-" : money(m.head)}</Num>
        </View>
        {m.startsInMs > 0 ? (
          <View accessible accessibilityLabel={`Starts in ${clock(m.startsInMs)}`}>
            <Eyebrow muted>Starts in</Eyebrow>
            <Animated.View style={secs <= FINAL ? rise(step, 8) : null}>
              <Num>{clock(m.startsInMs)}</Num>
            </Animated.View>
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
  middle: { alignItems: "center" },
  mask: { overflow: "hidden" },
  name: { paddingBottom: 4 },
  figures: { paddingVertical: space.l },
});
