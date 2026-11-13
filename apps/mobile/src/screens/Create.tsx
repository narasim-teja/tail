// New match: stake, length, players, zone size (centred on you), public replay. Picked with
// the thumb, not typed: a few sensible choices each, and the zone drawn live on the map around
// you so the host sees the playing field before anyone stakes.
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useApp } from "../state/app";
import { Icon } from "../ui/brand";
import { Button, Caption, Choice, Notice, Row, Screen, Stepper, Title, ToggleRow } from "../ui/kit";
import { MapPanel } from "../ui/map";
import { color } from "../ui/theme";

export interface CreateModel {
  /** Where you stand (the zone's centre) and how sure the phone is, or null while finding you. */
  here: { lat: number; lon: number; acc: number } | null;
  busy: string | null;
  error: string | null;
  /** The lobby this host already has open, when the relay refused a second one. */
  openLobby: string | null;
}

export interface NewMatchForm {
  stake: bigint;
  minutes: number;
  minPlayers: number;
  radiusM: number;
  publicReplay: boolean;
}

/** USDC has 6 decimals. */
const USDC = 1_000_000n;
const STAKES = [1, 2, 5, 10].map((d) => ({ value: d, label: `$${d}` }));
// Inside the server's 60 s to 3600 s (apps/server/src/routes/matches.ts).
const LENGTHS = [15, 30, 45, 60].map((m) => ({ value: m, label: `${m} min` }));
// The server accepts 50 m and up; these suit a city park.
const ZONES = [200, 400, 800, 1500].map((r) => ({ value: r, label: r < 1000 ? `${r} m` : `${r / 1000} km` }));
/** The server's player bounds. */
const PLAYERS = { min: 3, max: 12 };

export function CreateView({
  m,
  onCreate,
  onOpenLobby,
  onBack,
}: {
  m: CreateModel;
  onCreate: (f: NewMatchForm) => void;
  onOpenLobby: (matchId: string) => void;
  onBack: () => void;
}) {
  const [stake, setStake] = useState(1);
  const [minutes, setMinutes] = useState(30);
  const [players, setPlayers] = useState(3);
  const [radiusM, setRadius] = useState(400);
  const [publicReplay, setPublicReplay] = useState(true);
  const here = m.here;
  const open = m.openLobby;
  return (
    <Screen
      footer={
        <>
          <Button
            title={m.busy ?? `Create, $${stake} each`}
            busy={!!m.busy}
            disabled={!here}
            hint={here ? undefined : "Waiting for your location"}
            onPress={() =>
              onCreate({ stake: BigInt(stake) * USDC, minutes, minPlayers: players, radiusM, publicReplay })
            }
          />
          <Button kind="quiet" symbol="chevron.left" title="Back" onPress={onBack} />
        </>
      }
    >
      <Title>New match</Title>
      <View style={styles.map}>
        <MapPanel
          me={here ? { lat: here.lat, lon: here.lon, heading: null } : null}
          zone={
            here
              ? {
                  zone: { latE7: Math.round(here.lat * 1e7), lonE7: Math.round(here.lon * 1e7), radiusM },
                  safehouses: [],
                }
              : null
          }
          leak={null}
          spanM={radiusM * 2.4}
        />
      </View>
      <Row gap="s">
        <Icon name="zone" size={18} tint={color.ink} />
        <Caption muted>
          {here
            ? `Centred on you, to within ${Math.round(here.acc)} m.`
            : "Finding you. The zone is centred where you stand."}
        </Caption>
      </Row>
      <Choice label="Zone" options={ZONES} value={radiusM} onChange={setRadius} />
      <Choice label="Stake" options={STAKES} value={stake} onChange={setStake} />
      <Choice label="Length" options={LENGTHS} value={minutes} onChange={setMinutes} />
      <Stepper
        label="Players to start"
        value={players}
        min={PLAYERS.min}
        max={PLAYERS.max}
        onChange={setPlayers}
      />
      <Caption muted>{`Up to ${PLAYERS.max} can join.`}</Caption>
      <ToggleRow label="Public replay" value={publicReplay} onChange={setPublicReplay} />
      <Caption muted>{publicReplay ? "Anyone with the link can watch." : "Only players can watch."}</Caption>
      {open ? (
        <>
          <Notice
            title="You already have an open lobby"
            detail="Start it, or let it lapse, before making another."
          />
          <Button kind="secondary" title="Open that lobby" onPress={() => onOpenLobby(open)} />
        </>
      ) : m.error ? (
        <Notice title="Couldn't create the match" detail={m.error} />
      ) : null}
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
      m={{ here: app.here, busy: app.busy, error: app.error, openLobby: app.openLobby }}
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
      onOpenLobby={(id) => void app.openMatch(id)}
      onBack={() => app.openPage(null)}
    />
  );
}

const styles = StyleSheet.create({ map: { height: 200 } });
