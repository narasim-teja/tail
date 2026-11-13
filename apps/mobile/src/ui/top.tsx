// What arrives at the top of the hunt screen: warnings (dark, out of zone) as ink banners, and
// the Handler's lines as radio dispatches that drop in, buzz, and gather in a short log you can
// pull open. Only the Handler speaks with personality; banners state facts and countdowns.

import { type ReactNode, useEffect, useRef, useState } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import type { Note } from "../tail/hunt";
import { type Banner, type Dispatch, dispatchCard } from "../tail/huntModel";
import { Icon } from "./brand";
import { Caption, Eyebrow, Strong } from "./kit";
import { ease } from "./motion";
import { color, maxScale, motion, radius, space, text } from "./theme";

/**
 * Drops its content in from above and lifts it away. Once it has lifted away the content leaves
 * the layout: kept mounted at opacity 0 it would still take its full height, a blank band in the
 * stack above whatever shows below it (a banner that was up earlier sat as a 75 pt gap over the
 * Handler's dispatch).
 */
function Slide({
  show,
  reduceMotion,
  children,
}: {
  show: boolean;
  reduceMotion: boolean;
  children: ReactNode;
}) {
  const y = useRef(new Animated.Value(show ? 0 : -1)).current;
  const [mounted, setMounted] = useState(show);
  useEffect(() => {
    if (show) setMounted(true);
    if (reduceMotion) {
      y.setValue(show ? 0 : -1);
      if (!show) setMounted(false);
      return;
    }
    Animated.timing(y, {
      toValue: show ? 0 : -1,
      duration: show ? motion.base : motion.fast,
      easing: show ? ease.out : ease.in,
      useNativeDriver: true,
    }).start(({ finished }) => {
      // Interrupted by a new show, it stays.
      if (finished && !show) setMounted(false);
    });
  }, [show, reduceMotion, y]);
  if (!show && !mounted) return null;
  return (
    <Animated.View
      style={{
        opacity: y.interpolate({ inputRange: [-1, 0], outputRange: [0, 1] }),
        transform: [{ translateY: y.interpolate({ inputRange: [-1, 0], outputRange: [-24, 0] }) }],
      }}
    >
      {children}
    </Animated.View>
  );
}

export function WarningBanner({ banner, reduceMotion }: { banner: Banner | null; reduceMotion: boolean }) {
  const last = useRef(banner);
  if (banner) last.current = banner;
  const b = banner ?? last.current;
  return (
    <Slide show={!!banner} reduceMotion={reduceMotion}>
      {b ? (
        <View
          style={styles.banner}
          accessible
          accessibilityRole="alert"
          accessibilityLabel={`${b.title}. ${b.detail}`}
        >
          <Icon
            name={b.kind === "zone" ? "zone" : b.kind === "refused" ? "strike" : "dark"}
            size={22}
            tint={color.paper}
          />
          <View style={styles.grow}>
            <Text maxFontSizeMultiplier={maxScale.text} style={[text.bodyStrong, { color: color.paper }]}>
              {b.title}
            </Text>
            <Text maxFontSizeMultiplier={maxScale.text} style={[text.caption, { color: color.sand }]}>
              {b.detail}
            </Text>
          </View>
        </View>
      ) : null}
    </Slide>
  );
}

export function DispatchStrip({
  dispatch,
  log,
  nowMs,
  reduceMotion,
}: {
  dispatch: Dispatch | null;
  log: Note[];
  nowMs: number;
  reduceMotion: boolean;
}) {
  const [open, setOpen] = useState(false);
  const card = dispatchCard(dispatch, log, nowMs, open);
  // Kept while it lifts away, so the words don't vanish before the card does.
  const last = useRef(card);
  if (card.show) last.current = card;
  const shown = card.show ? card : last.current;
  if (!card.show && card.tab === null) return null;
  return (
    <View style={styles.dispatchWrap}>
      <Slide show={card.show} reduceMotion={reduceMotion}>
        <Pressable
          onPress={() => setOpen((o) => !o)}
          accessibilityRole="button"
          accessibilityLabel={
            shown.head === "Log"
              ? `Hunt log: ${shown.rows.map((r) => r.text).join(". ")}`
              : `Handler: ${shown.rows[0]?.text ?? ""}`
          }
          accessibilityHint={open ? "Closes the log" : "Opens the log"}
          style={styles.dispatch}
        >
          <View style={styles.dispatchHead}>
            {shown.head === "Handler" ? <Icon name="handler" size={18} tint={color.ink} /> : null}
            <Eyebrow muted={shown.head === "Log"}>{shown.head}</Eyebrow>
          </View>
          {shown.head === "Handler"
            ? shown.rows.map((r) => (
                <Strong key={r.key} lines={3}>
                  {r.text}
                </Strong>
              ))
            : shown.rows.map((r) => (
                <View key={r.key} style={styles.logRow}>
                  {/* The Handler's lines carry its mark; a notice keeps the slot empty, aligned. */}
                  <View style={styles.logMark}>
                    {r.voice === "handler" ? <Icon name="handler" size={16} tint={color.ink} /> : null}
                  </View>
                  <View style={styles.logText}>
                    {r.voice === "handler" ? <Strong>{r.text}</Strong> : <Caption muted>{r.text}</Caption>}
                  </View>
                </View>
              ))}
        </Pressable>
      </Slide>
      {card.tab !== null ? (
        <Pressable
          onPress={() => setOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={`Hunt log, ${card.tab} ${card.tab === 1 ? "entry" : "entries"}`}
          style={styles.logTab}
          hitSlop={12}
        >
          <View style={styles.tabBar} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1, gap: 2 },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.m,
    backgroundColor: color.ink,
    borderRadius: radius.m,
    paddingHorizontal: space.l,
    paddingVertical: space.m,
  },
  dispatchWrap: { alignItems: "stretch" },
  // The one lifted surface (DESIGN.md 4): it arrives over the game, like a voice in your ear.
  dispatch: {
    backgroundColor: color.paper,
    borderRadius: radius.m,
    paddingHorizontal: space.l,
    paddingVertical: space.m,
    gap: space.xs,
    shadowColor: color.ink,
    shadowOpacity: 0.16,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
  },
  dispatchHead: { flexDirection: "row", alignItems: "center", gap: space.xs },
  logRow: { flexDirection: "row", alignItems: "flex-start", gap: space.xs, paddingVertical: 2 },
  logMark: { width: 16, paddingTop: 4 },
  logText: { flex: 1 },
  logTab: { alignSelf: "center", height: 24, width: 88, alignItems: "center", justifyContent: "center" },
  tabBar: { width: 40, height: 5, borderRadius: 3, backgroundColor: color.mute },
});
