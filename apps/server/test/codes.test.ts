// Lobby codes on their own: the alphabet, reading what people type, and the store keeping each
// code to one match. The routes that use them are in relay.test.ts ("lobby codes").

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODE_ALPHABET, mintCode, parseCode, showCode } from "../src/codes.ts";
import { Store } from "../src/db.ts";

const ZONE = { zone: { latE7: 0, lonE7: 0, radiusM: 100 }, safehouses: [] };

describe("lobby codes", () => {
  test("a minted code is six symbols from the unambiguous alphabet", () => {
    for (let i = 0; i < 200; i++) {
      const c = mintCode();
      expect(c).toHaveLength(6);
      for (const ch of c) expect(CODE_ALPHABET).toContain(ch);
    }
    expect(CODE_ALPHABET).toHaveLength(30);
    for (const ch of "01ILOU") expect(CODE_ALPHABET).not.toContain(ch);
  });

  test("bytes that would bias the draw are redrawn, and the rest map straight onto the alphabet", () => {
    // 240..255 would favour the first 16 symbols under a plain modulo, so they are skipped.
    const draws = [new Uint8Array([255, 240, 0, 1, 2, 3]), new Uint8Array([29, 30, 0, 0, 0, 0])];
    expect(mintCode(() => draws.shift() as Uint8Array)).toBe("2345Z2");
  });

  test("a code reads the same in any case, with or without the dash or spaces", () => {
    for (const typed of ["K7M-4QX", "k7m4qx", " k7m 4qx ", "K7M4QX"]) expect(parseCode(typed)).toBe("K7M4QX");
    expect(showCode("K7M4QX")).toBe("K7M-4QX");
  });

  test("anything that cannot be a code is not read as one", () => {
    for (const typed of [
      "K7M-4Q",
      "K7M-4QXX",
      "K7M-4Q0",
      "K7M-4QI",
      "K7M-4QU",
      "",
      "7f3a9c21e4b85d60a1c2e3f405162738",
    ])
      expect(parseCode(typed)).toBeNull();
  });

  test("the store keeps a code to one match; a different code is free", () => {
    const s = new Store(":memory:");
    s.putMatch("a".repeat(32), "host.testnet", ZONE, "K7M4QX", 1);
    expect(s.codeTaken("K7M4QX")).toBe(true);
    expect(() => s.putMatch("b".repeat(32), "host.testnet", ZONE, "K7M4QX", 2)).toThrow();
    expect(s.codeTaken("K7M4QY")).toBe(false);
    s.putMatch("b".repeat(32), "host.testnet", ZONE, "K7M4QY", 2);
    expect(s.lobbyByCode("K7M4QY")).toBe("b".repeat(32));
  });

  test("a relay database from before codes gains the column and keeps its matches", () => {
    const dir = mkdtempSync(join(tmpdir(), "tail-codes-"));
    try {
      const path = join(dir, "relay.sqlite");
      const old = new Database(path, { create: true });
      old.run(
        "CREATE TABLE matches (match_id TEXT PRIMARY KEY, host TEXT NOT NULL, zone TEXT NOT NULL, phase TEXT NOT NULL, created_ms INTEGER NOT NULL, start_ms INTEGER, end_ms INTEGER, players TEXT, keys TEXT, state BLOB, last_seq INTEGER NOT NULL DEFAULT 0, tick_no INTEGER NOT NULL DEFAULT 0, reveal TEXT, trails_done INTEGER NOT NULL DEFAULT 0, error TEXT)",
      );
      old
        .query("INSERT INTO matches (match_id, host, zone, phase, created_ms) VALUES (?, ?, ?, 'lobby', 1)")
        .run("a".repeat(32), "host.testnet", JSON.stringify(ZONE));
      old.close();
      const s = new Store(path);
      expect(s.match("a".repeat(32))?.code).toBeNull();
      s.putMatch("b".repeat(32), "host.testnet", ZONE, "K7M4QX", 2);
      expect(s.match("b".repeat(32))?.code).toBe("K7M4QX");
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
