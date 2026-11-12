import * as Linking from "expo-linking";
import { useEffect, useState } from "react";
import { Switch, View } from "react-native";
import { parseAmount } from "../game/hud";
import { useApp } from "../state/app";
import { Body, Button, ErrorLine, Field, Gap, Label, Row, Screen, Title } from "../ui/kit";

/** Join with a code or a link, or open a new lobby centred where you stand. */
export function Home() {
  const app = useApp();
  const url = Linking.useLinkingURL();
  const [code, setCode] = useState("");
  const [stake, setStake] = useState("1");
  const [minutes, setMinutes] = useState("30");
  const [minPlayers, setMinPlayers] = useState("3");
  const [radius, setRadius] = useState("400");
  const [publicReplay, setPublicReplay] = useState(true);

  // tail://join/<match id> opens that lobby.
  useEffect(() => {
    const m = url ? /join\/([0-9a-f]{32})/.exec(url) : null;
    if (m?.[1]) app.openMatch(m[1]);
  }, [url, app]);

  useEffect(() => {
    app.startLocating();
    return () => app.endLocating();
  }, [app]);

  const create = () => {
    let units: bigint;
    try {
      units = parseAmount(stake);
    } catch {
      return;
    }
    const n = (s: string) => Number.parseInt(s, 10);
    void app.createMatch({
      stake: units,
      durationMs: n(minutes) * 60_000,
      minPlayers: n(minPlayers),
      maxPlayers: 12,
      radiusM: n(radius),
      publicReplay,
    });
  };

  return (
    <Screen>
      <Row>
        <Title>{app.me}</Title>
      </Row>
      <Field label="Match code" value={code} onChangeText={setCode} placeholder="32 letters and digits" />
      <Button title="Open lobby" disabled={!code.trim()} onPress={() => app.openMatch(code)} />
      <Gap size="xl" />
      <Title>New match</Title>
      <Field label="Stake (USDC)" value={stake} onChangeText={setStake} keyboardType="decimal-pad" />
      <Field label="Minutes" value={minutes} onChangeText={setMinutes} keyboardType="number-pad" />
      <Field
        label="Players needed"
        value={minPlayers}
        onChangeText={setMinPlayers}
        keyboardType="number-pad"
      />
      <Field label="Zone radius (m)" value={radius} onChangeText={setRadius} keyboardType="number-pad" />
      <View
        style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 44 }}
      >
        <Label>Public replay</Label>
        <Switch value={publicReplay} onValueChange={setPublicReplay} accessibilityLabel="Public replay" />
      </View>
      <Body muted>
        {app.here ? `Zone centre: you, within ${Math.round(app.here.acc)} m.` : "Finding your location."}
      </Body>
      <ErrorLine text={app.error} />
      <Row>
        <Button title={app.busy ?? "Create"} disabled={!!app.busy || !app.here} onPress={create} />
        <Button title="Settings" kind="plain" onPress={() => app.toggleSettings(true)} />
      </Row>
    </Screen>
  );
}
