// The hint sheet: rises from the bottom over the hunt, never a dialog. Three hints (icon, name,
// what it tells you, price), an optional question for the Handler, Send. The price leaves your
// head and lands on your target's.

import { HINT_TEXT_MAX, HintKind } from "@tail/protocol";
import { useEffect, useRef, useState } from "react";
import { Animated, KeyboardAvoidingView, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { HintOption } from "../game/huntModel";
import { Icon } from "./brand";
import { Body, Button, Caption, Field, Figure, Strong, Title } from "./kit";
import { ease } from "./motion";
import { alpha, color, HIT, motion, radius, space } from "./theme";

const ICON = { [HintKind.Near]: "near", [HintKind.Bearing]: "bearing", [HintKind.Trend]: "trend" } as const;
const WHAT = {
  [HintKind.Near]: "Are they within 150 m?",
  [HintKind.Bearing]: "Which way are they?",
  [HintKind.Trend]: "Closer than a minute ago?",
} as const;

export function HintSheet({
  open,
  hints,
  onSend,
  onClose,
  reduceMotion,
  initialKind = HintKind.Near,
  noLocation = false,
}: {
  open: boolean;
  hints: HintOption[];
  /** Your target never reports a location (a test player): the referee refuses every hint. */
  noLocation?: boolean;
  onSend: (kind: HintKind, question: string) => void;
  onClose: () => void;
  reduceMotion: boolean;
  initialKind?: HintKind;
}) {
  const inset = useSafeAreaInsets();
  const [kind, setKind] = useState<HintKind>(initialKind);
  const [question, setQuestion] = useState("");
  const t = useRef(new Animated.Value(open ? 1 : 0)).current;
  const [mounted, setMounted] = useState(open);

  useEffect(() => {
    if (open) setMounted(true);
    const done = () => {
      if (!open) setMounted(false);
    };
    if (reduceMotion) {
      t.setValue(open ? 1 : 0);
      done();
      return;
    }
    Animated.timing(t, {
      toValue: open ? 1 : 0,
      duration: open ? motion.base : motion.fast,
      easing: open ? ease.out : ease.in,
      useNativeDriver: true,
    }).start(done);
  }, [open, reduceMotion, t]);

  if (!mounted) return null;
  const chosen = hints.find((h) => h.kind === kind);
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View
        style={[StyleSheet.absoluteFill, { backgroundColor: alpha(color.ink, 0.4), opacity: t }]}
      >
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close hints"
        />
      </Animated.View>
      <KeyboardAvoidingView behavior="padding" style={styles.dock} pointerEvents="box-none">
        <Animated.View
          accessibilityViewIsModal
          style={[
            styles.sheet,
            { paddingBottom: Math.max(inset.bottom, space.l) },
            { transform: [{ translateY: t.interpolate({ inputRange: [0, 1], outputRange: [480, 0] }) }] },
          ]}
        >
          <View style={styles.grab} />
          <View style={styles.titleRow}>
            <Icon name="handler" size={24} tint={color.ink} />
            <Title>Ask the Handler</Title>
          </View>
          <Caption muted>Paid from your head to your target's.</Caption>
          <View accessibilityRole="radiogroup" style={styles.options}>
            {hints.map((h) => {
              const on = h.kind === kind;
              return (
                <Pressable
                  key={h.kind}
                  onPress={() => setKind(h.kind)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={`${h.name}, ${WHAT[h.kind]} ${h.price}`}
                  style={[styles.option, on && styles.optionOn]}
                >
                  <Icon name={ICON[h.kind]} size={26} tint={color.ink} />
                  <View style={styles.grow}>
                    <Strong>{h.name}</Strong>
                    <Caption muted>{WHAT[h.kind]}</Caption>
                  </View>
                  <Figure>{h.price}</Figure>
                </Pressable>
              );
            })}
          </View>
          <Field
            label="Question (optional)"
            value={question}
            onChangeText={setQuestion}
            maxLength={HINT_TEXT_MAX}
            placeholder="Anything for the Handler"
            autoCapitalize="sentences"
            autoCorrect
          />
          <Body muted style={styles.count}>{`${question.length}/${HINT_TEXT_MAX}`}</Body>
          {noLocation ? (
            <Caption muted>Your target is a test player. It has no location, so hints can't find it.</Caption>
          ) : null}
          <Button
            title={chosen ? `Send ${chosen.name}, ${chosen.price}` : "Send"}
            icon={ICON[kind]}
            disabled={noLocation}
            onPress={() => {
              onSend(kind, question);
              setQuestion("");
            }}
          />
        </Animated.View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  dock: { flex: 1, justifyContent: "flex-end" },
  sheet: {
    backgroundColor: color.sand,
    borderTopLeftRadius: radius.l,
    borderTopRightRadius: radius.l,
    paddingHorizontal: space.xl,
    paddingTop: space.s,
    gap: space.m,
  },
  grab: {
    alignSelf: "center",
    width: 40,
    height: 5,
    borderRadius: 3,
    backgroundColor: color.mute,
    marginBottom: space.s,
  },
  titleRow: { flexDirection: "row", alignItems: "center", gap: space.s },
  options: { gap: space.s },
  option: {
    minHeight: HIT + 16,
    flexDirection: "row",
    alignItems: "center",
    gap: space.m,
    paddingHorizontal: space.l,
    borderRadius: radius.m,
    borderWidth: 2,
    borderColor: "transparent",
    backgroundColor: color.paper,
  },
  optionOn: { borderColor: color.ink },
  grow: { flex: 1 },
  count: { textAlign: "right", fontSize: 13, marginTop: -space.s },
});
