import { useState } from "react";
import { useApp } from "../state/app";
import { Mark } from "../ui/brand";
import { Body, Button, ErrorLine, Field, Gap, Row, Screen, Title } from "../ui/kit";

/** First launch: pick a handle; the relay checks this is a real iPhone and makes the account. */
export function Enrol() {
  const app = useApp();
  const [handle, setHandle] = useState("");
  return (
    <Screen>
      <Mark />
      <Title>TAIL</Title>
      <Body muted>
        Pick a handle. Your phone proves it is a real iPhone, then you get a NEAR account that can only play.
      </Body>
      <Gap />
      <Field label="Handle" value={handle} onChangeText={setHandle} placeholder="alice" maxLength={40} />
      <Body muted>{app.settings.relayUrl ? `Relay: ${app.settings.relayUrl}` : "No relay set."}</Body>
      <ErrorLine text={app.error} />
      <Row>
        <Button
          title={app.busy ?? "Join"}
          disabled={!!app.busy || handle.trim().length < 2 || !app.settings.relayUrl}
          onPress={() => void app.enrol(handle)}
        />
        <Button title="Settings" kind="plain" onPress={() => app.toggleSettings(true)} />
      </Row>
    </Screen>
  );
}
