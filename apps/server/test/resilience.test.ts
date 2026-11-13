// The relay when the referee is slow or gone: the guard that stops sending calls into a dead
// referee and probes for its return, and the device table that lets enrolment finish without it.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db.ts";
import { GuardedReferee, PROBE_MS, RefereeError, RefereeUnavailableError } from "../src/referee.ts";
import { FakeReferee } from "./fakes.ts";

/** A referee whose pubkeys call fails (transport) or refuses on demand. */
function flaky() {
  const inner = new FakeReferee();
  const mode: { next: "ok" | "fail" | "refuse" } = { next: "ok" };
  const real = inner.pubkeys.bind(inner);
  inner.pubkeys = async () => {
    if (mode.next === "fail") throw new RefereeError("pubkeys", "HTTP 524, not JSON", false);
    if (mode.next === "refuse") throw new RefereeError("pubkeys", "no", true);
    return real();
  };
  return { inner, mode };
}

describe("the referee guard", () => {
  test("two transport failures mark it down; then calls fail at once without reaching it", async () => {
    let now = 1_000;
    const { inner, mode } = flaky();
    const g = new GuardedReferee(inner, "outlayer", () => now);
    mode.next = "fail";
    await expect(g.pubkeys()).rejects.toThrow("524");
    expect(g.health().status).toBe("unknown");
    await expect(g.pubkeys()).rejects.toThrow("524");
    expect(g.health().status).toBe("down");
    const before = inner.calls.length;
    now += 1_000;
    await expect(g.pubkeys()).rejects.toBeInstanceOf(RefereeUnavailableError);
    expect(inner.calls.length).toBe(before);
  });

  test("while down, one call per probe interval goes through, and an answer brings it back up", async () => {
    let now = 1_000;
    const { inner, mode } = flaky();
    const g = new GuardedReferee(inner, "outlayer", () => now);
    mode.next = "fail";
    await g.pubkeys().catch(() => {});
    await g.pubkeys().catch(() => {});
    now += PROBE_MS;
    mode.next = "ok";
    await g.pubkeys();
    expect(g.health()).toMatchObject({ status: "up", lastOkMs: now });
  });

  test("a refusal is an answer: the referee is up", async () => {
    const { inner, mode } = flaky();
    const g = new GuardedReferee(inner, "local");
    mode.next = "refuse";
    await expect(g.pubkeys()).rejects.toThrow("no");
    expect(g.health()).toMatchObject({ kind: "local", status: "up" });
  });
});

describe("the device table", () => {
  test("a relay database from before background enrolment is migrated with its rows", () => {
    const path = join(mkdtempSync(join(tmpdir(), "tail-relay-")), "relay.db");
    const old = new Database(path, { create: true });
    old.run(`CREATE TABLE devices (
      account_id TEXT PRIMARY KEY, kind TEXT NOT NULL, app_attest_pk BLOB NOT NULL,
      player_box_pk BLOB NOT NULL, near_pk BLOB NOT NULL, receipt BLOB NOT NULL,
      receipt_sig BLOB NOT NULL, enroll_call_id TEXT NOT NULL, created_ms INTEGER NOT NULL)`);
    old
      .query("INSERT INTO devices VALUES ('ana.r.testnet', 'phone', ?, ?, ?, ?, ?, 'c1', 1)")
      .run(new Uint8Array(65), new Uint8Array(32), new Uint8Array(32), new Uint8Array(4), new Uint8Array(64));
    old.close();

    const store = new Store(path);
    expect(store.device("ana.r.testnet")?.enroll_call_id).toBe("c1");
    store.putDevice({
      account_id: "bo.r.testnet",
      kind: "phone",
      app_attest_pk: new Uint8Array(65),
      player_box_pk: new Uint8Array(32),
      near_pk: new Uint8Array(32),
      receipt: null,
      receipt_sig: null,
      enroll_call_id: null,
      created_ms: 2,
    });
    expect(store.devicesAwaitingReferee()).toEqual(["bo.r.testnet"]);
    store.close();
  });
});
