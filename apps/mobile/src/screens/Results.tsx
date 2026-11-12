import { useEffect } from "react";
import { Linking } from "react-native";
import { formatAmount } from "../game/hud";
import { useApp } from "../state/app";
import { Body, Button, Figure, Gap, Screen, Title } from "../ui/kit";

/** Out or over: final head and the replay. */
export function Results() {
  const app = useApp();
  // The lobby poll stops during the hunt; read the settled heads once more.
  useEffect(() => {
    void app.refresh();
  }, [app]);
  const snap = app.session?.snapshot();
  const hud = snap?.hud;
  const mine = app.match?.chain?.players.find((p) => p.accountId === app.me);
  const head = hud?.head ?? mine?.head ?? null;
  const title =
    hud?.status === "out" || mine?.out
      ? "You're out"
      : snap?.over || app.match?.phase === "ended"
        ? "Match over"
        : "Waiting";
  const replay = app.matchId ? app.relay.replayUrl(app.matchId) : null;
  return (
    <Screen>
      <Title>{title}</Title>
      {head !== null ? <Figure label="Your head">{formatAmount(head)}</Figure> : null}
      <Body muted>Heads settle on NEAR when the referee ends the match. The replay opens then.</Body>
      <Gap />
      {replay ? (
        <Button title="Replay data" kind="plain" onPress={() => void Linking.openURL(replay)} />
      ) : null}
      <Button title="Done" onPress={() => app.finishMatch()} />
    </Screen>
  );
}
