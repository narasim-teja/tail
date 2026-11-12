// Short lobby codes: six characters a host can read out across a park, shown as "K7M-4QX".
// The alphabet is Crockford base32 without 0/O, 1/I/L and U, so no two symbols look or sound
// alike and nothing spells a word by accident. 30^6 ≈ 729 million codes; the store keeps each
// one unique (db.ts), and a code resolves only while its lobby is open (routes/matches.ts).

export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_LENGTH = 6;

// The largest multiple of the alphabet size below 256: bytes at or above it are redrawn, so
// every symbol is equally likely (a plain modulo would favour the first 16).
const LIMIT = 256 - (256 % CODE_ALPHABET.length);

/** A fresh random code in its stored form, e.g. "K7M4QX". */
export function mintCode(random: (n: number) => Uint8Array = randomBytes): string {
  let out = "";
  while (out.length < CODE_LENGTH) {
    for (const b of random(CODE_LENGTH)) {
      if (b < LIMIT && out.length < CODE_LENGTH) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
    }
  }
  return out;
}

/** The stored form as people see it: "K7M4QX" → "K7M-4QX". */
export const showCode = (code: string) => `${code.slice(0, 3)}-${code.slice(3)}`;

/**
 * What someone typed, in stored form, or null if it cannot be a code. Case does not matter and
 * the dash and spaces are optional, so "k7m 4qx", "K7M-4QX" and "k7m4qx" all read the same.
 */
export function parseCode(input: string): string | null {
  const s = input.replace(/[\s-]/g, "").toUpperCase();
  if (s.length !== CODE_LENGTH) return null;
  for (const ch of s) if (!CODE_ALPHABET.includes(ch)) return null;
  return s;
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}
