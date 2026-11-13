// The Chase: TAIL's ambient brand scene. The Trail mark set moving: you, a persimmon dot with
// its trail fading behind, tailing your target (ink) around a loop inside a dotted zone, the
// rest of the field drifting the other way. Once a lap the gap closes and a ring lands: a tag.
// It is the game in one glance, used where a screen would otherwise sit empty (first run,
// home, waiting). Decorative: hidden from VoiceOver, still with Reduce Motion.
//
// Everything runs on the native driver from one looping value: each dot's position is an
// interpolation over sampled points of the track, so the JS thread does no per-frame work.

import { type ChaseTrack, chase, chaseGap, chasePoint } from "@tail/brand";
import { type ReactNode, useMemo, useState } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import Svg, { Ellipse } from "react-native-svg";
import { useLoop } from "./motion";
import { color, font } from "./theme";

type Pt = { x: number; y: number };

const SAMPLES = 72;

const wrap = (u: number) => ((u % 1) + 1) % 1;
const INPUT = Array.from({ length: SAMPLES + 1 }, (_, i) => i / SAMPLES);

/** translateX/translateY that put a dot of `size` at `phase(u)` as the loop runs. */
function along(v: Animated.Value, pts: (u: number) => Pt, size: number) {
  const xs = INPUT.map((u) => pts(u).x - size / 2);
  const ys = INPUT.map((u) => pts(u).y - size / 2);
  return [
    { translateX: v.interpolate({ inputRange: INPUT, outputRange: xs }) },
    { translateY: v.interpolate({ inputRange: INPUT, outputRange: ys }) },
  ];
}

function Runner({
  v,
  at,
  size,
  tint,
  trail,
  headOpacity = 1,
  children,
}: {
  v: Animated.Value;
  at: (u: number) => Pt;
  size: number;
  tint: string;
  /** Phase step between trail dots; 0 for no trail. */
  trail: number;
  headOpacity?: number;
  children?: ReactNode;
}) {
  const TRAIL = trail ? 7 : 0;
  return (
    <>
      {Array.from({ length: TRAIL }, (_, k) => {
        const i = TRAIL - k; // draw the far end first so the head sits on top
        const s = size * (0.85 - (i / TRAIL) * 0.55);
        const lag = i * trail;
        return (
          <Animated.View
            key={i}
            style={[
              styles.dot,
              {
                width: s,
                height: s,
                borderRadius: s / 2,
                backgroundColor: tint,
                opacity: 0.38 * (1 - i / (TRAIL + 1)),
                transform: along(v, (u) => at(u - lag), s),
              },
            ]}
          />
        );
      })}
      <Animated.View
        style={[
          styles.dot,
          styles.head,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: tint,
            opacity: headOpacity,
            transform: along(v, at, size),
          },
        ]}
      >
        {children}
      </Animated.View>
    </>
  );
}

export function ChaseScene({
  width,
  height,
  reduceMotion,
  track = "eight",
  crowd = 3,
  zone = true,
  target,
}: {
  width: number;
  height: number;
  reduceMotion: boolean;
  track?: ChaseTrack;
  /** Other players drifting on an inner loop. */
  crowd?: number;
  zone?: boolean;
  /** The target's initials, drawn in their dot (briefing). */
  target?: string;
}) {
  // Still frame: the hunter just behind the target, approaching the crossing.
  const v = useLoop(chase.lapMs, reduceMotion, 0.42);
  const pt = useMemo(
    () => ({
      target: (u: number) => chasePoint(track, wrap(u), width, height),
      hunter: (u: number) => chasePoint(track, wrap(u - chaseGap(wrap(u))), width, height),
      // The crowd walks a smaller copy of the track the other way round.
      crowd: (k: number) => (u: number) => {
        const p = chasePoint(
          track === "eight" ? "loop" : "eight",
          wrap(-u + k / crowd + 0.13),
          width,
          height,
        );
        return { x: width / 2 + (p.x - width / 2) * 0.62, y: height / 2 + (p.y - height / 2) * 0.62 };
      },
    }),
    [track, width, height, crowd],
  );
  const tagPt = pt.target(chase.tagAt);
  const big = target ? 30 : 14;
  const ring = 18;
  const near = {
    inputRange: [0, chase.tagAt - 0.01, chase.tagAt, chase.tagAt + 0.09, 1],
    extrapolate: "clamp" as const,
  };
  return (
    <View
      style={{ width, height }}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {zone ? (
        <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
          <Ellipse
            cx={width / 2}
            cy={height / 2}
            rx={width / 2 - 3}
            ry={height / 2 - 3}
            stroke={color.ink}
            strokeOpacity={0.4}
            strokeWidth={2}
            strokeDasharray="0.1 7"
            strokeLinecap="round"
            fill="none"
          />
        </Svg>
      ) : null}
      {Array.from({ length: crowd }, (_, k) => (
        <Runner
          // biome-ignore lint/suspicious/noArrayIndexKey: the crowd is positional and fixed
          key={k}
          v={v}
          at={pt.crowd(k)}
          size={11}
          tint={color.ink}
          trail={0}
          headOpacity={0.22}
        />
      ))}
      <Runner v={v} at={pt.target} size={big} tint={color.ink} trail={0.012}>
        {target ? (
          <Text allowFontScaling={false} style={styles.initials}>
            {target}
          </Text>
        ) : null}
      </Runner>
      {/* The tag: a ring lands where the hunter catches up. */}
      <Animated.View
        style={[
          styles.dot,
          styles.ring,
          {
            width: ring,
            height: ring,
            borderRadius: ring / 2,
            opacity: v.interpolate({ ...near, outputRange: [0, 0, 0.9, 0, 0] }),
            transform: [
              { translateX: tagPt.x - ring / 2 },
              { translateY: tagPt.y - ring / 2 },
              { scale: v.interpolate({ ...near, outputRange: [1, 1, 1, 3.4, 3.4] }) },
            ],
          },
        ]}
      />
      <Runner v={v} at={pt.hunter} size={18} tint={color.persimmon} trail={0.014} />
    </View>
  );
}

/** The chase at the full width of its container (measured, so it fits any frame). */
export function ChaseBand({
  height,
  ...rest
}: { height: number } & Omit<Parameters<typeof ChaseScene>[0], "width" | "height">) {
  const [width, setWidth] = useState(0);
  return (
    <View style={{ height, alignSelf: "stretch" }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {width ? <ChaseScene width={width} height={height} {...rest} /> : null}
    </View>
  );
}

/**
 * Find My's "looking" rings: soft circles widening from a centre. Around the loading mark, the
 * lobby's open seats, the briefing while orders come in. Still with Reduce Motion.
 */
export function Ripple({
  size,
  tint = color.persimmon,
  reduceMotion,
  rings = 2,
  ms = 2_400,
  children,
}: {
  size: number;
  tint?: string;
  reduceMotion: boolean;
  rings?: number;
  ms?: number;
  children?: ReactNode;
}) {
  const v = useLoop(ms, reduceMotion, 0);
  return (
    <View style={[styles.center, { width: size, height: size }]}>
      {reduceMotion
        ? null
        : Array.from({ length: rings }, (_, k) => {
            const p = Animated.modulo(Animated.add(v, k / rings), 1);
            return (
              <Animated.View
                // biome-ignore lint/suspicious/noArrayIndexKey: rings are positional and fixed
                key={k}
                pointerEvents="none"
                style={[
                  StyleSheet.absoluteFill,
                  {
                    borderRadius: size / 2,
                    borderWidth: 2,
                    borderColor: tint,
                    opacity: p.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 0.55, 0] }),
                    transform: [{ scale: p.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }) }],
                  },
                ]}
              />
            );
          })}
      {children}
    </View>
  );
}

/** A slow breath (scale), for the one thing on screen that wants your thumb: STRIKE. */
export function Breathe({
  reduceMotion,
  amount = 0.025,
  children,
  style,
}: {
  reduceMotion: boolean;
  amount?: number;
  children: ReactNode;
  style?: object;
}) {
  const v = useLoop(1_400, reduceMotion, 0);
  const scale = v.interpolate({
    inputRange: [0, 0.25, 0.5, 0.75, 1],
    outputRange: [1, 1 + amount * 0.7, 1 + amount, 1 + amount * 0.7, 1],
  });
  return <Animated.View style={[style, { transform: [{ scale }] }]}>{children}</Animated.View>;
}

const styles = StyleSheet.create({
  dot: { position: "absolute", left: 0, top: 0 },
  head: { alignItems: "center", justifyContent: "center" },
  ring: { borderWidth: 2, borderColor: color.persimmon },
  center: { alignItems: "center", justifyContent: "center" },
  initials: { fontFamily: font.bold, fontSize: 12, color: color.paper, letterSpacing: 0.3 },
});
