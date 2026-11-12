// The CBOR App Attest uses, and nothing more: unsigned ints, byte and text strings, arrays and
// maps. Enough to build an assertion the way the Secure Enclave does and to read Apple's real
// attestation object.

export type Cbor = number | Uint8Array | string | Cbor[] | Map<string | number, Cbor>;

function head(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 0x100) return [(major << 5) | 24, n];
  if (n < 0x10000) return [(major << 5) | 25, n >> 8, n & 255];
  return [(major << 5) | 26, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function encode(v: Cbor): Uint8Array {
  const out: number[] = [];
  const walk = (x: Cbor) => {
    if (typeof x === "number") out.push(...head(0, x));
    else if (x instanceof Uint8Array) out.push(...head(2, x.length), ...x);
    else if (typeof x === "string") {
      const b = new TextEncoder().encode(x);
      out.push(...head(3, b.length), ...b);
    } else if (Array.isArray(x)) {
      out.push(...head(4, x.length));
      x.forEach(walk);
    } else {
      out.push(...head(5, x.size));
      for (const [k, val] of x) {
        walk(k);
        walk(val);
      }
    }
  };
  walk(v);
  return Uint8Array.from(out);
}

export function decode(b: Uint8Array): Cbor {
  let off = 0;
  const arg = (info: number): number => {
    if (info < 24) return info;
    const len = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : -1;
    if (len < 0) throw new Error(`unsupported CBOR length ${info}`);
    let n = 0;
    for (let i = 0; i < len; i++) n = n * 256 + (b[off++] as number);
    return n;
  };
  const item = (): Cbor => {
    const ib = b[off++] as number;
    const major = ib >> 5;
    const n = arg(ib & 31);
    switch (major) {
      case 0:
        return n;
      case 2:
        off += n;
        return b.slice(off - n, off);
      case 3:
        off += n;
        return new TextDecoder().decode(b.slice(off - n, off));
      case 4:
        return Array.from({ length: n }, item);
      case 5: {
        const m = new Map<string | number, Cbor>();
        for (let i = 0; i < n; i++) m.set(item() as string | number, item());
        return m;
      }
      default:
        throw new Error(`unsupported CBOR major type ${major}`);
    }
  };
  const v = item();
  if (off !== b.length) throw new Error("trailing CBOR bytes");
  return v;
}
