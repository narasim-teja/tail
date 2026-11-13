// What the referee signs with its ed25519 key besides verdicts' on-chain check: the verdict
// chain, and the HUD, keys and Handler lines it seals to a phone. Sealing alone is not enough
// for those: anyone with a player's box public key (the relay included) can seal to it, so the
// phone checks the referee's signature inside.
//
//   HUD:    sig = ed25519(referee_sk, SHA256("tail/hud/v2"   ‖ borsh(Hud))),        sealed with context "tail/hud/v2"
//   keys:   sig = ed25519(referee_sk, SHA256("tail/keys/v2"  ‖ borsh(PlayerKeys))), sealed with context "tail/keys/v2"
//   voice:  sig = ed25519(referee_sk, SHA256("tail/voice/v1" ‖ borsh(VoiceLine))),  sealed with context "tail/voice/v1"
//
// Each is padded before sealing to PHONE_PAD bytes, u32le(len) ‖ borsh ‖ zeros (sealToPhone /
// openOnPhone), so every one of them seals to the same length: otherwise the length of the keys
// would name the target's account and the length of a template Handler line its hint.

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concat, equal, utf8 } from "./bytes.ts";
import { Domain, PHONE_PAD, SealContext } from "./constants.ts";
import { open, seal, sealWith, verdictDigest, verifyEd25519 } from "./crypto.ts";
import {
  decodeSignedHud,
  decodeSignedPlayerKeys,
  decodeSignedVoiceLine,
  encodeHud,
  encodePlayerKeys,
  encodeSignedHud,
  encodeSignedPlayerKeys,
  encodeSignedVoiceLine,
  encodeVoiceLine,
  type Hud,
  type PlayerKeys,
  type SignedHud,
  type SignedPlayerKeys,
  type SignedVerdict,
  type SignedVoiceLine,
  type VerdictPayload,
  type VoiceLine,
} from "./messages.ts";
import { padTo, unpadFrom } from "./pad.ts";

type Bytes = Uint8Array;

/** The seal contexts of what the referee sends a phone. */
export type PhoneContext = typeof SealContext.hud | typeof SealContext.keys | typeof SealContext.voice;

export const padPhone = (x: Bytes) => padTo(PHONE_PAD, x, "message to a phone");
export const unpadPhone = (padded: Bytes) => unpadFrom(PHONE_PAD, padded, "message to a phone");

/** Seals to a phone's box key, padded to PHONE_PAD: every message seals to 32 + PHONE_PAD + 16 bytes. */
export const sealToPhone = (boxPk: Bytes, plaintext: Bytes, context: PhoneContext) =>
  seal(boxPk, padPhone(plaintext), context);
/** Fixed ephemeral key, for vectors and tests only. */
export const sealToPhoneWith = (ephSk: Bytes, boxPk: Bytes, plaintext: Bytes, context: PhoneContext) =>
  sealWith(ephSk, boxPk, padPhone(plaintext), context);
/**
 * Opens what sealToPhone sealed and strips the padding (strictly). The signature inside is the
 * caller's to check: anyone can seal to a box key. Prefer the openSigned* helpers below.
 */
export const openOnPhone = (boxSk: Bytes, sealed: Bytes, context: PhoneContext) =>
  unpadPhone(open(boxSk, sealed, context));

export const hudSigDigest = (hud: Hud) => sha256(concat(utf8(Domain.hud), encodeHud(hud)));
export const keysSigDigest = (keys: PlayerKeys) => sha256(concat(utf8(Domain.keys), encodePlayerKeys(keys)));
export const voiceSigDigest = (line: VoiceLine) => sha256(concat(utf8(Domain.voice), encodeVoiceLine(line)));

// ── Signing (the referee is Rust; these serve test referees, fixtures and vectors) ──

export const signVerdict = (p: VerdictPayload, refereeSk: Bytes): SignedVerdict => ({
  ...p,
  sig: ed25519.sign(verdictDigest(p), refereeSk),
});
export const signHud = (hud: Hud, refereeSk: Bytes): SignedHud => ({
  hud,
  sig: ed25519.sign(hudSigDigest(hud), refereeSk),
});
export const signPlayerKeys = (keys: PlayerKeys, refereeSk: Bytes): SignedPlayerKeys => ({
  keys,
  sig: ed25519.sign(keysSigDigest(keys), refereeSk),
});
export const signVoiceLine = (line: VoiceLine, refereeSk: Bytes): SignedVoiceLine => ({
  line,
  sig: ed25519.sign(voiceSigDigest(line), refereeSk),
});

export const sealSignedHud = (boxPk: Bytes, s: SignedHud) =>
  sealToPhone(boxPk, encodeSignedHud(s), SealContext.hud);
export const sealSignedPlayerKeys = (boxPk: Bytes, s: SignedPlayerKeys) =>
  sealToPhone(boxPk, encodeSignedPlayerKeys(s), SealContext.keys);
export const sealSignedVoiceLine = (boxPk: Bytes, s: SignedVoiceLine) =>
  sealToPhone(boxPk, encodeSignedVoiceLine(s), SealContext.voice);

// ── Verifying ───────────────────────────────────────────────────────────────────

export const verifySignedVerdict = (v: SignedVerdict, refereePk: Bytes) =>
  verifyEd25519(refereePk, verdictDigest(v), v.sig);
export const verifySignedHud = (s: SignedHud, refereePk: Bytes) =>
  verifyEd25519(refereePk, hudSigDigest(s.hud), s.sig);
export const verifySignedPlayerKeys = (s: SignedPlayerKeys, refereePk: Bytes) =>
  verifyEd25519(refereePk, keysSigDigest(s.keys), s.sig);
export const verifySignedVoiceLine = (s: SignedVoiceLine, refereePk: Bytes) =>
  verifyEd25519(refereePk, voiceSigDigest(s.line), s.sig);

/**
 * Checks one match's verdict stream as the contract does: seq 1, 2, … in order, one match id,
 * each `prev` the digest of the verdict before (zeros for the first), every signature valid.
 * Returns the index of the first verdict that breaks it, or undefined if none does.
 */
export function verdictChainBreak(verdicts: readonly SignedVerdict[], refereePk: Bytes): number | undefined {
  let prev = new Uint8Array(32);
  for (const [i, v] of verdicts.entries()) {
    const first = verdicts[0] as SignedVerdict;
    const ok =
      v.seq === i + 1 &&
      equal(v.matchId, first.matchId) &&
      equal(v.prev, prev) &&
      verifySignedVerdict(v, refereePk);
    if (!ok) return i;
    prev = verdictDigest(v);
  }
  return undefined;
}

/** Opens a sealed SignedHud and checks the referee's signature; throws if either fails. */
export function openSignedHud(boxSk: Bytes, sealed: Bytes, refereePk: Bytes): Hud {
  const s = decodeSignedHud(openOnPhone(boxSk, sealed, SealContext.hud));
  if (!verifySignedHud(s, refereePk)) throw new Error("HUD not signed by the referee");
  return s.hud;
}

export function openSignedPlayerKeys(boxSk: Bytes, sealed: Bytes, refereePk: Bytes): PlayerKeys {
  const s = decodeSignedPlayerKeys(openOnPhone(boxSk, sealed, SealContext.keys));
  if (!verifySignedPlayerKeys(s, refereePk)) throw new Error("keys not signed by the referee");
  return s.keys;
}

export function openSignedVoiceLine(boxSk: Bytes, sealed: Bytes, refereePk: Bytes): VoiceLine {
  const s = decodeSignedVoiceLine(openOnPhone(boxSk, sealed, SealContext.voice));
  if (!verifySignedVoiceLine(s, refereePk)) throw new Error("Handler line not signed by the referee");
  return s.line;
}
