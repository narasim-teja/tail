// The hunt's readouts. Lock and heat never rely on colour (DESIGN.md, Never-Alone): lock is an
// arc around a giant numeral, heat is a straight bar with its own numeral, filled segments are
// solid and empty ones outlined, and each carries its label and icon.

import { useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { money } from "../tail/huntModel";
import { Icon } from "./brand";
import { heatIntervalMs } from "./cadence";
import { Eyebrow, inkOn, Num, useTone } from "./kit";
import { ease, rise, useArrive, useCountUp, useLoop } from "./motion";

const AnimatedPath = Animated.createAnimatedComponent(Path);

import { color, maxScale, motion, space, text } from "./theme";

/** SVG path of an annular sector between two angles (degrees, 0 = north, clockwise). */
export function sectorPath(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const p = (r: number, a: number) => {
    const t = ((a - 90) * Math.PI) / 180;
    return `${(cx + r * Math.cos(t)).toFixed(2)} ${(cy + r * Math.sin(t)).toFixed(2)}`;
  };
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${p(r1, a0)} A ${r1} ${r1} 0 ${large} 1 ${p(r1, a1)} L ${p(r0, a1)} A ${r0} ${r0} 0 ${large} 0 ${p(r0, a0)} Z`;
}

const ARC_START = -135;
const ARC_SWEEP = 270;
const GAP = 7;

/** LOCK: your grip on your target. A segmented 270° arc around the numeral. */
export function LockArc({
  value,
  max,
  frozenFor,
  size = 232,
  reduceMotion = false,
}: {
  value: number;
  max: number;
  frozenFor: string | null;
  size?: number;
  reduceMotion?: boolean;
}) {
  const tone = useTone();
  // The segment just gained flashes in from the ground colour, and the numeral steps up into
  // place: a lock tick you can see from the corner of an eye. Losing grip is instant.
  const gained = useRef({ value, at: 0 });
  if (value > gained.current.value) gained.current = { value, at: gained.current.at + 1 };
  else gained.current.value = value;
  const fresh = useArrive(gained.current.at, reduceMotion || gained.current.at === 0, {
    ms: motion.slow,
    native: false,
  });
  const tick = useArrive(value, reduceMotion);
  // On the persimmon takeover the filled segments turn ink, so they never vanish into the ground.
  const fill = tone === "persimmon" ? color.ink : color.persimmon;
  const line = inkOn(tone);
  const c = size / 2;
  const seg = (ARC_SWEEP - GAP * (max - 1)) / max;
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`Lock ${value} of ${max}${frozenFor ? `, frozen for ${frozenFor}` : ""}`}
      accessibilityValue={{ min: 0, max, now: value }}
      style={{ width: size, height: size * 0.86, alignItems: "center" }}
    >
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        {Array.from({ length: max }, (_, i) => {
          const a0 = ARC_START + i * (seg + GAP);
          const on = i < value;
          const d = sectorPath(c, c, c - 26, c - 2, a0, a0 + seg);
          if (on && i === value - 1)
            return (
              <AnimatedPath
                // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and never reorder
                key={i}
                d={d}
                fill={fill}
                fillOpacity={fresh.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0.15, frozenFor ? 0.4 : 1],
                })}
              />
            );
          return (
            <Path
              // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and never reorder
              key={i}
              d={d}
              fill={on ? fill : "none"}
              stroke={on ? "none" : line}
              strokeWidth={on ? 0 : 2}
              strokeOpacity={frozenFor ? 0.4 : 1}
              fillOpacity={frozenFor ? 0.4 : 1}
            />
          );
        })}
      </Svg>
      <View style={[styles.arcCenter, { height: size }]}>
        <View style={styles.eyebrowRow}>
          <Icon name="lock" size={16} tint={line} />
          <Eyebrow>Lock</Eyebrow>
        </View>
        <Animated.Text
          maxFontSizeMultiplier={maxScale.hero}
          style={[
            text.hero,
            { color: inkOn(tone), fontSize: size * 0.41, lineHeight: size * 0.43 },
            rise(tick, 10),
          ]}
        >
          {value}
          <Text style={[text.number, styles.of, { color: inkOn(tone) }]}>/{max}</Text>
        </Animated.Text>
        {frozenFor ? <Eyebrow>{`Frozen ${frozenFor}`}</Eyebrow> : null}
      </View>
    </View>
  );
}

/** HEAT: their grip on you. A straight ink bar with its numeral; pulses as it rises. */
export function HeatBar({ value, max, reduceMotion }: { value: number; max: number; reduceMotion: boolean }) {
  const tone = useTone();
  const ink = inkOn(tone);
  const pulse = useRef(new Animated.Value(1)).current;
  const prev = useRef(value);
  // High heat throbs at the same cadence as the haptic beat, so eye and hand agree.
  const hot = value >= max - 1 && value > 0;
  const beat = useLoop(heatIntervalMs(value) ?? 4_000, reduceMotion || !hot, 0);
  const throb = beat.interpolate({ inputRange: [0, 0.12, 0.5, 1], outputRange: [1, 0.55, 1, 1] });
  useEffect(() => {
    if (value > prev.current && !reduceMotion) {
      pulse.setValue(0.35);
      Animated.timing(pulse, {
        toValue: 1,
        duration: motion.slow,
        easing: ease.out,
        useNativeDriver: true,
      }).start();
    }
    prev.current = value;
  }, [value, reduceMotion, pulse]);
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`Heat ${value} of ${max}`}
      accessibilityValue={{ min: 0, max, now: value }}
      style={styles.heat}
    >
      <View style={styles.heatHead}>
        <View style={styles.eyebrowRow}>
          <Icon name="heat" size={16} tint={ink} />
          <Eyebrow>Heat</Eyebrow>
        </View>
        <Text maxFontSizeMultiplier={maxScale.number} style={[text.number, { color: ink }]}>
          {value}
        </Text>
      </View>
      <Animated.View style={[styles.segments, { opacity: Animated.multiply(pulse, throb) }]}>
        {Array.from({ length: max }, (_, i) => (
          <View
            // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and never reorder
            key={i}
            style={[
              styles.segment,
              i < value ? { backgroundColor: ink } : { borderWidth: 2, borderColor: ink },
            ]}
          />
        ))}
      </Animated.View>
    </View>
  );
}

/** HEAD: what you are worth right now. Jumps when a strike lands. */
export function HeadValue({
  value,
  landedAtMs,
  reduceMotion,
}: {
  value: string;
  landedAtMs: number | null;
  reduceMotion: boolean;
}) {
  const tone = useTone();
  const scale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (landedAtMs === null || reduceMotion) return;
    scale.setValue(1.18);
    Animated.timing(scale, {
      toValue: 1,
      duration: motion.slow,
      easing: ease.out,
      useNativeDriver: true,
    }).start();
  }, [landedAtMs, reduceMotion, scale]);
  return (
    <View accessible accessibilityLabel={`Head ${value}`} style={styles.head}>
      <View style={styles.eyebrowRow}>
        <Icon name="head" size={16} tint={inkOn(tone)} />
        <Eyebrow>Head</Eyebrow>
      </View>
      <Animated.Text
        maxFontSizeMultiplier={maxScale.number}
        style={[text.number, { color: inkOn(tone), transform: [{ scale }] }]}
      >
        {value}
      </Animated.Text>
    </View>
  );
}

/**
 * An amount that rolls to its new value (balance after a top-up, final head on results), so a
 * change is seen, not just read. Always lands on the exact amount.
 */
export function RollingMoney({
  units,
  from = 0n,
  reduceMotion,
}: {
  units: bigint;
  from?: bigint;
  reduceMotion: boolean;
}) {
  const n = useCountUp(Number(units), reduceMotion, 900, Number(from));
  return <Num>{money(BigInt(Math.round(n)))}</Num>;
}

const styles = StyleSheet.create({
  arcCenter: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: 0,
  },
  of: { fontSize: 28, letterSpacing: 0 },
  eyebrowRow: { flexDirection: "row", alignItems: "center", gap: space.xs },
  heat: { gap: space.s, alignSelf: "stretch" },
  heatHead: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between" },
  segments: { flexDirection: "row", gap: 6 },
  segment: { flex: 1, height: 22, borderRadius: 6 },
  head: { gap: 2 },
});
