// Byte helpers shared by every module. Little-endian everywhere, as borsh is.

const enc = new TextEncoder();

export function utf8(s: string): Uint8Array {
  return enc.encode(s);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function u16le(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new RangeError(`u16 out of range: ${n}`);
  return Uint8Array.of(n & 0xff, n >>> 8);
}

export function u32le(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff_ffff) throw new RangeError(`u32 out of range: ${n}`);
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

export function u64le(n: bigint): Uint8Array {
  if (n < 0n || n > 0xffff_ffff_ffff_ffffn) throw new RangeError(`u64 out of range: ${n}`);
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}

export function readU64le(b: Uint8Array, off = 0): bigint {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(off, true);
}

export function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function fromHex(h: string): Uint8Array {
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error("invalid hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= (a[i] as number) ^ (b[i] as number);
  return d === 0;
}

/** Asserts a fixed length; the result type stays Uint8Array. */
export function fixed(b: Uint8Array, len: number, what: string): Uint8Array {
  if (b.length !== len) throw new Error(`${what} must be ${len} bytes, got ${b.length}`);
  return b;
}
