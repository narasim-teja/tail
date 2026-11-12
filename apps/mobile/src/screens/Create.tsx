// New match: stake, length, players, zone size (centred on you), public replay.
import { useEffect, useState } from "react";
import { parseAmount } from "../game/hud";
import { useApp } from "../state/app";
import { Icon } from "../ui/brand";
import { Button, Caption, Field, Notice, Row, Screen, Title, ToggleRow } from "../ui/kit";
import { color } from "../ui/theme";

export interface CreateModel {
  /** Your location accuracy in metres, or null while finding you. */
  accuracyM: number | null;
  busy: string | null;
  error: string | null;
}

export interface NewMatchForm {
  stake: bigint;
  minutes: number;
  minPlayers: number;
  radiusM: number;
  publicReplay: boolean;
}

export function CreateView({
  m,
  onCreate,
  onBack,
}: {
  m: CreateModel;
  onCreate: (f: NewMatchForm) => void;
  onBack: () => void;
}) {
  const [stake, setStake] = useState("1");
  const [minutes, setMinutes] = useState("30");
  const [players, setPlayers] = useState("3");
  const [radius, setRadius] = useState("400");
  const [publicReplay, setPublicReplay] = useState(true);
  const n = (s: string) => Number.parseInt(s, 10);
  let units: bigint | null = null;
  try {
    units = parseAmount(stake);
  } catch {
    units = null;
  }
  const errors = {
    stake: units === null ? "A stake like 1 or 2.50." : null,
    minutes: !(n(minutes) >= 1 && n(minutes) <= 60) ? "1 to 60 minutes." : null,
    players: !(n(players) >= 3 && n(players) <= 12) ? "3 to 12 players." : null,
    radius: !(n(radius) >= 50 && n(radius) <= 20_000) ? "50 m to 20 km." : null,
  };
  const valid = Object.values(errors).every((e) => e === null) && m.accuracyM !== null;
  return (
    <Screen
      footer={
        <>
          <Button
            title={m.busy ?? "Create"}
            busy={!!m.busy}
            disabled={!valid}
            onPress={() =>
              units !== null &&
              onCreate({
                stake: units,
                minutes: n(minutes),
                minPlayers: n(players),
                radiusM: n(radius),
                publicReplay,
              })
            }
          />
          <Button kind="quiet" title="Back" onPress={onBack} />
        </>
      }
    >
      <Title>New match</Title>
      <Field
        label="Stake (USDC)"
        value={stake}
        onChangeText={setStake}
        keyboardType="decimal-pad"
        error={errors.stake}
      />
      <Field
        label="Minutes"
        value={minutes}
        onChangeText={setMinutes}
        keyboardType="number-pad"
        error={errors.minutes}
      />
      <Field
        label="Players to start"
        value={players}
        onChangeText={setPlayers}
        keyboardType="number-pad"
        error={errors.players}
      />
      <Field
        label="Zone radius (m)"
        value={radius}
        onChangeText={setRadius}
        keyboardType="number-pad"
        error={errors.radius}
      />
      <ToggleRow label="Public replay" value={publicReplay} onChange={setPublicReplay} />
      <Caption muted>Off: only players can watch the replay.</Caption>
      <Row gap="s">
        <Icon name="zone" size={18} tint={color.ink} />
        <Caption muted>
          {m.accuracyM === null
            ? "Finding you. The zone is centred where you stand."
            : `Zone centred on you, within ${Math.round(m.accuracyM)} m.`}
        </Caption>
      </Row>
      {m.error ? <Notice title="Couldn't create the match" detail={m.error} /> : null}
    </Screen>
  );
}

export function Create() {
  const app = useApp();
  useEffect(() => {
    app.startLocating();
    return () => app.endLocating();
  }, [app]);
  return (
    <CreateView
      m={{ accuracyM: app.here?.acc ?? null, busy: app.busy, error: app.error }}
      onCreate={(f) =>
        void app.createMatch({
          stake: f.stake,
          durationMs: f.minutes * 60_000,
          minPlayers: f.minPlayers,
          maxPlayers: 12,
          radiusM: f.radiusM,
          publicReplay: f.publicReplay,
        })
      }
      onBack={() => app.openPage(null)}
    />
  );
}
