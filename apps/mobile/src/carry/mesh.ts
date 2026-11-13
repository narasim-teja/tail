// Mesh carry (TECHNICAL.md 7, packages/protocol carry.ts): reports keep reaching the relay when
// this phone has no signal, through nearby TAIL phones that have.
//
// There is no relay mesh node. Every phone in a match runs the Offline Protocol mesh (behind the
// Settings switch, off by default until the Bluetooth coexistence measurement below) and plays
// one of two roles at any moment:
//
//   - offline (no relay contact for OFFLINE_CARRY_MS): it seals each signed request it could not
//     send with `sealCarry` to the relay's box key (GET /carry/key, fetched at briefing while
//     online) and hands the envelope to its mesh neighbours;
//   - online (the forwarder role): it POSTs an envelope it received to `/carry` unchanged and
//     sends the relay's answer `{ack, hud?}` back to the phone it came from.
//
// The offline phone treats a report as delivered only once the relay's CarryAck verifies under
// the relay's ack key over its own envelope; the HUD that comes back is sealed and signed like
// any other and is opened the same way (game/hud.ts). The session's outbox stays the one owner
// of the reports: HTTP and the mesh both report delivery to it by batch hash, so a report
// delivered both ways counts once (game/outbox.ts).
//
// What a carrier learns: a fixed-size ciphertext (4144 bytes) and the sender's mesh address. No
// account, no match id, no request kind or length is in the clear. Mesh addresses come from a
// per-match SDK profile (`meshProfile`), so they do not link one match to the next, and the
// profile is wiped when the hunt stops. Two things remain:
//   - a mesh link tells both phones that some TAIL phone is in Bluetooth range (F14). The UI
//     never shows neighbours; a modified app could, and App Attest is what keeps those out;
//   - Bluetooth coexistence is not measured. An iPhone advertises about 28 bytes in the
//     foreground, and TAIL's beacon token is a 128-bit service UUID (18 of them). If the SDK's
//     own advertisement takes that room, iOS moves the token to the overflow area, where other
//     phones' scans for TAIL tokens may not see it, and contact (and so every lock) is lost.
//     That is why the switch is off by default.

import {
  type CarryAck,
  concat,
  decodeCarryAck,
  equal,
  sealCarry,
  sha256,
  toHex,
  utf8,
  verifyCarryAck,
} from "@tail/protocol";
import { fromB64, toB64 } from "../lib/b64";
import type { CarryKey, CarryReply, SignedRequest } from "../relay/client";
import { RelayClient } from "../relay/client";

export const MESH_APP_ID = "tail";

/**
 * The SDK profile for one match: a fresh mesh identity per match, named by a hash so the match
 * id is not handed to the SDK's storage either.
 */
export const meshProfile = (matchId: Uint8Array) =>
  `m${toHex(sha256(concat(utf8("tail/mesh-profile"), matchId))).slice(0, 31)}`;

/** The part of the Offline Protocol SDK the carry path uses (carry/sdk.ts; tests pass a fake). */
export interface MeshLink {
  start(on: {
    message: (sender: string, content: string) => void;
    neighbour: (peer: string) => void;
    lost: (peer: string) => void;
  }): Promise<void>;
  send(peer: string, content: string): Promise<void>;
  /** Stops the mesh and erases this match's mesh identity. */
  stop(): Promise<void>;
}

/** Seals one signed request for the relay; carriers see only this. */
export const carryEnvelope = (relayBoxPk: Uint8Array, req: SignedRequest) =>
  sealCarry(relayBoxPk, RelayClient.carryRequest(req));

export const envelopeDigest = (envelope: Uint8Array) => sha256(envelope);

// ── Mesh messages ──────────────────────────────────────────────────────────────────────────
// A request: {"v":1,"e":<envelope b64>}. A reply: {"v":1,"d":<SHA256(envelope) b64>,
// "a":<CarryAck b64, as the relay sent it>,"h":<sealed HUD b64> or null}. Nothing else.

export type MeshMessage =
  | { kind: "request"; envelope: Uint8Array }
  | { kind: "reply"; digest: Uint8Array; ack: Uint8Array; hud: Uint8Array | null };

export function encodeMeshMessage(m: MeshMessage): string {
  return m.kind === "request"
    ? JSON.stringify({ v: 1, e: toB64(m.envelope) })
    : JSON.stringify({ v: 1, d: toB64(m.digest), a: toB64(m.ack), h: m.hud ? toB64(m.hud) : null });
}

export function decodeMeshMessage(text: string): MeshMessage | null {
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    if (o["v"] !== 1) return null;
    if (typeof o["e"] === "string") return { kind: "request", envelope: fromB64(o["e"]) };
    if (typeof o["d"] === "string" && typeof o["a"] === "string") {
      const h = o["h"];
      return {
        kind: "reply",
        digest: fromB64(o["d"]),
        ack: fromB64(o["a"]),
        hud: typeof h === "string" ? fromB64(h) : null,
      };
    }
  } catch {
    return null;
  }
  return null;
}

export type CarryStatus =
  | { kind: "off"; why: string }
  | { kind: "starting" }
  /** `carried`: your reports the relay confirmed through the mesh; `forwarded`: others' you passed on. */
  | { kind: "on"; carried: number; forwarded: number }
  | { kind: "error"; message: string };

/** A verified answer to one of this phone's own envelopes. */
export interface CarryDelivery {
  digest: Uint8Array;
  ack: CarryAck;
  hud: Uint8Array | null;
}

export interface MeshCarryDeps {
  link: MeshLink;
  key: CarryKey;
  /** True while this phone reaches the relay itself: it forwards for others then. */
  online: () => boolean;
  /** POST /carry with someone's envelope, unchanged. */
  forward: (envelope: Uint8Array) => Promise<CarryReply>;
  /** Called once per own envelope whose receipt verified. */
  delivered: (d: CarryDelivery) => void;
  onChange: () => void;
}

/** Own envelopes waiting for a receipt; older ones are dropped (the outbox still holds them). */
const MAX_OWN = 8;
/** Replies remembered per envelope digest, so an envelope heard twice is forwarded once. */
const MAX_FORWARDED = 64;

export class MeshCarry {
  status: CarryStatus = { kind: "starting" };
  private readonly neighbours = new Set<string>();
  private readonly own = new Map<string, { envelope: Uint8Array; triedWith: Set<string> }>();
  private readonly replies = new Map<string, Promise<string | null>>();
  private carried = 0;
  private forwarded = 0;
  private running = false;

  constructor(private readonly d: MeshCarryDeps) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.set({ kind: "starting" });
    try {
      await this.d.link.start({
        message: (sender, content) => this.onMessage(sender, content),
        neighbour: (peer) => {
          this.neighbours.add(peer);
          this.offerAll();
        },
        lost: (peer) => this.neighbours.delete(peer),
      });
      this.set(this.onStatus());
    } catch (e) {
      this.running = false;
      this.set({ kind: "error", message: (e as Error).message });
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.neighbours.clear();
    this.own.clear();
    this.replies.clear();
    this.set({ kind: "off", why: "Hunt stopped." });
    await this.d.link.stop();
  }

  /** Offers one of this phone's envelopes to every neighbour that has not had it yet. */
  send(envelope: Uint8Array): void {
    const key = toHex(envelopeDigest(envelope));
    if (!this.own.has(key)) {
      this.own.set(key, { envelope, triedWith: new Set() });
      while (this.own.size > MAX_OWN) this.own.delete(this.own.keys().next().value as string);
    }
    this.offerAll();
  }

  /** The relay got this envelope some other way (HTTP): stop offering it. */
  forget(envelope: Uint8Array): void {
    this.own.delete(toHex(envelopeDigest(envelope)));
  }

  private onStatus(): CarryStatus {
    return { kind: "on", carried: this.carried, forwarded: this.forwarded };
  }

  private set(s: CarryStatus): void {
    this.status = s;
    this.d.onChange();
  }

  private offerAll(): void {
    if (!this.running) return;
    for (const own of this.own.values())
      for (const peer of this.neighbours) {
        if (own.triedWith.has(peer)) continue;
        own.triedWith.add(peer);
        this.d.link
          .send(peer, encodeMeshMessage({ kind: "request", envelope: own.envelope }))
          .catch(() => own.triedWith.delete(peer));
      }
  }

  private onMessage(sender: string, content: string): void {
    if (!this.running) return;
    const m = decodeMeshMessage(content);
    if (!m) return;
    if (m.kind === "request") void this.forwardFor(sender, m.envelope);
    else this.onReply(m);
  }

  /** Forwarder role: only while this phone reaches the relay itself. */
  private async forwardFor(sender: string, envelope: Uint8Array): Promise<void> {
    if (!this.d.online()) return;
    const key = toHex(envelopeDigest(envelope));
    let reply = this.replies.get(key);
    if (!reply) {
      reply = this.d.forward(envelope).then(
        (r) => {
          this.forwarded++;
          this.set(this.onStatus());
          return encodeMeshMessage({
            kind: "reply",
            digest: envelopeDigest(envelope),
            ack: r.ackBytes,
            hud: r.hud,
          });
        },
        () => null,
      );
      this.replies.set(key, reply);
      while (this.replies.size > MAX_FORWARDED)
        this.replies.delete(this.replies.keys().next().value as string);
    }
    const text = await reply;
    // A failed forward is forgotten, so the next copy of the envelope is tried again.
    if (text === null) {
      this.replies.delete(key);
      return;
    }
    if (this.running) await this.d.link.send(sender, text).catch(() => undefined);
  }

  /** A reply counts only for an envelope of ours whose receipt the relay's ack key signed. */
  private onReply(m: Extract<MeshMessage, { kind: "reply" }>): void {
    const key = toHex(m.digest);
    const own = this.own.get(key);
    if (!own || !equal(envelopeDigest(own.envelope), m.digest)) return;
    let ack: CarryAck;
    try {
      ack = decodeCarryAck(m.ack);
    } catch {
      return;
    }
    if (!verifyCarryAck(this.d.key.ackPk, own.envelope, ack)) return;
    this.own.delete(key);
    this.carried++;
    this.set(this.onStatus());
    this.d.delivered({ digest: m.digest, ack, hud: m.hud });
  }
}
