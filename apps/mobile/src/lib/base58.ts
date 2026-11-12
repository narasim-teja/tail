// Bitcoin-alphabet base58, as NEAR prints public keys ("ed25519:<base58>") and block hashes.

const ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX = new Map([...ALPHA].map((c, i) => [c, i]));

export function toBase58(b: Uint8Array): string {
  let zeros = 0;
  while (zeros < b.length && b[zeros] === 0) zeros++;
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let out = "";
  while (n > 0n) {
    out = ALPHA.charAt(Number(n % 58n)) + out;
    n /= 58n;
  }
  return "1".repeat(zeros) + out;
}

export function fromBase58(s: string): Uint8Array {
  let zeros = 0;
  while (zeros < s.length && s.charAt(zeros) === "1") zeros++;
  let n = 0n;
  for (const c of s) {
    const v = INDEX.get(c);
    if (v === undefined) throw new Error("invalid base58");
    n = n * 58n + BigInt(v);
  }
  const body: number[] = [];
  while (n > 0n) {
    body.unshift(Number(n & 255n));
    n >>= 8n;
  }
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...body]);
}
