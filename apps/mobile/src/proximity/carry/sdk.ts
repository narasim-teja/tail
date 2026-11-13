// The Offline Protocol SDK behind carry/mesh.ts's MeshLink. Bluetooth only: a carrier with signal
// reaches the relay over its own HTTP (`POST /carry`), so the SDK's internet transport is not
// used. The SDK encrypts each message to its recipient on top of the envelope's own sealing.

import { MessagePriority, OfflineProtocol, type ProtocolEvent } from "@offline-protocol/mesh-sdk";
import { MESH_APP_ID, type MeshLink } from "./mesh";

export function offlineProtocolLink(profile: string): MeshLink {
  let p: OfflineProtocol | null = null;
  return {
    async start(on) {
      const proto = new OfflineProtocol({
        appId: MESH_APP_ID,
        profile,
        transports: { ble: { enabled: true }, internet: { enabled: false }, wifiDirect: { enabled: false } },
      });
      // Listeners go on before start() so no early event is lost (SDK README).
      proto.on("all", (e: ProtocolEvent) => {
        if (e.type === "message_received" && e.app_id === MESH_APP_ID) on.message(e.sender, e.content);
        else if (e.type === "neighbor_discovered") on.neighbour(e.peer_id);
        else if (e.type === "neighbor_lost") on.lost(e.peer_id);
      });
      await proto.start();
      p = proto;
    },
    async send(peer, content) {
      if (!p) throw new Error("mesh is not running");
      await p.sendMessage({ recipient: peer, content, priority: MessagePriority.High });
    },
    async stop() {
      const proto = p;
      p = null;
      if (!proto) return;
      try {
        await proto.stop();
      } finally {
        await proto.destroy();
        // The identity was for this match only; nothing about it should outlive the hunt.
        await proto.wipePersistedState(MESH_APP_ID, profile);
      }
    },
  };
}
