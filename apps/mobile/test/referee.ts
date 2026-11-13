// A stand-in referee for tests: its ed25519 key, and full v2 HUDs with defaults, signed and
// sealed the way crates/referee-wasi does (packages/protocol signed.ts).
import { ed25519 } from "@noble/curves/ed25519.js";
import { type Hud, sealSignedHud, signHud, TargetStatus } from "@tail/protocol";

export const refereeSk = ed25519.utils.randomSecretKey();
export const refereePk = ed25519.getPublicKey(refereeSk);

export const hudOf = (o: Partial<Hud> = {}): Hud => ({
  matchId: new Uint8Array(16).fill(4),
  player: 0,
  tick: 1,
  epoch: 0,
  lock: 0,
  heat: 0,
  head: 5_000_000n,
  status: TargetStatus.Hunting,
  target: "bob.tail.testnet",
  nextSeq: 0,
  chainTip: new Uint8Array(32),
  darkMs: 0,
  tags: 0,
  logSize: 0n,
  root: new Uint8Array(32),
  // A quiet market at a 5.00 stake: the base prices.
  hintPrices: [100_000n, 250_000n, 100_000n],
  hintRecent: 0,
  ...o,
});

export const sealedHud = (boxPk: Uint8Array, hud: Hud, sk: Uint8Array = refereeSk) =>
  sealSignedHud(boxPk, signHud(hud, sk));
