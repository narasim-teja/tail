// Per-epoch aggregation of radio sightings into the wire Sighting (TECHNICAL.md 4.3):
//   { epoch, token, rssi_max, rssi_med, n }
// `epoch` is the phone's own epoch when the packet arrived; the referee checks it against the
// batch time and the token's epoch. Each batch carries what arrived since the previous batch;
// the referee adds up n across batches for the same epoch.

import type { Sighting } from "@tail/protocol";
import { beaconTag, toHex, uuidToToken } from "@tail/protocol";

/** CoreBluetooth reports 127 when it has no RSSI for a packet. */
export const RSSI_UNAVAILABLE = 127;

/** Median rounded toward −∞ so it never overstates signal strength (the wire type is i8). */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError("median of nothing");
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] as number) : Math.floor(((s[mid - 1] as number) + (s[mid] as number)) / 2);
}

const clampI8 = (n: number) => Math.max(-128, Math.min(127, Math.round(n)));

interface Row {
  epoch: number;
  token: Uint8Array;
  rssi: number[];
}

export class SightingAggregator {
  private rows = new Map<string, Row>();
  // The tags of e−1, e and e+1 (hex), worked out once per epoch: scanning with duplicates
  // reports many packets a second, and each would otherwise cost three HMACs.
  private window: { epoch: number; tags: Set<string> } | null = null;

  constructor(
    private readonly kTag: Uint8Array,
    private readonly tagOf: (kTag: Uint8Array, epoch: number) => Uint8Array = beaconTag,
  ) {}

  private tagsAround(epoch: number): Set<string> {
    if (this.window?.epoch !== epoch) {
      const tags = [epoch - 1, epoch, epoch + 1]
        .filter((e) => e >= 0)
        .map((e) => toHex(this.tagOf(this.kTag, e)));
      this.window = { epoch, tags: new Set(tags) };
    }
    return this.window.tags;
  }

  /**
   * Records one packet if it carries a token of this match for epochs e−1..e+1. Returns whether
   * it was kept. Strangers' devices never pass the tag filter, so nothing about them is kept.
   */
  add(epoch: number, uuid: string, rssi: number): boolean {
    let token: Uint8Array;
    try {
      token = uuidToToken(uuid);
    } catch {
      return false;
    }
    if (rssi === RSSI_UNAVAILABLE || !this.tagsAround(epoch).has(toHex(token.subarray(0, 4)))) return false;
    const key = `${epoch}:${toHex(token)}`;
    let row = this.rows.get(key);
    if (!row) {
      row = { epoch, token, rssi: [] };
      this.rows.set(key, row);
    }
    row.rssi.push(rssi);
    return true;
  }

  get size(): number {
    return this.rows.size;
  }

  /** Everything recorded so far, as wire Sightings, and clears it. n is capped at 255 (u8). */
  drain(): Sighting[] {
    const out: Sighting[] = [];
    for (const r of this.rows.values()) {
      // A row past 255 packets is split so no sample is lost to the u8 cap.
      for (let i = 0; i < r.rssi.length; i += 255) {
        const part = r.rssi.slice(i, i + 255);
        out.push({
          epoch: r.epoch,
          token: r.token,
          rssiMax: clampI8(Math.max(...part)),
          rssiMed: clampI8(median(part)),
          n: part.length,
        });
      }
    }
    this.rows.clear();
    return out.sort((a, b) => a.epoch - b.epoch || toHex(a.token).localeCompare(toHex(b.token)));
  }
}
