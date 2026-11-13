// Results: survived or out, final head, your tags, the 3D replay (opens in Safari), how it is
// verified (one tap away for anyone who asks), your reports checked against the log anchored on
// NEAR, and after the end a presence proof for each player you met.
import { useEffect, useState } from "react";
import { Animated, Linking, Pressable, StyleSheet, View } from "react-native";
import type { RefereeKind } from "../relay/client";
import { type Receipts, useApp } from "../state/app";
import { handleOf, howVerified, money, type Outcome, resultOutcome } from "../tail/huntModel";
import { receiptLines } from "../tail/results";
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
  /** Which referee the relay says ran the match; null when it did not say. */
  referee: RefereeKind | null;
  /** Your reports checked against the log root on NEAR. */
  receipts: Receipts;
  /** Players you can prove you met (account ids), once the match has ended. */
  met: string[];
}

/** The receipt check as lines for the screen, and problems apart. */
export function receiptsText(r: Receipts): { lines: string[]; problems: string[] } {
  switch (r.kind) {
    case "idle":
      return { lines: [], problems: [] };
    case "checking":
      return { lines: ["Checking your reports against NEAR."], problems: [] };
    case "none":
      return { lines: [r.why], problems: [] };
    case "error":
      return { lines: [], problems: [`Couldn't check your reports: ${r.message}`] };
    case "done":
      return receiptLines(r.result);
  }
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
  onProve,
}: {
  m: ResultsModel;
  onReplay: () => void;
  onDone: () => void;
  onProve: (account: string) => void;
}) {
  const receipts = receiptsText(m.receipts);
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
          <Body muted>{howVerified(m.referee)}</Body>
        </View>
      ) : null}
      {receipts.lines.length + receipts.problems.length > 0 ? (
        <View style={styles.receipts} accessible>
          <Eyebrow muted>Your reports</Eyebrow>
          {receipts.lines.map((l) => (
            <Body key={l}>{l}</Body>
          ))}
          {receipts.problems.map((p) => (
            <Strong key={p}>{p}</Strong>
          ))}
        </View>
      ) : null}
      {m.met.length > 0 ? (
        <View style={styles.receipts}>
          <Eyebrow muted>Proof you met</Eyebrow>
          <Caption muted>
            Each is a log entry and its path to the root on NEAR. Anyone can check it from the chain alone.
          </Caption>
          {m.met.map((account) => (
            <Button
              key={account}
              kind="quiet"
              symbol="square.and.arrow.up"
              title={`Prove I met ${handleOf(account)}`}
              onPress={() => onProve(account)}
            />
          ))}
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
    void app.checkRelay();
  }, [app]);
  const snap = app.session?.snapshot();
  const mine = app.match?.chain?.players.find((p) => p.accountId === app.me);
  const ended = app.match?.phase === "ended" || app.match?.chain?.phase === "ended";
  // Checked once on arrival and again at the end, when End's root covers every report.
  useEffect(() => {
    void app.checkReceipts();
    if (ended) void app.findMeetings();
  }, [app, ended]);
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
        tags: app.tags,
        replayUrl: replay,
        seed: Number.parseInt(app.matchId?.slice(0, 6) ?? "0", 16) || 0,
        referee: app.refereeKind,
        receipts: app.receipts,
        met: app.meetings?.map((x) => x.other) ?? [],
      }}
      onReplay={() => replay && void Linking.openURL(replay)}
      onDone={() => app.finishMatch()}
      onProve={(account) => void app.shareMeeting(account)}
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
  receipts: { gap: space.xs },
});
