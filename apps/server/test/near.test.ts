// The relay's NEAR calls in the tick loop have deadlines: an RPC node that takes the connection
// and never answers fails the call, so the step fails and the next one tries again.

import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { NearChain, nearKeyPair } from "../src/near.ts";
import { quietLog } from "./fakes.ts";

describe("NEAR RPC deadlines", () => {
  test("a view and an apply on a node that never answers fail at their deadline", async () => {
    // Takes every connection and never writes a byte back.
    const silent = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    try {
      const chain = new NearChain(
        {
          rpcUrl: `http://127.0.0.1:${silent.port}`,
          relayAccount: "relay.testnet",
          relayPrivateKey: nearKeyPair(ed25519.utils.randomSecretKey()),
          contract: "tail.relay.testnet",
          token: "usdc.fakes.testnet",
          deadlines: { viewMs: 200, applyMs: 300 },
        },
        quietLog(),
      );
      const t0 = performance.now();
      await expect(chain.getMatch("00".repeat(16))).rejects.toThrow("get_match did not answer within 200 ms");
      await expect(chain.apply([new Uint8Array(8)], [])).rejects.toThrow(
        "apply did not answer within 300 ms",
      );
      expect(performance.now() - t0).toBeLessThan(2_000);
    } finally {
      silent.stop(true);
    }
  });
});
