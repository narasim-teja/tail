// The relay's two mesh carry keys (TECHNICAL.md 7): an X25519 box key phones seal carried
// requests to (`sealCarry`), and an ed25519 key that signs the receipt for each envelope
// (`signCarryAck`). Both are generated once and kept in RELAY_KEYS_DIR (the repo's ignored
// .keys/relay by default), so a receipt signed before a restart still verifies after it. They are
// never logged; only the public halves leave this file (GET /carry/key).

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { boxPublicKey } from "@tail/protocol";

export interface CarryKeys {
  boxSk: Uint8Array;
  boxPk: Uint8Array;
  /** 32-byte ed25519 seed. */
  ackSk: Uint8Array;
  ackPk: Uint8Array;
}

function fromSecrets(boxSk: Uint8Array, ackSk: Uint8Array): CarryKeys {
  if (boxSk.length !== 32 || ackSk.length !== 32) throw new Error("carry keys must be 32 bytes each");
  return { boxSk, boxPk: boxPublicKey(boxSk), ackSk, ackPk: ed25519.getPublicKey(ackSk) };
}

export const newCarryKeys = () =>
  fromSecrets(x25519.utils.randomSecretKey(), ed25519.utils.randomSecretKey());

export const CARRY_KEYS_FILE = "carry.json";

/** Reads `dir/carry.json`, or makes it (owner-only) on first start. */
export function loadCarryKeys(dir: string): { keys: CarryKeys; created: boolean } {
  const path = join(dir, CARRY_KEYS_FILE);
  if (existsSync(path)) {
    const j = JSON.parse(readFileSync(path, "utf8")) as { box_sk?: unknown; ack_sk?: unknown };
    if (typeof j.box_sk !== "string" || typeof j.ack_sk !== "string")
      throw new Error(`${path} must hold box_sk and ack_sk (base64)`);
    const b = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
    return { keys: fromSecrets(b(j.box_sk), b(j.ack_sk)), created: false };
  }
  const keys = newCarryKeys();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const b64 = (x: Uint8Array) => Buffer.from(x).toString("base64");
  writeFileSync(path, `${JSON.stringify({ box_sk: b64(keys.boxSk), ack_sk: b64(keys.ackSk) })}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  chmodSync(path, 0o600);
  return { keys, created: true };
}
