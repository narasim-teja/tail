// New match: stake, length, players, zone size (centred on you), who can join (everyone, or only
// players with a record on their Dossier), public replay (off unless the host turns it on). Picked with
// the thumb, not typed: a few sensible choices each, and the zone drawn live on the map around
// you so the host sees the playing field before anyone stakes.
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useApp } from "../state/app";
import {
  belowRule,
  boundRequires,
  type DossierRecord,
  REQUIRE,
  type Requires,
  recordText,
  ruleText,
} from "../tail/requires";
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
  /** The host's own Dossier counts; null while unknown. The host joins too, so the rule applies. */
  record: DossierRecord | null;
}

export interface NewMatchForm {
  stake: bigint;
  minutes: number;
  minPlayers: number;
  radiusM: number;
  publicReplay: boolean;
  /** Null: anyone may join. */
  requires: Requires | null;
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
const WHO = [
  { value: "everyone", label: "Everyone" },
  { value: "record", label: "Players with a record" },
] as const;

export function CreateView({
  m,
  onCreate,
  onOpenLobby,
  onBack,
  initialRule = null,
}: {
  m: CreateModel;
  onCreate: (f: NewMatchForm) => void;
  onOpenLobby: (matchId: string) => void;
  onBack: () => void;
  /** Who can join when the form opens; null is Everyone (the design preview sets a rule). */
  initialRule?: Requires | null;
}) {
  const [stake, setStake] = useState(1);
  const [minutes, setMinutes] = useState(30);
  const [players, setPlayers] = useState(3);
  const [radiusM, setRadius] = useState(400);
  // Private unless the host chooses otherwise: a replay shows every player's location trail, so
  // publishing it is a choice the host makes, not the default.
  const [publicReplay, setPublicReplay] = useState(false);
  const [who, setWho] = useState<(typeof WHO)[number]["value"]>(initialRule ? "record" : "everyone");
  const [rule, setRule] = useState<Requires>(initialRule ?? { minMatches: 1, minSurvived: 0 });
  const requires = who === "record" ? rule : null;
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
              onCreate({
                stake: BigInt(stake) * USDC,
                minutes,
                minPlayers: players,
                radiusM,
                publicReplay,
                requires,
              })
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
      <Choice label="Who can join" options={WHO} value={who} onChange={setWho} />
      {requires ? (
        <>
          <Stepper
            label="Matches played, at least"
            value={requires.minMatches}
            min={REQUIRE.min}
            max={REQUIRE.max}
            onChange={(n) => setRule(boundRequires({ ...requires, minMatches: n }))}
          />
          <Stepper
            label="Matches survived, at least"
            value={requires.minSurvived}
            min={0}
            max={requires.minMatches}
            onChange={(n) => setRule(boundRequires({ ...requires, minSurvived: n }))}
          />
          <Caption muted>{`Players need ${ruleText(requires)}. Only matches that paid out count.`}</Caption>
          {m.record && belowRule(m.record, requires) ? (
            <Notice
              title="Your record is below this, so you couldn't join your own lobby."
              detail={recordText(m.record)}
            />
          ) : m.record ? (
            <Caption muted>{`${recordText(m.record)} You join too, so it applies to you.`}</Caption>
          ) : null}
        </>
      ) : (
        <Caption muted>Anyone with the code can join.</Caption>
      )}
      <ToggleRow label="Public replay" value={publicReplay} onChange={setPublicReplay} />
      <Caption muted>
        {publicReplay
          ? "Anyone with the link sees every player's trail on the map."
          : "Only this match's players can watch the replay."}
      </Caption>
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
    void app.readRecord();
    return () => app.endLocating();
  }, [app]);
  return (
    <CreateView
      m={{ here: app.here, busy: app.busy, error: app.error, openLobby: app.openLobby, record: app.record }}
      onCreate={(f) =>
        void app.createMatch({
          stake: f.stake,
          durationMs: f.minutes * 60_000,
          minPlayers: f.minPlayers,
          maxPlayers: 12,
          radiusM: f.radiusM,
          publicReplay: f.publicReplay,
          requires: f.requires,
        })
      }
      onOpenLobby={(id) => void app.openMatch(id)}
      onBack={() => app.openPage(null)}
    />
  );
}

const styles = StyleSheet.create({ map: { height: 200 } });
