// The hunt's readouts. Lock and heat never rely on colour (DESIGN.md, Never-Alone): lock is an
// arc around a giant numeral, heat is a straight bar with its own numeral, filled segments are
// solid and empty ones outlined, and each carries its label and icon.

import { useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { Icon } from "./brand";
import { Eyebrow, inkOn, useTone } from "./kit";
import { ease } from "./motion";
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
}: {
  value: number;
  max: number;
  frozenFor: string | null;
  size?: number;
}) {
  const tone = useTone();
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
          return (
            <Path
              // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and never reorder
              key={i}
              d={sectorPath(c, c, c - 26, c - 2, a0, a0 + seg)}
              fill={on ? fill : "none"}
              stroke={on ? "none" : line}
              strokeWidth={on ? 0 : 2}
              strokeOpacity={frozenFor ? 0.4 : 1}
            />
          );
        })}
      </Svg>
      <View style={[styles.arcCenter, { height: size }]}>
        <View style={styles.eyebrowRow}>
          <Icon name="lock" size={16} tint={line} />
          <Eyebrow>Lock</Eyebrow>
        </View>
        <Text
          maxFontSizeMultiplier={maxScale.hero}
          style={[text.hero, { color: inkOn(tone), fontSize: size * 0.41, lineHeight: size * 0.43 }]}
        >
          {value}
          <Text style={[text.number, styles.of, { color: inkOn(tone) }]}>/{max}</Text>
        </Text>
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
      <Animated.View style={[styles.segments, { opacity: pulse }]}>
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
