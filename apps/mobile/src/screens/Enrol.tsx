// First launch. One field. The phone proves it is a real iPhone (App Attest); the relay then
// makes a NEAR account whose only key is this phone's and which can only play.
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useApp } from "../state/app";
import { attestor } from "../state/device";
import { Body, Button, Caption, Field, Gap, Notice, Poster, Screen } from "../ui/kit";
import { useReduceMotion } from "../ui/motion";
import { ChaseBand } from "../ui/scene";
import { space } from "../ui/theme";

export interface EnrolModel {
  busy: string | null;
  /** The relay refused the handle; shown under the field. */
  handleError: string | null;
  error: string | null;
  relaySet: boolean;
  /** App Attest is missing (simulator, very old iPhone): enrolment cannot work here. */
  unsupported: boolean;
}

export function EnrolView({
  m,
  onJoin,
  onSettings,
}: {
  m: EnrolModel;
  onJoin: (handle: string) => void;
  onSettings: () => void;
}) {
  const [handle, setHandle] = useState("");
  const reduceMotion = useReduceMotion();
  const ok = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(handle.trim().toLowerCase()) && handle.trim().length >= 2;
  return (
    <Screen
      footer={
        m.unsupported ? null : (
          <>
            <Button
              title={m.busy ?? "Join"}
              busy={!!m.busy}
              disabled={!ok || !m.relaySet}
              onPress={() => onJoin(handle)}
            />
            <Button kind="quiet" symbol="gearshape" title="Settings" onPress={onSettings} />
          </>
        )
      }
    >
      <Gap size="s" />
      <ChaseBand height={220} reduceMotion={reduceMotion} />
      <View style={styles.title}>
        <Poster>TAIL</Poster>
        <Body muted>Tag your friends in the real world. Every tag comes with proof.</Body>
      </View>
      <Gap size="s" />
      {m.unsupported ? (
        <Notice
          icon="dark"
          title="This iPhone can't prove itself"
          detail="TAIL needs App Attest, which this device does not offer. Play on a recent iPhone."
        />
      ) : (
        <>
          <Field
            label="Handle"
            value={handle}
            onChangeText={setHandle}
            placeholder="alice"
            maxLength={40}
            error={m.handleError}
            returnKeyType="go"
            onSubmitEditing={() => ok && m.relaySet && onJoin(handle)}
          />
          <Caption muted>Letters, digits, and - or _ between them. Friends see it.</Caption>
          {!m.relaySet ? (
            <Notice title="No relay set" detail="Add the relay address in Settings first." />
          ) : null}
          {m.error ? <Notice title="Couldn't join" detail={m.error} /> : null}
        </>
      )}
    </Screen>
  );
}

export function Enrol() {
  const app = useApp();
  const taken = app.error?.includes("taken") ? "That handle is taken. Try another." : null;
  return (
    <EnrolView
      m={{
        busy: app.busy,
        handleError: taken,
        error: taken ? null : app.error,
        relaySet: !!app.settings.relayUrl,
        unsupported: !attestor.isSupported,
      }}
      onJoin={(h) => void app.enrol(h)}
      onSettings={() => app.toggleSettings(true)}
    />
  );
}

const styles = StyleSheet.create({ title: { gap: space.s } });
