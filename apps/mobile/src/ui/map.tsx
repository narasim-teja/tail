// The live map panel: only you (the Trail mark, its trail pointing back along your heading), the
// zone edge dotted, safehouses, and your target's leaked 100 m cell when they go dark. Never any
// other player's position. North stays up so the marker's rotation is a compass heading.

import { LEAK_CELL_M } from "@tail/protocol";
import { StyleSheet, View } from "react-native";
import MapView, { Circle as MapCircle, Marker, Polygon } from "react-native-maps";
import type { Circle, LatLon } from "../tail/geo";
import type { Zone } from "../tail/zone";
import { Icon, TrailMarker } from "./brand";
import { Caption, Eyebrow } from "./kit";
import { alpha, color, radius, space } from "./theme";

const M_PER_DEG = 111_320;

/** The leaked grid cell around its centre, as a square. */
export function cellSquare(c: LatLon) {
  const dLat = LEAK_CELL_M / 2 / M_PER_DEG;
  const dLon = LEAK_CELL_M / 2 / (M_PER_DEG * Math.cos((c.lat * Math.PI) / 180));
  return [
    { latitude: c.lat - dLat, longitude: c.lon - dLon },
    { latitude: c.lat - dLat, longitude: c.lon + dLon },
    { latitude: c.lat + dLat, longitude: c.lon + dLon },
    { latitude: c.lat + dLat, longitude: c.lon - dLon },
  ];
}

const centre = (c: Circle) => ({ latitude: c.latE7 / 1e7, longitude: c.lonE7 / 1e7 });

export function MapPanel({
  me,
  zone,
  leak,
  spanM = 670,
}: {
  me: (LatLon & { heading: number | null }) | null;
  zone: Zone | null;
  leak: LatLon | null;
  /** North-south metres in view; the hunt keeps the default, Create fits the whole zone. */
  spanM?: number;
}) {
  if (!me) {
    return (
      <View style={[styles.well, styles.empty]} accessible accessibilityLabel="Finding your position">
        <Icon name="zone" size={28} tint={color.mute} />
        <Caption muted>Finding you</Caption>
      </View>
    );
  }
  return (
    <View style={styles.well}>
      <MapView
        style={StyleSheet.absoluteFill}
        region={{
          latitude: me.lat,
          longitude: me.lon,
          latitudeDelta: spanM / M_PER_DEG,
          longitudeDelta: spanM / M_PER_DEG,
        }}
        rotateEnabled={false}
        pitchEnabled={false}
        showsPointsOfInterests={false}
        showsCompass={false}
        toolbarEnabled={false}
        accessibilityLabel={
          leak ? "Map: you, the zone, and your target's last seen area" : "Map: you and the zone"
        }
      >
        {zone ? (
          <MapCircle
            center={centre(zone.zone)}
            radius={zone.zone.radiusM}
            strokeColor={color.ink}
            strokeWidth={2}
            lineDashPattern={[2, 6]}
            fillColor="transparent"
          />
        ) : null}
        {zone?.safehouses.map((h) => (
          <Marker
            key={`${h.latE7}:${h.lonE7}`}
            coordinate={centre(h)}
            anchor={{ x: 0.5, y: 0.5 }}
            accessibilityLabel="Safehouse"
          >
            <View style={styles.pin}>
              <Icon name="safehouse" size={18} tint={color.ink} />
            </View>
          </Marker>
        ))}
        {leak ? (
          <>
            <Polygon
              coordinates={cellSquare(leak)}
              fillColor={alpha(color.ink, 0.16)}
              strokeColor={color.ink}
              strokeWidth={2}
            />
            <Marker
              coordinate={{ latitude: leak.lat, longitude: leak.lon }}
              anchor={{ x: 0.5, y: 0.5 }}
              accessibilityLabel="Target last seen here"
            >
              <View style={styles.leakTag}>
                <Icon name="dark" size={14} tint={color.paper} />
                <Eyebrow style={{ color: color.paper }}>Last seen</Eyebrow>
              </View>
            </Marker>
          </>
        ) : null}
        <Marker
          coordinate={{ latitude: me.lat, longitude: me.lon }}
          anchor={{ x: 0.5, y: 0.5 }}
          accessibilityLabel="You"
        >
          <View style={styles.halo}>
            <TrailMarker heading={me.heading} size={36} />
          </View>
        </Marker>
      </MapView>
    </View>
  );
}

const styles = StyleSheet.create({
  well: { flex: 1, minHeight: 112, borderRadius: radius.l, overflow: "hidden", backgroundColor: color.sand },
  empty: { alignItems: "center", justifyContent: "center", gap: space.s },
  pin: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: color.paper,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: color.ink,
  },
  leakTag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: color.ink,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  // A paper disc behind the mark keeps persimmon readable on any map tile.
  halo: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: alpha(color.paper, 0.85),
    alignItems: "center",
    justifyContent: "center",
  },
});
