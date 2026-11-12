// The base map: OpenFreeMap's OpenMapTiles vector tiles (no key) drawn in TAIL's dusk palette.
// Only what the game needs is drawn: ground, park, water, walking paths, streets and buildings
// in 3D, with a few quiet labels. Everything else in the tiles is left out.

import type { ExpressionSpecification, StyleSpecification } from "maplibre-gl";
import { css } from "../lib/color.ts";
import { palette as p } from "./palette.ts";

export const TILES_URL = "https://tiles.openfreemap.org/planet";
const FONT = ["Noto Sans Regular"];

const isPath: ExpressionSpecification = ["match", ["get", "class"], ["path", "pedestrian"], true, false];

export function mapStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    sources: {
      omt: { type: "vector", url: TILES_URL, attribution: "© OpenStreetMap contributors · OpenFreeMap" },
    },
    sky: {
      "sky-color": css(p.sky),
      "horizon-color": css(p.horizon),
      "fog-color": css(p.land),
      "sky-horizon-blend": 0.6,
      "horizon-fog-blend": 0.7,
      "fog-ground-blend": 0.85,
      "atmosphere-blend": 0,
    },
    light: { anchor: "viewport", color: css(p.duskInk), intensity: 0.32, position: [1.3, 205, 35] },
    layers: [
      { id: "land", type: "background", paint: { "background-color": css(p.land) } },
      {
        id: "landuse",
        type: "fill",
        source: "omt",
        "source-layer": "landuse",
        filter: ["match", ["get", "class"], ["cemetery", "grass", "pitch", "playground"], true, false],
        paint: { "fill-color": css(p.wood), "fill-opacity": 0.7 },
      },
      {
        id: "park",
        type: "fill",
        source: "omt",
        "source-layer": "park",
        paint: { "fill-color": css(p.park), "fill-outline-color": css(p.parkEdge) },
      },
      {
        id: "landcover",
        type: "fill",
        source: "omt",
        "source-layer": "landcover",
        filter: ["match", ["get", "class"], ["grass", "wood"], true, false],
        paint: {
          "fill-color": ["match", ["get", "class"], "wood", css(p.wood), css(p.park)],
          "fill-opacity": 0.85,
        },
      },
      {
        id: "water",
        type: "fill",
        source: "omt",
        "source-layer": "water",
        filter: ["!=", ["get", "brunnel"], "tunnel"],
        paint: { "fill-color": css(p.water) },
      },
      {
        id: "water-edge",
        type: "line",
        source: "omt",
        "source-layer": "water",
        paint: { "line-color": css(p.waterEdge), "line-width": 1 },
      },
      {
        id: "road-area",
        type: "fill",
        source: "omt",
        "source-layer": "transportation",
        filter: ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false],
        paint: { "fill-color": css(p.road), "fill-opacity": 0.6 },
      },
      {
        id: "roads",
        type: "line",
        source: "omt",
        "source-layer": "transportation",
        filter: [
          "all",
          ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false],
          ["!", isPath],
          ["!=", ["get", "brunnel"], "tunnel"],
          ["match", ["get", "class"], ["rail", "transit", "ferry"], false, true],
        ],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": [
            "match",
            ["get", "class"],
            ["primary", "secondary", "tertiary", "trunk", "motorway"],
            css(p.roadMajor),
            css(p.road),
          ],
          "line-width": ["interpolate", ["exponential", 1.6], ["zoom"], 13, 1, 16, 6, 19, 30],
        },
      },
      {
        id: "paths",
        type: "line",
        source: "omt",
        "source-layer": "transportation",
        filter: ["all", ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false], isPath],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": css(p.path),
          "line-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0.3, 17, 0.5],
          "line-width": ["interpolate", ["exponential", 1.6], ["zoom"], 14, 0.5, 17, 1.4, 19, 3.6],
        },
      },
      {
        id: "buildings",
        type: "fill-extrusion",
        source: "omt",
        "source-layer": "building",
        filter: ["!", ["has", "hide_3d"]],
        paint: {
          "fill-extrusion-color": [
            "interpolate",
            ["linear"],
            ["coalesce", ["get", "render_height"], 10],
            0,
            css(p.building),
            120,
            css(p.buildingTop),
          ],
          "fill-extrusion-height": ["coalesce", ["get", "render_height"], 10],
          "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
          "fill-extrusion-opacity": 0.92,
          "fill-extrusion-vertical-gradient": true,
        },
      },
      {
        id: "water-name",
        type: "symbol",
        source: "omt",
        "source-layer": "water_name",
        layout: {
          "text-field": ["get", "name"],
          "text-font": FONT,
          "text-size": 12,
          "text-letter-spacing": 0.04,
        },
        paint: {
          "text-color": css(p.waterEdge, 1),
          "text-halo-color": css(p.water),
          "text-halo-width": 1,
        },
      },
      {
        id: "street-name",
        type: "symbol",
        source: "omt",
        "source-layer": "transportation_name",
        minzoom: 16,
        filter: ["match", ["get", "class"], ["primary", "secondary", "tertiary"], true, false],
        layout: {
          "symbol-placement": "line",
          "text-field": ["get", "name"],
          "text-font": FONT,
          "text-size": 11.5,
          "text-letter-spacing": 0.06,
        },
        paint: {
          "text-color": css(p.label),
          "text-halo-color": css(p.labelHalo),
          "text-halo-width": 1.2,
          "text-opacity": 0.75,
        },
      },
      {
        id: "poi-name",
        type: "symbol",
        source: "omt",
        "source-layer": "poi",
        minzoom: 16.8,
        // Only the places a player would name: the park, the burying ground. No shops or stops.
        filter: ["all", ["has", "name"], ["match", ["get", "class"], ["park", "cemetery"], true, false]],
        layout: {
          "text-field": ["get", "name"],
          "text-font": FONT,
          "text-size": 11,
          "text-max-width": 8,
          "text-optional": true,
        },
        paint: {
          "text-color": css(p.label),
          "text-halo-color": css(p.labelHalo),
          "text-halo-width": 1.2,
          "text-opacity": 0.85,
        },
      },
    ],
  };
}
