import { describe, expect, test } from "bun:test";
import { fromB64, toB64 } from "./b64";
import { Utf8Decoder } from "./utf8";

describe("base64", () => {
  test("round-trips every length and matches the platform encoder", () => {
    for (let n = 0; n < 40; n++) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255);
      expect(toB64(b)).toBe(Buffer.from(b).toString("base64"));
      expect(fromB64(toB64(b))).toEqual(b);
    }
  });

  test("rejects text that is not padded base64", () => {
    expect(() => fromB64("abc")).toThrow();
    expect(() => fromB64("ab$=")).toThrow();
  });
});

describe("UTF-8 decoder for Hermes", () => {
  const native = new TextDecoder("utf-8", { fatal: true });
  test("decodes what the platform decoder decodes", () => {
    for (const s of ["", "alice.tail.testnet", "héllo", "東京", "🦊 tag", "\u0000x"]) {
      const b = new TextEncoder().encode(s);
      expect(new Utf8Decoder("utf-8", { fatal: true }).decode(b)).toBe(native.decode(b));
    }
  });

  test("in fatal mode rejects overlong, surrogate, truncated and stray bytes as the platform does", () => {
    for (const bad of [[0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xe6, 0x9d], [0x80], [0xf5, 0x80, 0x80, 0x80]]) {
      const b = Uint8Array.from(bad);
      expect(() => native.decode(b)).toThrow();
      expect(() => new Utf8Decoder("utf-8", { fatal: true }).decode(b)).toThrow();
    }
  });
});
