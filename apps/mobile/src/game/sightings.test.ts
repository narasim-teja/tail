import { describe, expect, test } from "bun:test";
import {
  beaconTag,
  beaconToken,
  derivePlayerKey,
  deriveTagKey,
  sha256,
  tagMatches,
  tokenToUuid,
  uuidToToken,
} from "@tail/protocol";
import { median, SightingAggregator } from "./sightings";

const km = sha256(new TextEncoder().encode("sightings K_m"));
const kTag = deriveTagKey(km);
const tok = (player: number, epoch: number) =>
  tokenToUuid(beaconToken(kTag, derivePlayerKey(km, player), epoch));

describe("sighting aggregation", () => {
  test("packets of one token in one epoch become one sighting with max, median and count", () => {
    const a = new SightingAggregator(kTag);
    for (const r of [-70, -60, -80, -66]) a.add(5, tok(1, 5), r);
    const [s, ...rest] = a.drain();
    expect(rest).toHaveLength(0);
    expect(s).toMatchObject({ epoch: 5, rssiMax: -60, rssiMed: -68, n: 4 });
  });

  test("the median of an even count rounds toward weaker signal", () => {
    expect(median([-61, -64])).toBe(-63);
    expect(median([-1, -2, -3])).toBe(-2);
  });

  test("tokens from the previous and next epoch pass the tag filter, older ones and strangers do not", () => {
    const a = new SightingAggregator(kTag);
    expect(a.add(5, tok(1, 4), -60)).toBe(true);
    expect(a.add(5, tok(1, 6), -60)).toBe(true);
    expect(a.add(5, tok(1, 3), -60)).toBe(false);
    expect(a.add(5, "0000180F-0000-1000-8000-00805F9B34FB", -40)).toBe(false);
    expect(a.add(5, "not a uuid", -40)).toBe(false);
  });

  test("the tag filter costs three HMACs per epoch, not per packet, and agrees with tagMatches", () => {
    let hmacs = 0;
    const a = new SightingAggregator(kTag, (k, e) => {
      hmacs++;
      return beaconTag(k, e);
    });
    for (let i = 0; i < 100; i++) a.add(5, tok(i % 3, 5), -60);
    expect(hmacs).toBe(3);
    a.add(6, tok(1, 6), -60);
    expect(hmacs).toBe(6);
    for (const [e, t] of [
      [0, tok(1, 0)],
      [0, tok(1, 1)],
      [7, tok(1, 5)],
      [7, tok(1, 8)],
    ] as const)
      expect(new SightingAggregator(kTag).add(e, t, -60)).toBe(tagMatches(kTag, uuidToToken(t), e));
  });

  test("packets without an RSSI reading are not counted", () => {
    const a = new SightingAggregator(kTag);
    expect(a.add(5, tok(1, 5), 127)).toBe(false);
    expect(a.drain()).toEqual([]);
  });

  test("different tokens and epochs stay apart and come out sorted by epoch", () => {
    const a = new SightingAggregator(kTag);
    a.add(6, tok(2, 6), -50);
    a.add(5, tok(1, 5), -55);
    a.add(5, tok(2, 5), -58);
    expect(a.drain().map((s) => s.epoch)).toEqual([5, 5, 6]);
  });

  test("drain empties the aggregator", () => {
    const a = new SightingAggregator(kTag);
    a.add(5, tok(1, 5), -55);
    a.drain();
    expect(a.size).toBe(0);
    expect(a.drain()).toEqual([]);
  });

  test("more than 255 packets are split so the u8 count loses nothing", () => {
    const a = new SightingAggregator(kTag);
    for (let i = 0; i < 300; i++) a.add(5, tok(1, 5), -60);
    expect(a.drain().map((s) => s.n)).toEqual([255, 45]);
  });
});
