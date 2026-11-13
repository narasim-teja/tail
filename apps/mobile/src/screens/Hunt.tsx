// The hero screen (docs/briefs/mobile.md 5). Glanced at for two seconds in sunlight: target and
// time left small at the top; LOCK and HEAT huge in the upper two-thirds, HEAD between them; the
// live map below; Handler at thumb reach. Lock full floods the screen persimmon and STRIKE takes
// the map's place. Tagged drops the screen to ink.

import type { HintKind } from "@tail/protocol";
import { useEffect, useRef, useState } from "react";
import { Animated, Linking, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { type HuntModel, handleOf, huntModel, taggedLines } from "../game/huntModel";
import { useApp } from "../state/app";
import { Icon } from "../ui/brand";
import { heatIntervalMs } from "../ui/cadence";
import { HeadValue, HeatBar, LockArc } from "../ui/game";
import { haptic } from "../ui/haptics";
import {
  Body,
  Button,
  Caption,
  Display,
  Eyebrow,
  Figure,
  Screen,
  Strong,
  type Tone,
  ToneProvider,
} from "../ui/kit";
import { MapPanel } from "../ui/map";
import { ease, rise, useArrive, useReduceMotion } from "../ui/motion";
import { Breathe, Ripple } from "../ui/scene";
import { HintSheet } from "../ui/sheet";
import { color, font, maxScale, motion, radius, space } from "../ui/theme";
import { DISPATCH_MS, DispatchStrip, WarningBanner } from "../ui/top";

export interface HuntActions {
  onStrike: () => void;
  onHint: (kind: HintKind, question: string) => void;
  onOpenSettings: () => void;
  onResults: () => void;
}

export function HuntView({
  m,
  nowMs,
  reduceMotion,
  actions,
  sheetOpen: sheetOpenInitial = false,
}: {
  m: HuntModel;
  nowMs: number;
  reduceMotion: boolean;
  actions: HuntActions;
  /** For the design preview: start with the hint sheet up. */
  sheetOpen?: boolean;
}) {
  const inset = useSafeAreaInsets();
  const [sheet, setSheet] = useState(sheetOpenInitial);
  // The arc gives way on short screens and while a banner or dispatch is up, so the map keeps
  // a usable height on a small iPhone.
  const [height, setHeight] = useState(0);
  const busyTop = !!m.banner || (!!m.dispatch && nowMs - m.dispatch.atMs < DISPATCH_MS);
  const arc = height ? Math.round(Math.max(150, Math.min(232, height * 0.3 - (busyTop ? 48 : 0)))) : 232;
  const full = m.canStrike && !m.tagged;
  const flood = useRef(new Animated.Value(full ? 1 : 0)).current;
  const flash = useRef(new Animated.Value(0)).current;
  const slide = useRef(new Animated.Value(0)).current;

  // Lock full floods persimmon; it recedes if the lock drops. Reduce Motion: an instant change.
  useEffect(() => {
    if (reduceMotion) flood.setValue(full ? 1 : 0);
    else
      Animated.timing(flood, {
        toValue: full ? 1 : 0,
        duration: full ? motion.takeover : motion.base,
        easing: full ? ease.out : ease.in,
        useNativeDriver: true,
      }).start();
  }, [full, reduceMotion, flood]);

  // Strike landed: a short flash, and the new target's name slides in.
  useEffect(() => {
    if (m.landedAtMs === null || reduceMotion) return;
    flash.setValue(0.85);
    slide.setValue(1);
    Animated.parallel([
      Animated.timing(flash, { toValue: 0, duration: motion.slow, easing: ease.out, useNativeDriver: true }),
      Animated.timing(slide, { toValue: 0, duration: motion.slow, easing: ease.out, useNativeDriver: true }),
    ]).start();
  }, [m.landedAtMs, reduceMotion, flash, slide]);

  if (m.blocked) return <BlockedView what={m.blocked} onOpenSettings={actions.onOpenSettings} />;
  if (m.tagged)
    return (
      <TaggedView
        head={m.head}
        taggedBy={m.taggedBy}
        onResults={actions.onResults}
        reduceMotion={reduceMotion}
      />
    );

  const tone: Tone = full ? "persimmon" : "paper";
  return (
    <ToneProvider tone={tone}>
      <View
        style={[styles.fill, { backgroundColor: color.paper }]}
        onLayout={(e) => setHeight(e.nativeEvent.layout.height)}
      >
        <Animated.View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { backgroundColor: color.persimmon, opacity: flood }]}
        />
        <View
          style={[
            styles.fill,
            { paddingTop: inset.top + space.s, paddingBottom: Math.max(inset.bottom, space.m) },
          ]}
        >
          <View style={styles.top}>
            <View style={styles.grow}>
              <Eyebrow muted>Target</Eyebrow>
              <Animated.View
                style={{
                  transform: [
                    { translateX: slide.interpolate({ inputRange: [0, 1], outputRange: [0, 48] }) },
                  ],
                  opacity: slide.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
                }}
              >
                <Strong lines={1}>{handleOf(m.target)}</Strong>
              </Animated.View>
            </View>
            <View style={styles.right} accessible accessibilityLabel={m.timeLeft}>
              <Figure>{m.timeLeft}</Figure>
            </View>
          </View>

          <View style={styles.overlays}>
            <WarningBanner banner={m.banner} reduceMotion={reduceMotion} />
            <DispatchStrip dispatch={m.dispatch} log={m.log} nowMs={nowMs} reduceMotion={reduceMotion} />
          </View>

          <View style={styles.readouts}>
            <LockArc
              value={m.lock}
              max={m.max}
              frozenFor={m.frozenFor}
              size={arc}
              reduceMotion={reduceMotion}
            />
            <View style={styles.headRow}>
              <HeadValue value={m.head} landedAtMs={m.landedAtMs} reduceMotion={reduceMotion} />
              {m.tags > 0 ? (
                <View
                  style={styles.right}
                  accessible
                  accessibilityLabel={`${m.tags} ${m.tags === 1 ? "tag" : "tags"}`}
                >
                  <Eyebrow muted>Tags</Eyebrow>
                  <Figure>{m.tags}</Figure>
                </View>
              ) : null}
            </View>
            <HeatBar value={m.heat} max={m.max} reduceMotion={reduceMotion} />
          </View>

          <View style={styles.lower}>
            {full && m.strikeSent ? (
              <StrikeSent reduceMotion={reduceMotion} />
            ) : full ? (
              <Breathe reduceMotion={reduceMotion} style={styles.strike}>
                <Button
                  kind="strike"
                  icon="strike"
                  title="Strike"
                  hint="Tags your target while you are still in range"
                  onPress={actions.onStrike}
                  style={styles.strike}
                />
              </Breathe>
            ) : (
              <MapPanel me={m.me} zone={m.zone} leak={m.leak} />
            )}
          </View>

          <View style={styles.bottom}>
            <Button
              kind="secondary"
              icon="handler"
              title="Handler"
              onPress={() => setSheet(true)}
              style={styles.handler}
            />
            <Caption muted lines={2} style={styles.status}>
              {m.waiting ? "Waiting for the referee" : m.status}
            </Caption>
          </View>
        </View>
        <Animated.View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { backgroundColor: color.persimmon, opacity: flash }]}
        />
        <HintSheet
          open={sheet}
          hints={m.hints}
          reduceMotion={reduceMotion}
          onClose={() => setSheet(false)}
          onSend={(kind, q) => {
            actions.onHint(kind, q);
            setSheet(false);
          }}
        />
      </View>
    </ToneProvider>
  );
}

/** STRIKE is out: the ink plate lands where the button was; the result follows on a tick. */
function StrikeSent({ reduceMotion }: { reduceMotion: boolean }) {
  const t = useArrive("sent", reduceMotion, { ms: motion.base });
  return (
    <Animated.View
      style={[
        styles.strike,
        styles.sent,
        { opacity: t, transform: [{ scale: t.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) }] },
      ]}
      accessible
      accessibilityRole="text"
      accessibilityLabel="Strike sent. The result comes with the next referee update."
    >
      <Ripple size={88} reduceMotion={reduceMotion} ms={1_600}>
        <Icon name="strike" size={36} tint={color.persimmon} />
      </Ripple>
      <Text maxFontSizeMultiplier={maxScale.number} style={styles.sentText}>
        Strike sent
      </Text>
      <Caption style={{ color: color.sand }}>Result on the next tick</Caption>
    </Animated.View>
  );
}

/**
 * Tagged: the screen drops to ink and names who got you, from the referee's HUD. The strike
 * mark lands hard (big to size), then the words settle in under it.
 */
export function TaggedView({
  head,
  taggedBy,
  onResults,
  reduceMotion = false,
}: {
  head: string;
  taggedBy: string | null;
  onResults: () => void;
  reduceMotion?: boolean;
}) {
  const t = taggedLines(taggedBy, head);
  const hit = useArrive(t.title, reduceMotion, { ms: motion.takeover });
  const words = useArrive(t.title, reduceMotion, { ms: motion.slow, delay: motion.base });
  return (
    <Screen tone="ink" scroll={false} footer={<Button title="See results" onPress={onResults} />}>
      <View style={styles.center}>
        <Animated.View
          style={{
            opacity: hit,
            transform: [{ scale: hit.interpolate({ inputRange: [0, 1], outputRange: [2.2, 1] }) }],
          }}
        >
          <Icon name="strike" size={72} tint={color.paper} />
        </Animated.View>
        <Animated.View style={[styles.words, rise(words, 14)]}>
          <Display center>{t.title}</Display>
          <Body center>{t.line}</Body>
          {t.more ? (
            <Caption center muted>
              {t.more}
            </Caption>
          ) : null}
        </Animated.View>
      </View>
    </Screen>
  );
}

/** Bluetooth or location is off or denied: the hunt cannot work, so say so in one line. */
export function BlockedView({
  what,
  onOpenSettings,
}: {
  what: "bluetooth" | "location";
  onOpenSettings: () => void;
}) {
  return (
    <Screen scroll={false} footer={<Button title="Open Settings" onPress={onOpenSettings} />}>
      <View style={styles.center}>
        <Icon name="dark" size={48} tint={color.ink} />
        <Display center>{what === "bluetooth" ? "Bluetooth is off" : "Location is off"}</Display>
        <Body center muted>
          {what === "bluetooth"
            ? "TAIL finds players over Bluetooth. Turn it on for TAIL in Settings."
            : "TAIL needs your location while you play. Allow it in Settings."}
        </Body>
      </View>
    </Screen>
  );
}

/** The live hunt: the session's snapshot as a HuntModel, plus the haptic vocabulary. */
export function Hunt() {
  const app = useApp();
  const reduceMotion = useReduceMotion();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  const session = app.session;
  const b = app.briefing;
  const m =
    session && b
      ? huntModel(
          session.snapshot(),
          { keys: b.keys, stake: app.match?.chain?.stake ?? 0n, zone: app.zone },
          now,
        )
      : null;

  // Heat is felt in the pocket: a beat whose cadence follows heat.
  const heat = m?.heat ?? 0;
  useEffect(() => {
    const every = heatIntervalMs(heat);
    if (every === null) return;
    const t = setInterval(() => haptic.heatTick(heat), every);
    return () => clearInterval(t);
  }, [heat]);
  useTransition(m?.canStrike ?? false, haptic.lockFull);
  useTransition(m?.tagged ?? false, haptic.tagged);
  useTransition(m?.dispatch?.atMs ?? null, haptic.dispatch);

  if (!session || !m) return null;
  return (
    <HuntView
      m={m}
      nowMs={now}
      reduceMotion={reduceMotion}
      actions={{
        onStrike: () => {
          haptic.strikeSent();
          session.strike();
        },
        onHint: (kind, q) => session.hint(kind, q),
        onOpenSettings: () => void Linking.openSettings(),
        onResults: () => app.showResults(),
      }}
    />
  );
}

/** Fires once each time `value` changes to something truthy (not on first render). */
function useTransition<T>(value: T, fire: () => void) {
  const prev = useRef(value);
  useEffect(() => {
    if (value && value !== prev.current) fire();
    prev.current = value;
  }, [value, fire]);
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  grow: { flex: 1 },
  top: { flexDirection: "row", alignItems: "flex-start", gap: space.l, paddingHorizontal: space.xl },
  right: { alignItems: "flex-end" },
  // Banners and dispatches arrive between the top strip and the readouts; the map gives way.
  overlays: { paddingHorizontal: space.l, gap: space.s, paddingTop: space.s },
  sent: {
    backgroundColor: color.ink,
    borderRadius: radius.l,
    alignItems: "center",
    justifyContent: "center",
    gap: space.s,
  },
  sentText: {
    fontFamily: font.black,
    fontSize: 30,
    letterSpacing: 2,
    textTransform: "uppercase",
    color: color.persimmon,
  },
  readouts: { alignItems: "center", paddingHorizontal: space.xl, gap: space.s, paddingTop: space.s },
  headRow: {
    alignSelf: "stretch",
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
  },
  lower: { flex: 1, paddingHorizontal: space.l, paddingTop: space.l },
  strike: { flex: 1 },
  bottom: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.m,
    paddingHorizontal: space.l,
    paddingTop: space.m,
  },
  handler: { paddingHorizontal: space.l },
  status: { flex: 1, textAlign: "right" },
  words: { gap: space.m, alignItems: "center" },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: space.m,
    paddingHorizontal: space.l,
  },
});
