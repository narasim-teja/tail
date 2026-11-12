// Globals @tail/protocol and @noble need that Hermes lacks. Imported first by index.ts.
import { getRandomValues } from "expo-crypto";
import { Utf8Decoder } from "./lib/utf8";

type Rng = <T extends ArrayBufferView | null>(array: T) => T;

// @noble draws ephemeral X25519 keys (sealing) and new key pairs from crypto.getRandomValues.
// expo-crypto's is backed by SecRandomCopyBytes.
const g = globalThis as { crypto?: { getRandomValues?: Rng } };
if (typeof g.crypto?.getRandomValues !== "function") {
  g.crypto = { ...(g.crypto ?? {}), getRandomValues: getRandomValues as unknown as Rng };
}

if (typeof globalThis.TextDecoder === "undefined") {
  (globalThis as { TextDecoder?: unknown }).TextDecoder = Utf8Decoder;
}
