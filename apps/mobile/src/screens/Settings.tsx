// Settings: nothing a player must fill in. On top, whether the relay answers and which referee it
// says it runs. Addresses and experiments are under Advanced, collapsed, except when no relay is
// set: then it opens on the relay address, the one thing left to fill in. The contract is shown,
// never edited: the build names it (app.config.ts TAIL_CONTRACT).
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { RefereeKind, RelayInfo } from "../relay/client";
import { APP_VERSION, CONTRACT_ID, useApp } from "../state/app";
import { DEFAULT_RPC, type Settings as S } from "../state/settings";
import { SystemIcon } from "../ui/brand";
import { ContractMismatch } from "../ui/contract";
import { Button, Caption, Field, Label, Notice, Rule, Screen, Title, ToggleRow } from "../ui/kit";
import { color, HIT, maxScale, space, text } from "../ui/theme";

export type RelayStatus =
  | { kind: "unset" }
  | { kind: "checking" }
  | { kind: "up"; referee: RefereeKind | null }
  | { kind: "down"; why: string };

/** The relay as Settings words it. The last read wins: a failure after an answer reads as down. */
export function relayStatus(a: {
  relayUrl: string;
  info: RelayInfo | null;
  down: string | null;
}): RelayStatus {
  if (!a.relayUrl) return { kind: "unset" };
  if (a.down) return { kind: "down", why: a.down };
  if (a.info) return { kind: "up", referee: a.info.referee };
  return { kind: "checking" };
}

/** The referee as the relay names it. The relay is not trusted, so this only ever says less. */
const REFEREE: Record<RefereeKind, string> = {
  outlayer: "It says its referee runs in a hardware enclave.",
  local: "It runs a test referee, not in a hardware enclave.",
};

function RelayLine({ s }: { s: RelayStatus }) {
  switch (s.kind) {
    case "unset":
      return <Notice title="No relay yet" detail="Add its address under Advanced." />;
    case "checking":
      return <Notice title="Checking the relay" />;
    case "up":
      return <Notice title="Relay connected" detail={s.referee ? REFEREE[s.referee] : null} />;
    case "down":
      return (
        <Notice
          icon="dark"
          title="No answer from the relay"
          detail={`${s.why} Check the address under Advanced.`}
        />
      );
  }
}

export interface SettingsModel {
  settings: S;
  status: RelayStatus;
  /** The contract this build names; empty when it names none. */
  contractId: string;
  contractMismatch: string | null;
  version: string | null;
}

export function SettingsView({
  m,
  onSave,
  onCancel,
}: {
  m: SettingsModel;
  onSave: (s: S) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState<S>(m.settings);
  const [open, setOpen] = useState(!m.settings.relayUrl);
  return (
    <Screen
      footer={
        <>
          <Button title="Save" onPress={() => onSave(v)} />
          <Button kind="quiet" title="Cancel" onPress={onCancel} />
        </>
      }
    >
      <Title>Settings</Title>
      <RelayLine s={m.status} />
      {m.contractMismatch ? <ContractMismatch relay={m.contractMismatch} /> : null}

      <Rule />
      <Pressable
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityLabel="Advanced"
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => [styles.disclosure, pressed && styles.pressed]}
      >
        <Label>Advanced</Label>
        <SystemIcon name={open ? "chevron.up" : "chevron.down"} size={15} tint={color.mute} />
      </Pressable>
      {open ? (
        <View style={styles.advanced}>
          <Field
            label="Relay address"
            value={v.relayUrl}
            onChangeText={(t) => setV({ ...v, relayUrl: t })}
            placeholder="http://192.168.1.20:8787"
            keyboardType="url"
          />
          <Field
            label="NEAR RPC"
            value={v.rpcUrl}
            onChangeText={(t) => setV({ ...v, rpcUrl: t })}
            placeholder={DEFAULT_RPC}
            keyboardType="url"
          />
          <View
            style={styles.fact}
            accessible
            accessibilityLabel={`Contract, ${m.contractId || "none in this build"}`}
          >
            <Label>Contract</Label>
            <Text selectable maxFontSizeMultiplier={maxScale.text} style={styles.value}>
              {m.contractId || "None in this build"}
            </Text>
          </View>
          <Rule />
          <ToggleRow
            label="Mesh carry (experimental)"
            value={v.meshCarry}
            onChange={(on) => setV({ ...v, meshCarry: on })}
          />
          <Caption muted>
            With no signal, nearby players' phones pass your sealed reports to the relay so you don't go dark;
            they can't read them.
          </Caption>
          <Caption muted>
            Off by default: it shares Bluetooth with the game's beacon and isn't tested on phones yet, so it
            could stop other players hearing you.
          </Caption>
        </View>
      ) : null}
      {m.version ? <Caption muted>{`TAIL ${m.version}`}</Caption> : null}
    </Screen>
  );
}

export function Settings() {
  const app = useApp();
  useEffect(() => {
    void app.readRelay();
  }, [app]);
  return (
    <SettingsView
      m={{
        settings: app.settings,
        status: relayStatus({ relayUrl: app.settings.relayUrl, info: app.relayInfo, down: app.relayDown }),
        contractId: CONTRACT_ID,
        contractMismatch: app.contractMismatch,
        version: APP_VERSION,
      }}
      onSave={(s) => app.saveSettings(s)}
      onCancel={() => app.toggleSettings(false)}
    />
  );
}

const styles = StyleSheet.create({
  disclosure: { minHeight: HIT, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  pressed: { opacity: 0.6 },
  advanced: { gap: space.m },
  fact: { gap: space.xs },
  value: { ...text.body, color: color.ink },
});
