import { useState } from "react";
import { type Settings as S, useApp } from "../state/app";
import { Body, Button, Field, Gap, Screen, Title, ToggleRow } from "../ui/kit";

/** Where the app connects. A plain screen, not a modal. */
export function Settings() {
  const app = useApp();
  const [v, setV] = useState<S>(app.settings);
  const set = (k: "relayUrl" | "rpcUrl" | "contractId") => (t: string) => setV({ ...v, [k]: t });
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
      <Gap />
      <Title>Mesh carry</Title>
      <Body muted>
        When you lose signal, nearby players with signal pass your sealed reports on to the relay, and you do
        the same for them. They see only ciphertext, not who sent it.
      </Body>
      <Body muted>
        Off by default: the mesh and TAIL's beacon share this phone's Bluetooth, and it isn't measured yet
        whether the mesh leaves room in the beacon for your code. If it doesn't, nobody can hear you.
      </Body>
      <ToggleRow
        label="Carry reports over the mesh"
        value={v.meshCarry}
        onChange={(on) => setV({ ...v, meshCarry: on })}
      />
    </Screen>
  );
}
