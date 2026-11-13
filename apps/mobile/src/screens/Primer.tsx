// Three cards, once, skippable (docs/briefs/mobile.md 5): the whole game in three sentences.
// Each card shows the real hunt readout it explains (the lock arc, the heat bar, STRIKE on the
// persimmon takeover), playing through its states, so the first hunt looks familiar. Swipe or
// tap Next.
import { useEffect, useRef, useState } from "react";
import { Animated, type ScrollViewInstance, StyleSheet, View } from "react-native";
import { useApp } from "../state/app";
import { HeatBar, LockArc } from "../ui/game";
import { haptic } from "../ui/haptics";
import { Body, Button, Caption, Display, Row, Screen, ToneProvider } from "../ui/kit";
import { useReduceMotion } from "../ui/motion";
import { Breathe } from "../ui/scene";
import { color, radius, space } from "../ui/theme";

type Demo = "lock" | "heat" | "strike";
const CARDS: { demo: Demo; title: string; line: string }[] = [
  { demo: "lock", title: "Lock", line: "Stay within Bluetooth range of your target and your lock fills." },
  { demo: "heat", title: "Heat", line: "When someone is on you, your heat fills. You never learn who." },
  {
    demo: "strike",
    title: "Strike",
    line: "Full lock, press Strike while still close: their head is yours.",
  },
];

/** The demo's frames: a lock or heat climbing to full, holding, then starting over. */
const CLIMB = [0, 1, 2, 3, 4, 4, 4];
const STEP_MS = 650;

function useClimb(active: boolean, reduceMotion: boolean, still: number): number {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!active || reduceMotion) return;
    setI(0);
    const t = setInterval(() => setI((n) => (n + 1) % CLIMB.length), STEP_MS);
    return () => clearInterval(t);
  }, [active, reduceMotion]);
  return reduceMotion || !active ? still : (CLIMB[i] ?? 0);
}

function DemoView({ demo, active, reduceMotion }: { demo: Demo; active: boolean; reduceMotion: boolean }) {
  const n = useClimb(active && demo !== "strike", reduceMotion, demo === "lock" ? 3 : 2);
  if (demo === "lock")
    return <LockArc value={n} max={4} frozenFor={null} size={200} reduceMotion={reduceMotion} />;
  if (demo === "heat")
    return (
      <View style={styles.heatDemo}>
        <HeatBar value={n} max={4} reduceMotion={reduceMotion} />
      </View>
    );
  return (
    <ToneProvider tone="persimmon">
      <View style={styles.strikeDemo}>
        <Breathe reduceMotion={reduceMotion || !active} amount={0.04} style={styles.grow}>
          <Button
            kind="strike"
            icon="strike"
            title="Strike"
            onPress={haptic.strikeSent}
            style={styles.grow}
          />
        </Breathe>
      </View>
    </ToneProvider>
  );
}

export function PrimerView({ step: initial = 0, onDone }: { step?: number; onDone: () => void }) {
  const reduceMotion = useReduceMotion();
  const [step, setStep] = useState(initial);
  const [width, setWidth] = useState(0);
  const pager = useRef<ScrollViewInstance>(null);
  const x = useRef(new Animated.Value(0)).current;
  const last = step === CARDS.length - 1;
  const go = (i: number) => {
    setStep(i);
    pager.current?.scrollTo({ x: i * width, animated: !reduceMotion });
  };
  return (
    <Screen
      scroll={false}
      footer={
        <Row gap="m" style={styles.footer}>
          <Button kind="quiet" title="Skip" onPress={onDone} />
          <Button
            title={last ? "Play" : "Next"}
            onPress={() => (last ? onDone() : go(step + 1))}
            style={styles.grow}
          />
        </Row>
      }
    >
      <View
        style={styles.grow}
        onLayout={(e) => {
          const w = e.nativeEvent.layout.width;
          // The pager opens on `initial`; the dots follow its offset from the first frame.
          if (!width) x.setValue(initial * w);
          setWidth(w);
        }}
      >
        {width ? (
          <Animated.ScrollView
            ref={pager}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            contentOffset={{ x: initial * width, y: 0 }}
            scrollEventThrottle={16}
            // The pager's offset drives the dots on the native thread.
            onScroll={Animated.event([{ nativeEvent: { contentOffset: { x } } }], { useNativeDriver: true })}
            onMomentumScrollEnd={(e) => {
              const i = Math.round(e.nativeEvent.contentOffset.x / width);
              if (i !== step) haptic.select();
              setStep(i);
            }}
            style={styles.grow}
          >
            {CARDS.map((c, i) => (
              <View
                key={c.title}
                style={[styles.card, { width }]}
                accessible
                accessibilityLabel={`${c.title}. ${c.line} Card ${i + 1} of ${CARDS.length}`}
              >
                <View style={styles.stage}>
                  <DemoView demo={c.demo} active={i === step} reduceMotion={reduceMotion} />
                </View>
                <Display>{c.title}</Display>
                <Body>{c.line}</Body>
              </View>
            ))}
          </Animated.ScrollView>
        ) : null}
      </View>
      <View style={styles.dots}>
        {CARDS.map((c, i) => (
          <Animated.View
            key={c.title}
            style={[
              styles.dot,
              {
                opacity: width
                  ? x.interpolate({
                      inputRange: [(i - 1) * width, i * width, (i + 1) * width],
                      outputRange: [0.25, 1, 0.25],
                      extrapolate: "clamp",
                    })
                  : i === step
                    ? 1
                    : 0.25,
              },
            ]}
          />
        ))}
        <Caption muted>{`${step + 1} of ${CARDS.length}`}</Caption>
      </View>
    </Screen>
  );
}

export function Primer() {
  const app = useApp();
  return <PrimerView onDone={() => app.finishPrimer()} />;
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  card: { flex: 1, justifyContent: "flex-end", gap: space.l, paddingBottom: space.xl },
  stage: { flex: 1, alignItems: "center", justifyContent: "center" },
  heatDemo: { alignSelf: "stretch" },
  strikeDemo: {
    alignSelf: "stretch",
    height: 200,
    padding: space.l,
    borderRadius: radius.l,
    backgroundColor: color.persimmon,
  },
  dots: { flexDirection: "row", alignItems: "center", gap: space.s },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.ink },
  footer: { justifyContent: "space-between", flexWrap: "nowrap" },
});
