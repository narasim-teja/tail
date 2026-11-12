// Three cards, once, skippable (docs/briefs/mobile.md 5): the whole game in three sentences.
import type { IconName } from "@tail/brand";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useApp } from "../state/app";
import { Icon, Mark } from "../ui/brand";
import { Body, Button, Caption, Display, Row, Screen } from "../ui/kit";
import { color, space } from "../ui/theme";

const CARDS: { icon: IconName; title: string; line: string }[] = [
  { icon: "lock", title: "Lock", line: "Stay within Bluetooth range of your target and your lock fills." },
  { icon: "heat", title: "Heat", line: "When someone is on you, your heat fills. You never learn who." },
  {
    icon: "strike",
    title: "Strike",
    line: "Full lock, press Strike while still close: their head is yours.",
  },
];

export function PrimerView({ step: initial = 0, onDone }: { step?: number; onDone: () => void }) {
  const [step, setStep] = useState(initial);
  const card = CARDS[step] ?? CARDS[0];
  if (!card) return null;
  const last = step === CARDS.length - 1;
  return (
    <Screen
      scroll={false}
      footer={
        <Row gap="m" style={styles.footer}>
          <Button kind="quiet" title="Skip" onPress={onDone} />
          <Button
            title={last ? "Play" : "Next"}
            onPress={() => (last ? onDone() : setStep(step + 1))}
            style={styles.next}
          />
        </Row>
      }
    >
      <Mark size={36} />
      <View
        style={styles.card}
        accessible
        accessibilityLabel={`${card.title}. ${card.line} Card ${step + 1} of ${CARDS.length}`}
      >
        <Icon
          name={card.icon}
          size={112}
          tint={card.icon === "lock" || card.icon === "strike" ? color.persimmon : color.ink}
        />
        <Display>{card.title}</Display>
        <Body>{card.line}</Body>
      </View>
      <View style={styles.dots}>
        {CARDS.map((c, i) => (
          <View key={c.title} style={[styles.dot, i === step && styles.dotOn]} />
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
  card: { flex: 1, justifyContent: "center", gap: space.l },
  dots: { flexDirection: "row", alignItems: "center", gap: space.s },
  dot: { width: 8, height: 8, borderRadius: 4, borderWidth: 1.5, borderColor: color.ink },
  dotOn: { backgroundColor: color.ink },
  footer: { justifyContent: "space-between", flexWrap: "nowrap" },
  next: { flex: 1 },
});
