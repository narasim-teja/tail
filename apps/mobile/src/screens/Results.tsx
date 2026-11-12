// Results: survived or out, final head, your tags, the 3D replay (opens in Safari), and how
// it is verified, one tap away for anyone who asks.
import { useEffect, useState } from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import { money } from "../game/huntModel";
import { useApp } from "../state/app";
import { Icon } from "../ui/brand";
import {
  Body,
  Button,
  Caption,
  Display,
  Eyebrow,
  inkOn,
  Num,
  Row,
  Rule,
  Screen,
  Strong,
  useTone,
} from "../ui/kit";
import { HIT, space } from "../ui/theme";

export interface ResultsModel {
  outcome: "survived" | "won" | "out" | "running";
  head: bigint | null;
  tags: number;
  /** Null until the replay site is set or the match has ended. */
  replayUrl: string | null;
}

const HEADLINE = {
  survived: "Survived",
  won: "Last one standing",
  out: "Out",
  running: "You're out",
} as const;
const LINE = {
  survived: "You kept your head.",
  won: "Everything on the table is yours.",
  out: "Your head went to your hunter.",
  running: "The match goes on without you. The replay opens when it ends.",
} as const;

export function ResultsView({
  m,
  onReplay,
  onDone,
}: {
  m: ResultsModel;
  onReplay: () => void;
  onDone: () => void;
}) {
  const [why, setWhy] = useState(false);
  return (
    <Screen
      tone={m.outcome === "out" || m.outcome === "running" ? "ink" : "paper"}
      footer={
        <>
          {m.replayUrl ? <Button title="Watch the replay" onPress={onReplay} hint="Opens in Safari" /> : null}
          <Button kind={m.replayUrl ? "quiet" : "primary"} title="Done" onPress={onDone} />
        </>
      }
    >
      <View style={styles.hero}>
        <Display>{HEADLINE[m.outcome]}</Display>
        <Body muted>{LINE[m.outcome]}</Body>
      </View>
      <Row gap="xxl">
        <View accessible accessibilityLabel={`Final head ${m.head === null ? "pending" : money(m.head)}`}>
          <Eyebrow muted>Final head</Eyebrow>
          <Num>{m.head === null ? "-" : money(m.head)}</Num>
        </View>
        <View accessible accessibilityLabel={`${m.tags} ${m.tags === 1 ? "tag" : "tags"}`}>
          <Eyebrow muted>Tags</Eyebrow>
          <Num>{m.tags}</Num>
        </View>
      </Row>
      <Rule />
      <Pressable
        onPress={() => setWhy((w) => !w)}
        accessibilityRole="button"
        accessibilityState={{ expanded: why }}
        accessibilityLabel="How it's verified"
        style={styles.why}
      >
        <VerifiedIcon />
        <Strong>How it's verified</Strong>
      </Pressable>
      {why ? (
        <View style={styles.whyBody}>
          <Body muted>
            Every tag needed both phones to hear each other's one-time codes. A referee in a hardware enclave
            checked that and signed the tag; the NEAR contract only moves money on that signature. The replay
            re-checks every signature against the chain.
          </Body>
        </View>
      ) : null}
      {m.replayUrl ? null : <Caption muted>The replay link appears here once the match has ended.</Caption>}
    </Screen>
  );
}

function VerifiedIcon() {
  const tone = useTone();
  return (
    <View style={styles.badge}>
      <Icon name="verified" size={22} tint={inkOn(tone)} />
    </View>
  );
}

export function Results() {
  const app = useApp();
  useEffect(() => {
    void app.refresh();
  }, [app]);
  const snap = app.session?.snapshot();
  const mine = app.match?.chain?.players.find((p) => p.accountId === app.me);
  const ended = app.match?.phase === "ended" || app.match?.chain?.phase === "ended";
  const out = snap?.hud?.status === "out" || !!mine?.out;
  const outcome: ResultsModel["outcome"] = out
    ? ended
      ? "out"
      : "running"
    : snap?.hud?.status === "won"
      ? "won"
      : "survived";
  const replay =
    ended && app.matchId && app.settings.replayUrl
      ? `${app.settings.replayUrl.replace(/\/+$/, "")}/?match=${app.matchId}`
      : null;
  return (
    <ResultsView
      m={{ outcome, head: mine?.head ?? snap?.hud?.head ?? null, tags: snap?.tags ?? 0, replayUrl: replay }}
      onReplay={() => replay && void Linking.openURL(replay)}
      onDone={() => app.finishMatch()}
    />
  );
}

const styles = StyleSheet.create({
  hero: { gap: space.s, paddingTop: space.x3, paddingBottom: space.l },
  why: { minHeight: HIT, flexDirection: "row", alignItems: "center", gap: space.m },
  whyBody: { paddingLeft: 40 },
  badge: { width: 28, alignItems: "center" },
});
