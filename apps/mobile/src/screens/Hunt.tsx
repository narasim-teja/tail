import type { IconName } from "@tail/brand";
import { HINT_TEXT_MAX, HintKind, hintPrice, LEAK_CELL_M, LOCK_EPOCHS } from "@tail/protocol";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import MapView, { Marker, Polygon } from "react-native-maps";
import { formatAmount, hintLabel } from "../game/hud";
import type { SessionSnapshot } from "../game/session";
import { useApp } from "../state/app";
import { TrailMarker } from "../ui/brand";
import { Body, Button, Field, Figure, Label, Row, Screen, SegmentBar } from "../ui/kit";
import { color, radius, space } from "../ui/theme";

const M_PER_DEG = 111_320;

const HINT_ICON: Record<HintKind, IconName> = {
  [HintKind.Near]: "near",
  [HintKind.Bearing]: "bearing",
  [HintKind.Trend]: "trend",
};

/** The leaked 100 m grid cell around its centre, as a square on the map. */
function cell(c: { lat: number; lon: number }) {
  const dLat = LEAK_CELL_M / 2 / M_PER_DEG;
  const dLon = LEAK_CELL_M / 2 / (M_PER_DEG * Math.cos((c.lat * Math.PI) / 180));
  return [
    { latitude: c.lat - dLat, longitude: c.lon - dLon },
    { latitude: c.lat - dLat, longitude: c.lon + dLon },
    { latitude: c.lat + dLat, longitude: c.lon + dLon },
    { latitude: c.lat + dLat, longitude: c.lon - dLon },
  ];
}

function status(s: SessionSnapshot): string {
  const parts = [`Epoch ${s.epoch ?? "-"}`, `Sent ${s.seq - s.queued}`];
  if (s.queued > 1) parts.push(`Waiting ${s.queued}`);
  if (s.socket !== "live") parts.push("HUD offline");
  if (s.offline) parts.push(s.carry.kind === "off" ? "No signal" : `No signal, mesh ${s.carry.kind}`);
  if (s.upload.kind === "waiting") parts.push(s.upload.error);
  return parts.join("  ·  ");
}

/** Lock, heat, head, the map with only you (and a leaked cell), the Handler, STRIKE. */
export function Hunt() {
  const app = useApp();
  const session = app.session;
  const [handler, setHandler] = useState(false);
  const [question, setQuestion] = useState("");
  if (!session) return null;
  const s = session.snapshot();
  const hud = s.hud;
  const stake = app.match?.chain?.stake ?? 0n;
  const ask = (kind: HintKind) => {
    session.hint(kind, question);
    setQuestion("");
    setHandler(false);
  };

  return (
    <Screen scroll={false}>
      <Row>
        <Figure label="Target">{hud?.target ?? app.briefing?.keys.target ?? "?"}</Figure>
      </Row>
      <Figure label="Head" icon="head">
        {hud ? formatAmount(hud.head) : "-"}
      </Figure>
      <SegmentBar label="Lock" value={hud?.lock ?? 0} max={LOCK_EPOCHS} tone="lock" />
      <SegmentBar label="Heat" value={hud?.heat ?? 0} max={LOCK_EPOCHS} tone="heat" />

      <View style={st.map}>
        {s.lastFix ? (
          <MapView
            style={StyleSheet.absoluteFill}
            region={{
              latitude: s.lastFix.lat,
              longitude: s.lastFix.lon,
              latitudeDelta: 0.006,
              longitudeDelta: 0.006,
            }}
            showsPointsOfInterests={false}
            // North stays up, so the Trail mark's rotation is the compass heading.
            rotateEnabled={false}
            pitchEnabled={false}
            accessibilityLabel="Map with your position"
          >
            <Marker
              coordinate={{ latitude: s.lastFix.lat, longitude: s.lastFix.lon }}
              anchor={{ x: 0.5, y: 0.5 }}
              accessibilityLabel="You"
            >
              <TrailMarker heading={s.lastFix.heading} />
            </Marker>
            {hud?.leak ? (
              <Polygon
                coordinates={cell(hud.leak)}
                fillColor={`${color.heat}55`}
                strokeColor={color.heat}
                strokeWidth={2}
              />
            ) : null}
          </MapView>
        ) : (
          <Body muted center>
            Finding you.
          </Body>
        )}
      </View>
      {hud?.leak ? <Label>Your target went dark. Last known cell shown.</Label> : null}

      {s.notes.slice(0, 2).map((n) => (
        <Body key={`${n.tMs}-${n.text}`} muted={n.kind === "info"}>
          {n.text}
        </Body>
      ))}
      {hud?.hint ? <Body>{hud.hint.text}</Body> : null}

      {handler ? (
        <View style={st.sheet}>
          <Label>Handler. Paid from your head to your target's.</Label>
          <Field
            label="Question (optional)"
            value={question}
            onChangeText={setQuestion}
            maxLength={HINT_TEXT_MAX}
          />
          <Row>
            {[HintKind.Near, HintKind.Bearing, HintKind.Trend].map((k) => (
              <Button
                key={k}
                kind="plain"
                icon={HINT_ICON[k]}
                title={`${hintLabel[k]} ${formatAmount(hintPrice(stake, k))}`}
                onPress={() => ask(k)}
              />
            ))}
          </Row>
          <Button title="Close" kind="plain" onPress={() => setHandler(false)} />
        </View>
      ) : (
        <Button title="Handler" kind="plain" icon="handler" onPress={() => setHandler(true)} />
      )}

      {hud?.canStrike ? (
        <Button
          title="STRIKE"
          kind="strike"
          icon="strike"
          onPress={() => session.strike()}
          hint="Tags your target"
        />
      ) : null}
      <Label>{status(s)}</Label>
    </Screen>
  );
}

const st = StyleSheet.create({
  map: {
    flex: 1,
    minHeight: 160,
    borderRadius: radius.m,
    overflow: "hidden",
    backgroundColor: color.surfaceSunk,
    justifyContent: "center",
  },
  sheet: {
    backgroundColor: color.surfaceSunk,
    borderColor: color.line,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.l,
    padding: space.l,
    gap: space.m,
  },
});
