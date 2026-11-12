// The 3D stage: MapLibre with the dusk style, deck.gl interleaved in the same WebGL context so
// buildings hide what is behind them. The film loop calls `frame()` every animation frame.

import { MapboxOverlay } from "@deck.gl/mapbox";
import type { PickingInfo } from "deck.gl";
import * as maplibregl from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { useEffect, useImperativeHandle, useRef } from "react";
import { shot } from "./camera.ts";
import type { Frame } from "./frame.ts";
import { groundLayers, peopleLayers, tripsOf } from "./layers.ts";
import { mapStyle } from "./mapStyle.ts";
import type { SceneHandle, SceneProps } from "./scene.ts";

const ORBIT_DEG_PER_S = 1.4;

// MapLibre 6 loads its tile worker from beside its own module, which a bundler moves; hand it
// the worker Vite built instead.
maplibregl.setWorkerUrl(workerUrl);

export function Scene3D({
  match,
  play,
  reduced,
  insets,
  onFail,
  onPick,
  onPlace,
  ref,
}: SceneProps & { ref: React.Ref<SceneHandle> }) {
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  const trips = useRef(tripsOf(match));
  const cam = useRef({ bearing: -28, key: "", ready: false });
  const live = useRef({ reduced, insets, onPick });
  live.current = { reduced, insets, onPick };

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: el,
        style: mapStyle(),
        center: [match.zone.lon, match.zone.lat],
        zoom: 16,
        pitch: 50,
        bearing: -28,
        maxPitch: 72,
        attributionControl: false,
        canvasContextAttributes: { antialias: true },
      });
    } catch (e) {
      onFail(e instanceof Error ? e.message : String(e));
      return;
    }
    // deck.gl 9.4 reads `map.transform` (near/far planes, height) when it draws interleaved;
    // MapLibre 6 keeps the transform on its camera. Expose it where deck.gl looks.
    if (!("transform" in map)) {
      const camera = (map as unknown as { _camera?: { transform?: unknown } })._camera;
      Object.defineProperty(map, "transform", { configurable: true, get: () => camera?.transform });
    }
    const overlay = new MapboxOverlay({
      interleaved: true,
      layers: [],
      onHover: (info: PickingInfo) => {
        map.getCanvas().style.cursor = info.picked ? "pointer" : "";
      },
    });
    map.addControl(overlay);
    // On a phone the bottom belongs to the timeline; credit the map at the top instead.
    map.addControl(
      new maplibregl.AttributionControl({ compact: true }),
      el.clientWidth < 768 ? "top-right" : "bottom-right",
    );
    map.on("load", () => {
      cam.current.ready = true;
      // Compact attribution opens expanded; on a phone it would sit on the title.
      if (el.clientWidth < 768)
        el.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
    });
    // The film never lets the map go idle, so look for the park name as tiles arrive.
    const lookForPlace = (e: maplibregl.MapSourceDataEvent) => {
      if (e.sourceId !== "omt" || !e.isSourceLoaded) return;
      const name = placeName(map, match.zone.lon, match.zone.lat, match.zone.radiusM);
      if (name) {
        onPlace?.(name);
        map.off("sourcedata", lookForPlace);
      }
    };
    map.on("sourcedata", lookForPlace);
    // Any move the viewer makes hands them the camera until they press Follow.
    const take = (e: { originalEvent?: unknown }) => {
      if (e.originalEvent) play.set({ camera: "free" });
    };
    map.on("dragstart", take);
    map.on("rotatestart", take);
    map.on("pitchstart", take);
    map.on("zoomstart", take);
    map.on("webglcontextlost", () => onFail("WebGL context lost"));
    mapRef.current = map;
    overlayRef.current = overlay;
    return () => {
      map.remove();
      mapRef.current = null;
      overlayRef.current = null;
    };
  }, [match, play, onFail, onPlace]);

  useImperativeHandle(
    ref,
    (): SceneHandle => ({
      frame(f: Frame, dt: number) {
        const map = mapRef.current;
        const overlay = overlayRef.current;
        if (!map || !overlay || !cam.current.ready) return;
        const { reduced: rm, insets: pad } = live.current;
        const pick = (info: PickingInfo) => {
          const o = info.object as { index?: number; hunter?: number; target?: number } | undefined;
          if (info.layer?.id === "heads" && o?.index !== undefined)
            live.current.onPick({ kind: "player", index: o.index });
          if (info.layer?.id === "lock-line" && o?.hunter !== undefined && o.target !== undefined)
            live.current.onPick({ kind: "contact", hunter: o.hunter, target: o.target });
        };
        overlay.setProps({
          layers: [
            ...groundLayers(match, f, trips.current),
            ...peopleLayers(f, { reduced: rm, onPick: pick }),
          ],
        });
        const s = play.get();
        if (s.camera !== "follow") return;
        const c = map.getContainer();
        const viewMin = Math.max(
          240,
          Math.min(c.clientWidth - pad.right - pad.left, c.clientHeight - pad.bottom - pad.top),
        );
        const target = shot(match, f, s.follow, viewMin);
        const padding = { top: pad.top, bottom: pad.bottom, left: pad.left, right: pad.right };
        if (rm) {
          // Reduced motion: no flights and no orbit. Cut when the subject changes or drifts off.
          const pt = map.project(target.center);
          const w = c.clientWidth;
          const h = c.clientHeight;
          const off =
            pt.x < w * 0.2 || pt.x > w * 0.8 - pad.right || pt.y < h * 0.2 || pt.y > h * 0.8 - pad.bottom;
          if (target.key !== cam.current.key || off) {
            cam.current.key = target.key;
            map.jumpTo({ center: target.center, zoom: target.zoom, pitch: 52, bearing: -20, padding });
          }
          return;
        }
        // Exponential ease-out towards the shot: fast to start, settling without overshoot.
        const k = 1 - Math.exp(-dt / 650);
        const kz = 1 - Math.exp(-dt / 1100);
        const cur = map.getCenter();
        cam.current.bearing += (ORBIT_DEG_PER_S * dt) / 1000;
        map.jumpTo({
          center: [cur.lng + (target.center[0] - cur.lng) * k, cur.lat + (target.center[1] - cur.lat) * k],
          zoom: map.getZoom() + (target.zoom - map.getZoom()) * kz,
          pitch:
            map.getPitch() +
            ((target.key === "zone" ? 42 : c.clientWidth < 640 ? 52 : 60) - map.getPitch()) * kz,
          bearing: cam.current.bearing,
          padding,
        });
        cam.current.key = target.key;
      },
      resync() {
        const map = mapRef.current;
        if (map) cam.current.bearing = map.getBearing();
      },
    }),
    [match, play],
  );

  // MapLibre's own CSS makes its container position: relative, so it sits inside a sized box.
  return (
    <div className="absolute inset-0 z-map" aria-hidden="true">
      <div ref={box} className="size-full" />
    </div>
  );
}

/** The named park nearest the zone's centre (OpenMapTiles puts city parks in `poi`). */
function placeName(map: maplibregl.Map, lon: number, lat: number, radiusM: number): string | null {
  const kx = 111_320 * Math.cos((lat * Math.PI) / 180);
  let best: { name: string; d: number } | null = null;
  for (const f of map.querySourceFeatures("omt", { sourceLayer: "poi" })) {
    if (f.properties?.["class"] !== "park" || f.geometry.type !== "Point") continue;
    const name = f.properties["name:en"] ?? f.properties["name"];
    if (typeof name !== "string" || !name) continue;
    const [x, y] = f.geometry.coordinates as [number, number];
    const d = Math.hypot((x - lon) * kx, (y - lat) * 111_132);
    if (d <= radiusM && (!best || d < best.d)) best = { name, d };
  }
  return best?.name ?? null;
}
