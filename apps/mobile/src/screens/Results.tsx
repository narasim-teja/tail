// Results: survived or out, final head, your tags, the 3D replay (opens in Safari), and how
// it is verified, one tap away for anyone who asks.
import { useEffect, useState } from "react";
import { Animated, Linking, Pressable, StyleSheet, View } from "react-native";
import { money, type Outcome, resultOutcome } from "../game/huntModel";
import { useApp } from "../state/app";
import { Icon, Mark } from "../ui/brand";
import { RollingMoney } from "../ui/game";
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
import { rise, useArrive, useCountUp, useReduceMotion } from "../ui/motion";
import { Ripple } from "../ui/scene";
import { color, HIT, motion, radius, space } from "../ui/theme";

export interface ResultsModel {
  outcome: Outcome;
  head: bigint | null;
  tags: number;
  /** Null until the replay site is set or the match has ended. */
  replayUrl: string | null;
  /** Picks the Handler's sign-off, so a rematch hears a different line. */
  seed: number;
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

/** The outcome emblem's ring room around a 64 pt mark: the rings reach exactly to the screen
 * edge (the page's 24 pt margin) and are never clipped. */
const EMBLEM = 64 + 2 * 24;

/** The Handler's sign-off: the only voice here with jokes (PRODUCT.md). */
const SIGN_OFF = {
  survived: [
    "Still breathing. I had money on the other outcome.",
    "Nobody laid a finger on you. Rude of them, really.",
    "You walked out with your head. Frame the receipt.",
  ],
  won: [
    "Last one standing. The drinks are on you, literally.",
    "Everyone else is a story you tell now.",
    "Clean sweep. I'll pretend I trained you.",
  ],
  out: [
    "They got you. Happens to the best. Mostly to the rest.",
    "Your head changed owners. Ask for a rematch.",
    "Shake it off. Then check the replay and see who.",
  ],
  running: [
    "Benched. Watch the others sweat.",
    "You're out, but the gossip isn't. Stay close.",
    "Sit tight. The replay tells the rest.",
  ],
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
  const reduceMotion = useReduceMotion();
  const dark = m.outcome === "out" || m.outcome === "running";
  const hero = useArrive(m.outcome, reduceMotion, { ms: motion.slow });
  const handler = useArrive(m.outcome, reduceMotion, { ms: motion.slow, delay: 500 });
  const tags = Math.round(useCountUp(m.tags, reduceMotion, 700));
  const lines = SIGN_OFF[m.outcome];
  const signOff = lines[Math.abs(m.seed) % lines.length];
  return (
    <Screen
      tone={dark ? "ink" : "paper"}
      footer={
        <>
          {m.replayUrl ? (
            <Button
              symbol="play.circle.fill"
              title="Watch the replay"
              onPress={onReplay}
              hint="Opens in Safari"
            />
          ) : null}
          <Button kind={m.replayUrl ? "quiet" : "primary"} title="Done" onPress={onDone} />
        </>
      }
    >
      <Animated.View style={[styles.hero, rise(hero, 16)]}>
        <View style={styles.emblem}>
          <Ripple
            size={EMBLEM}
            tint={dark ? color.paper : color.persimmon}
            reduceMotion={reduceMotion || m.outcome === "running"}
            ms={2_800}
          >
            {dark ? <Icon name="strike" size={56} tint={color.paper} /> : <Mark size={64} />}
          </Ripple>
        </View>
        <Display>{HEADLINE[m.outcome]}</Display>
        <Body muted>{LINE[m.outcome]}</Body>
      </Animated.View>
      <Row gap="xxl">
        <View accessible accessibilityLabel={`Final head ${m.head === null ? "pending" : money(m.head)}`}>
          <Eyebrow muted>Final head</Eyebrow>
          {m.head === null ? <Num>-</Num> : <RollingMoney units={m.head} reduceMotion={reduceMotion} />}
        </View>
        <View accessible accessibilityLabel={`${m.tags} ${m.tags === 1 ? "tag" : "tags"}`}>
          <Eyebrow muted>Tags</Eyebrow>
          <Num>{tags}</Num>
        </View>
      </Row>
      <Animated.View
        style={[styles.dispatch, dark && styles.dispatchDark, rise(handler, 10)]}
        accessible
        accessibilityLabel={`Handler: ${signOff}`}
      >
        <Row gap="xs">
          <Icon name="handler" size={18} tint={dark ? color.paper : color.ink} />
          <Eyebrow>Handler</Eyebrow>
        </Row>
        <Strong>{signOff}</Strong>
      </Animated.View>
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
  const outcome = resultOutcome({
    hudStatus: snap?.hud?.status ?? null,
    out: !!mine?.out,
    ended,
    standing: app.match?.chain?.players.filter((p) => !p.out).length ?? 0,
  });
  const replay =
    ended && app.matchId && app.settings.replayUrl
      ? `${app.settings.replayUrl.replace(/\/+$/, "")}/?match=${app.matchId}`
      : null;
  return (
    <ResultsView
      m={{
        outcome,
        head: mine?.head ?? snap?.hud?.head ?? null,
        tags: snap?.tags ?? 0,
        replayUrl: replay,
        seed: Number.parseInt(app.matchId?.slice(0, 6) ?? "0", 16) || 0,
      }}
      onReplay={() => replay && void Linking.openURL(replay)}
      onDone={() => app.finishMatch()}
    />
  );
}

const styles = StyleSheet.create({
  hero: { gap: space.s, paddingTop: space.l, paddingBottom: space.l },
  // The emblem lines up with the headline's left edge; its rings spread past the column.
  emblem: { alignItems: "flex-start", marginLeft: -(EMBLEM - 64) / 2, marginVertical: -space.l },
  // The Handler's line: a quiet sand plate on paper, a mute plate on ink.
  dispatch: { gap: space.xs, padding: space.l, borderRadius: radius.m, backgroundColor: color.sand },
  dispatchDark: { backgroundColor: color.mute },
  why: { minHeight: HIT, flexDirection: "row", alignItems: "center", gap: space.m },
  whyBody: { paddingLeft: 40 },
  badge: { width: 28, alignItems: "center" },
});
