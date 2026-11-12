import { useState } from "react";
import { type Settings as S, useApp } from "../state/app";
import { Body, Button, Field, Gap, Screen, Title } from "../ui/kit";

/** Where the app connects. A plain screen, not a modal. */
export function Settings() {
  const app = useApp();
  const [v, setV] = useState<S>(app.settings);
  const set = (k: keyof S) => (t: string) => setV({ ...v, [k]: t });
  return (
    <Screen
      footer={
        <>
          <Button title="Save" onPress={() => app.saveSettings(v)} />
          <Button kind="quiet" title="Cancel" onPress={() => app.toggleSettings(false)} />
        </>
      }
    >
      <Title>Settings</Title>
      <Field
        label="Relay"
        value={v.relayUrl}
        onChangeText={set("relayUrl")}
        placeholder="https://relay.example"
        keyboardType="url"
      />
      <Field label="NEAR RPC" value={v.rpcUrl} onChangeText={set("rpcUrl")} keyboardType="url" />
      <Field
        label="Contract"
        value={v.contractId}
        onChangeText={set("contractId")}
        placeholder="tail.example.testnet"
      />
      <Field
        label="Replay site"
        value={v.replayUrl}
        onChangeText={set("replayUrl")}
        placeholder="https://replay.example"
        keyboardType="url"
      />
      <Gap />
      <Title>Mesh carry</Title>
      <Body muted>
        Carries your sealed reports over Bluetooth when you lose signal. Off until the relay runs a mesh node;
        set its address to turn it on.
      </Body>
      <Field
        label="Relay mesh node"
        value={v.nodeAddress}
        onChangeText={set("nodeAddress")}
        placeholder="off1…"
      />
      <Field
        label="Mesh server (optional)"
        value={v.serverUrl}
        onChangeText={set("serverUrl")}
        placeholder="wss://…"
        keyboardType="url"
      />
    </Screen>
  );
}
