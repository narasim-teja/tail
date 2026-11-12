import { useEffect, useState } from "react";
import { useApp } from "../state/app";
import { Body, Button, ErrorLine, Figure, Gap, Screen, Title } from "../ui/kit";

/** Your target, then into the hunt. Your phone must stay in front, screen off by pocket mode. */
export function Briefing() {
  const app = useApp();
  const b = app.briefing;
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!b && !app.busy) void app.brief();
  }, [b, app]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);

  if (!b) {
    return (
      <Screen>
        <Title>Briefing</Title>
        <Body muted>{app.busy ?? "Waiting for your orders."}</Body>
        <ErrorLine text={app.error} />
        {app.error ? <Button title="Try again" onPress={() => void app.brief()} /> : null}
      </Screen>
    );
  }
  const startIn = Math.max(0, Math.ceil((Number(b.keys.startMs) - now) / 1000));
  return (
    <Screen>
      <Title>Your target</Title>
      <Figure label="Target">{b.keys.target}</Figure>
      <Body muted>Someone has you too. Keep the app open; pocket mode turns the screen off.</Body>
      <Gap />
      {startIn > 0 ? <Figure label="Starts in">{startIn}</Figure> : null}
      <Button title="Hunt" onPress={() => app.beginHunt()} hint="Starts the beacon, scan and location" />
    </Screen>
  );
}
