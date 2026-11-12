// Offline carry path (TECHNICAL.md 7): when this phone has not reached the relay for
// OFFLINE_CARRY_MS, sealed batches go through the Offline Protocol mesh to the relay's mesh node
// address instead, hopping over Bluetooth through nearby phones. Carriers see only ciphertext
// sealed to the enclave.
//
// Status: the relay runs no mesh node yet, so this is off unless a node address is set in
// Settings, and the app says so. Nothing is reported as delivered unless the SDK reports the
// node received it.
//
// Rules kept here:
// - A fresh SDK identity per match (profile = match id), so addresses do not link across matches.
// - The mesh runs only while this phone is offline, and stops once the relay answers again
//   (stealth: SDK peers learn each other's address on contact).
// - One batch in flight at a time, oldest first. The referee refuses a seq gap, and a mesh can
//   reorder messages, so batch n+1 goes only after the node acknowledged batch n.
// - The message is the exact signed `POST /batch` request, so the node can hand it to the relay
//   unchanged and the relay checks the player's signature as usual.

import { MessagePriority, OfflineProtocol, type ProtocolEvent } from "@offline-protocol/mesh-sdk";
import type { OutboxItem } from "../game/batch";
import { toB64 } from "../lib/b64";
import type { SignedRequest } from "../relay/client";

export const MESH_APP_ID = "tail";

export interface CarryConfig {
  /** The relay's mesh node address (`off1…`). Empty: carry is off. */
  nodeAddress: string;
  /** Optional Offline Protocol internet server, so a carrier with signal can reach the node. */
  serverUrl: string;
}

export type CarryStatus =
  | { kind: "off"; why: string }
  | { kind: "standby" }
  | { kind: "starting" }
  | { kind: "carrying"; seq: number | null; delivered: number }
  | { kind: "error"; message: string };

/** The mesh message for one batch: the signed relay request, verbatim. */
export function carryMessage(req: SignedRequest): string {
  return JSON.stringify({
    v: 1,
    type: "tail/batch",
    path: req.path,
    account: req.account,
    time_ms: req.timeMs,
    sig: toB64(req.sig),
    body: req.body,
  });
}

export interface CarryDeps {
  config: CarryConfig;
  matchId: string;
  /** The oldest batch not yet delivered, and its signed request. */
  head: () => { item: OutboxItem; req: SignedRequest } | null;
  /** The node acknowledged this seq. */
  delivered: (seq: number) => void;
  onChange: () => void;
}

export class MeshCarry {
  status: CarryStatus;
  private protocol: OfflineProtocol | null = null;
  private inFlight: { seq: number; messageId: string } | null = null;
  private deliveredCount = 0;

  constructor(private readonly d: CarryDeps) {
    this.status = d.config.nodeAddress.trim()
      ? { kind: "standby" }
      : { kind: "off", why: "Relay has no mesh node yet." };
  }

  /** Called on every batch tick with the uploader's view of connectivity. */
  async update(offline: boolean): Promise<void> {
    if (this.status.kind === "off") return;
    if (!offline) {
      if (this.protocol) await this.shutdown();
      return;
    }
    if (!this.protocol && this.status.kind !== "starting") await this.startMesh();
    this.sendHead();
  }

  async shutdown(): Promise<void> {
    const p = this.protocol;
    this.protocol = null;
    this.inFlight = null;
    if (this.status.kind !== "off") this.set({ kind: "standby" });
    if (!p) return;
    try {
      await p.stop();
    } finally {
      await p.destroy();
    }
  }

  private set(s: CarryStatus) {
    this.status = s;
    this.d.onChange();
  }

  private async startMesh(): Promise<void> {
    this.set({ kind: "starting" });
    const server = this.d.config.serverUrl.trim();
    try {
      const p = new OfflineProtocol({
        appId: MESH_APP_ID,
        profile: this.d.matchId,
        transports: {
          ble: { enabled: true },
          internet: server
            ? { enabled: true, serverAddress: server, autoReconnect: true }
            : { enabled: false },
          wifiDirect: { enabled: false },
        },
      });
      // Listeners go on before start() so no early event is lost (SDK README).
      p.on("all", (e: ProtocolEvent) => this.onEvent(e));
      await p.start();
      this.protocol = p;
      this.set({ kind: "carrying", seq: null, delivered: this.deliveredCount });
    } catch (e) {
      this.set({ kind: "error", message: (e as Error).message });
    }
  }

  private sendHead(): void {
    const p = this.protocol;
    if (!p || this.inFlight) return;
    const next = this.d.head();
    if (!next) return;
    const seq = next.item.seq;
    void p
      .sendMessage({
        recipient: this.d.config.nodeAddress.trim(),
        content: carryMessage(next.req),
        priority: MessagePriority.High,
      })
      .then(
        (messageId) => {
          this.inFlight = { seq, messageId };
          this.set({ kind: "carrying", seq, delivered: this.deliveredCount });
        },
        (e: Error) => this.set({ kind: "error", message: e.message }),
      );
  }

  private onEvent(e: ProtocolEvent): void {
    const f = this.inFlight;
    if (!f) return;
    if (e.type === "message_delivered" && e.message_id === f.messageId) {
      this.inFlight = null;
      this.deliveredCount++;
      this.d.delivered(f.seq);
      this.set({ kind: "carrying", seq: null, delivered: this.deliveredCount });
      this.sendHead();
    } else if (e.type === "message_failed" && e.message_id === f.messageId) {
      // Retried on the next batch tick; the HTTP path also keeps trying.
      this.inFlight = null;
    }
  }
}
