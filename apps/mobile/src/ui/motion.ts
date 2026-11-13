// Motion primitives. Responsive and weighted, exponential ease-out only (no bounce). Reduce
// Motion turns every one of them into an instant change or a still frame; haptics remain.
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing } from "react-native";
import { motion } from "./theme";

/** Exponential ease-out for entrances, ease-in for exits. No bounce anywhere. */
export const ease = { out: Easing.bezier(...motion.out), in: Easing.bezier(...motion.in) };

export function useReduceMotion(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      if (live) setOn(v);
    });
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setOn);
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  return on;
}

/**
 * A value running 0 → 1 forever at constant speed, for ambient scenes (the chase, a pulse).
 * Still at `still` with Reduce Motion. Native driver only: drive transforms and opacity.
 */
export function useLoop(ms: number, reduceMotion: boolean, still = 0.3): Animated.Value {
  const v = useRef(new Animated.Value(still)).current;
  useEffect(() => {
    if (reduceMotion) {
      v.setValue(still);
      return;
    }
    v.setValue(0);
    const a = Animated.loop(
      Animated.timing(v, { toValue: 1, duration: ms, easing: Easing.linear, useNativeDriver: true }),
    );
    a.start();
    return () => a.stop();
  }, [ms, reduceMotion, still, v]);
  return v;
}

/**
 * 0 → 1 once when `key` changes (and on mount), for a state arriving: a screen, a player
 * joining, a result. Instant with Reduce Motion. `native: false` for SVG props, which the
 * native driver cannot animate.
 */
export function useArrive(
  key: unknown,
  reduceMotion: boolean,
  { ms = motion.base, delay = 0, native = true }: { ms?: number; delay?: number; native?: boolean } = {},
) {
  const v = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the trigger, not a value read
  useEffect(() => {
    if (reduceMotion) {
      v.setValue(1);
      return;
    }
    v.setValue(0);
    const a = Animated.timing(v, {
      toValue: 1,
      duration: ms,
      delay,
      easing: ease.out,
      useNativeDriver: native,
    });
    a.start();
    return () => a.stop();
  }, [key, reduceMotion, ms, delay, native, v]);
  return v;
}

/** Fade in and rise `dy` points as `t` goes 0 → 1. */
export const rise = (t: Animated.Value, dy = 12) => ({
  opacity: t,
  transform: [{ translateY: t.interpolate({ inputRange: [0, 1], outputRange: [dy, 0] }) }],
});

/**
 * A number that rolls to `to` (results, head jumps), JS-driven at frame rate for `ms`. Lands
 * on the exact value; with Reduce Motion it is the exact value from the start.
 */
export function useCountUp(to: number, reduceMotion: boolean, ms = 900, from = 0): number {
  const [n, setN] = useState(reduceMotion ? to : from);
  useEffect(() => {
    if (reduceMotion) {
      setN(to);
      return;
    }
    const start = Date.now();
    let raf = 0;
    const step = () => {
      const p = Math.min(1, (Date.now() - start) / ms);
      // ease-out-expo, matching motion.out
      const e = p === 1 ? 1 : 1 - 2 ** (-10 * p);
      setN(from + (to - from) * e);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [to, from, ms, reduceMotion]);
  return n;
}
