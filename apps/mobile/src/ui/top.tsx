// What arrives at the top of the hunt screen: warnings (dark, out of zone) as ink banners, and
// the Handler's lines as radio dispatches that drop in, buzz, and gather in a short log you can
// pull open. Only the Handler speaks with personality; banners state facts and countdowns.

import { type ReactNode, useEffect, useRef, useState } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import type { Note } from "../tail/hunt";
import type { Banner, Dispatch } from "../tail/huntModel";
import { Icon } from "./brand";
import { Caption, Eyebrow, Strong } from "./kit";
import { ease } from "./motion";
import { color, maxScale, motion, radius, space, text } from "./theme";

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
  useEffect(() => {
    if (reduceMotion) {
      y.setValue(show ? 0 : -1);
      return;
    }
    Animated.timing(y, {
      toValue: show ? 0 : -1,
      duration: show ? motion.base : motion.fast,
      easing: show ? ease.out : ease.in,
      useNativeDriver: true,
    }).start();
  }, [show, reduceMotion, y]);
  if (!show && reduceMotion) return null;
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
          <Icon name={b.kind === "dark" ? "dark" : "zone"} size={22} tint={color.paper} />
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

/** How long a fresh dispatch stays up front before folding into the log. */
export const DISPATCH_MS = 9_000;

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
  const fresh = !!dispatch && nowMs - dispatch.atMs < DISPATCH_MS;
  const entries = log.slice(0, 6);
  if (!fresh && !open && entries.length === 0) return null;
  return (
    <View style={styles.dispatchWrap}>
      <Slide show={fresh || open} reduceMotion={reduceMotion}>
        <Pressable
          onPress={() => setOpen((o) => !o)}
          accessibilityRole="button"
          accessibilityLabel={dispatch ? `Handler: ${dispatch.text}` : "Handler log"}
          accessibilityHint={open ? "Closes the log" : "Opens the log"}
          style={styles.dispatch}
        >
          <View style={styles.dispatchHead}>
            <Icon name="handler" size={18} tint={color.ink} />
            <Eyebrow>Handler</Eyebrow>
          </View>
          {open ? (
            entries.map((n) => (
              <View key={`${n.tMs}-${n.text}`} style={styles.logRow}>
                {n.kind === "handler" ? <Strong>{n.text}</Strong> : <Caption muted>{n.text}</Caption>}
              </View>
            ))
          ) : dispatch ? (
            <Strong lines={3}>{dispatch.text}</Strong>
          ) : null}
        </Pressable>
      </Slide>
      {!fresh && !open && entries.length > 0 ? (
        <Pressable
          onPress={() => setOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={`Handler log, ${entries.length} ${entries.length === 1 ? "entry" : "entries"}`}
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
  logRow: { paddingVertical: 2 },
  logTab: { alignSelf: "center", height: 24, width: 88, alignItems: "center", justifyContent: "center" },
  tabBar: { width: 40, height: 5, borderRadius: 3, backgroundColor: color.mute },
});
