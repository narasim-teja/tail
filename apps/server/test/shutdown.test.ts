// Stopping the relay: the steps and Starts in flight finish, then every lease this process holds
// goes back, so a restarted relay steps its matches at once rather than LEASE_MS later.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEASE_MS } from "../src/matches.ts";
import { until } from "./fakes.ts";
import { setup, started } from "./harness.ts";

describe("stopping", () => {
  test("drain lets a tick in flight land, then hands back the lease", async () => {
    const env = setup();
    env.referee.tickDelayMs = 50;
    const m = await started(env);
    await until(() => env.referee.inFlight > 0, "a tick in flight");
    const before = env.store.match(m.id)?.tick_no ?? 0;
    await env.matches.drain(5_000);
    expect(env.referee.inFlight).toBe(0);
    expect(env.store.match(m.id)?.tick_no).toBe(before + 1);
    // Another relay process takes the match now.
    expect(env.store.holdLease(m.id, "next-process", Date.now(), LEASE_MS)).toBe(true);
  });

  test("SIGTERM stops the relay process and frees its leases", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tail-relay-stop-"));
    try {
      const db = join(dir, "relay.db");
      const id = "0".repeat(32);
      const child = Bun.spawn(["bun", join(import.meta.dir, "fixtures/signal-relay.ts"), db, id], {
        stdout: "pipe",
        stderr: "inherit",
      });
      const reader = child.stdout.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toBe("ready\n");
      // Read only, so this test never contends with the relay for the write lock.
      const leases = () => {
        const d = new Database(db, { readonly: true });
        try {
          return d.query<{ match_id: string }, []>("SELECT match_id FROM leases").all();
        } finally {
          d.close();
        }
      };
      expect(leases()).toEqual([{ match_id: id }]);
      child.kill("SIGTERM");
      expect(await child.exited).toBe(0);
      expect(leases()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
