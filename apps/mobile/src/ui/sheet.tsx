// Sheets rise from the bottom over the hunt, never a dialog.
// The hint sheet: three hints (icon, name, what it tells you, price), the Handler's line on why
// intel costs what it does right now, an optional question, Send. Prices come from the referee's
// signed HUD and move with demand. The price leaves your head for the match's hint pool.
// The leave sheet: what leaving costs, before the phone stops reporting.

import { HINT_TEXT_MAX, HintKind } from "@tail/protocol";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Animated, KeyboardAvoidingView, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { HintOption, LeaveTime } from "../tail/huntModel";
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

/** The shell every sheet shares: a dimmed backdrop that closes it, the sheet sliding up. */
function Sheet({
  open,
  reduceMotion,
  onClose,
  closeLabel,
  children,
}: {
  open: boolean;
  reduceMotion: boolean;
  onClose: () => void;
  /** What VoiceOver says for the backdrop. */
  closeLabel: string;
  children: ReactNode;
}) {
  const inset = useSafeAreaInsets();
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
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View
        style={[StyleSheet.absoluteFill, { backgroundColor: alpha(color.ink, 0.4), opacity: t }]}
      >
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={closeLabel}
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
          {children}
        </Animated.View>
      </KeyboardAvoidingView>
    </View>
  );
}

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
  const [kind, setKind] = useState<HintKind>(initialKind);
  const [question, setQuestion] = useState("");
  const chosen = hints.find((h) => h.kind === kind);
  return (
    <Sheet open={open} reduceMotion={reduceMotion} onClose={onClose} closeLabel="Close hints">
      <View style={styles.titleRow}>
        <Icon name="handler" size={24} tint={color.ink} />
        <Title>Ask the Handler</Title>
      </View>
      {chosen?.reason ? <Body>{chosen.reason}</Body> : null}
      <Caption muted>Paid from your head into the hint pool. Prices rise as hunters buy.</Caption>
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
    </Sheet>
  );
}

/**
 * Leave match, asked once more: what it costs, in plain words, before the phone stops
 * reporting. The rules have no quit; leaving is going dark until the referee forfeits the head.
 */
export function LeaveSheet({
  open,
  head,
  time,
  reduceMotion,
  onLeave,
  onClose,
}: {
  open: boolean;
  /** "$5.40": the head as the referee last counted it. */
  head: string;
  /** What leaving now costs, by the referee's dark count (tail/huntModel.ts). */
  time: LeaveTime;
  reduceMotion: boolean;
  onLeave: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet open={open} reduceMotion={reduceMotion} onClose={onClose} closeLabel="Keep hunting">
      <Title>Leave the match?</Title>
      <Body>
        {time.endsFirst
          ? `Your phone stops reporting. The match ends in ${time.endsIn}, before the referee would call it, so your head, ${head}, stays yours.`
          : `Your phone stops reporting. In about ${time.forfeitIn} the referee calls it, and your head, ${head}, goes to whoever is hunting you.`}
      </Body>
      <Caption muted>
        {time.endsFirst
          ? "Until the match ends you can rejoin."
          : "It takes up to 3 minutes. Until the referee calls it you can rejoin; after that it can't be undone."}
      </Caption>
      <Button title="Leave match" onPress={onLeave} />
      <Button kind="quiet" title="Keep hunting" onPress={onClose} />
    </Sheet>
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
