// Standard base64 with padding, written out so it behaves the same in Hermes and Bun (Hermes has
// no Buffer, and atob/btoa work on binary strings, which is easy to get wrong with bytes).

const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const INDEX = new Map([...ALPHA].map((c, i) => [c, i]));

export function toB64(b: Uint8Array): string {
  let out = "";
  for (let i = 0; i < b.length; i += 3) {
    const n = ((b[i] ?? 0) << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += ALPHA.charAt((n >> 18) & 63) + ALPHA.charAt((n >> 12) & 63);
    out += i + 1 < b.length ? ALPHA.charAt((n >> 6) & 63) : "=";
    out += i + 2 < b.length ? ALPHA.charAt(n & 63) : "=";
  }
  return out;
}

export function fromB64(s: string): Uint8Array {
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new Error("invalid base64");
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    let n = 0;
    for (let k = 0; k < 4; k++) n = (n << 6) | (INDEX.get(s.charAt(i + k)) ?? 0);
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}
