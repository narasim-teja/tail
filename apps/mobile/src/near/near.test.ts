import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@tail/protocol";
// The relay's pinned near-api-js, used here only as an independent encoder to compare with.
import * as nearApi from "../../../server/node_modules/near-api-js/lib/index.js";
import { fromBase58, toBase58 } from "../lib/base58";
import { parseMatchFacts } from "./chain";
import { encodeTransaction, nearPublicKeyString, PLAYER_GAS, signTransaction, type Transaction } from "./tx";
import { payoutProblem, withdrawCall, withdrawGas } from "./withdraw";

const sk = ed25519.utils.randomSecretKey();
const pk = ed25519.getPublicKey(sk);
const tx: Transaction = {
  signerId: "alice.tail-dev.testnet",
  publicKey: pk,
  nonce: 123_456_789_012n,
  receiverId: "tail.tail-dev.testnet",
  blockHash: sha256(new TextEncoder().encode("block")),
  actions: [{ methodName: "join_match", args: { match_id: "ab".repeat(16) }, gas: PLAYER_GAS }],
};

describe("NEAR transactions", () => {
  test("a join_match transaction encodes exactly as near-api-js encodes it", () => {
    const theirs = nearApi.createTransaction(
      tx.signerId,
      nearApi.PublicKey.fromString(nearPublicKeyString(pk)),
      tx.receiverId,
      tx.nonce,
      [nearApi.actions.functionCall("join_match", { match_id: "ab".repeat(16) }, PLAYER_GAS, 0n)],
      tx.blockHash,
    );
    expect(Array.from(encodeTransaction(tx))).toEqual(Array.from(nearApi.encodeTransaction(theirs)));
  });

  test("the signed transaction carries an ed25519 signature over SHA256 of the transaction", () => {
    const { signed, hash } = signTransaction(tx, sk);
    const body = encodeTransaction(tx);
    expect(Array.from(signed.slice(0, body.length))).toEqual(Array.from(body));
    expect(signed[body.length]).toBe(0);
    const sig = signed.slice(body.length + 1);
    expect(sig).toHaveLength(64);
    expect(ed25519.verify(sig, sha256(body), pk)).toBe(true);
    expect(fromBase58(hash)).toEqual(sha256(body));
    const decoded = nearApi.decodeSignedTransaction(signed);
    expect(decoded.transaction.signerId).toBe(tx.signerId);
  });

  test("base58 round-trips and keeps leading zero bytes", () => {
    const b = Uint8Array.from([0, 0, 1, 2, 255]);
    expect(fromBase58(toBase58(b))).toEqual(b);
    expect(toBase58(pk)).toBe(nearApi.baseEncode(pk));
    expect(() => fromBase58("0OIl")).toThrow();
  });
});

describe("withdraw", () => {
  const TGAS = 1_000_000_000_000n;

  test("gas is the contract's withdraw_min_gas, in Tgas, or 50 Tgas when the contract does not say", () => {
    expect(withdrawGas({ withdraw_min_gas: 60 })).toBe(60n * TGAS);
    expect(withdrawGas({ withdraw_min_gas: "55" })).toBe(55n * TGAS);
    expect(withdrawGas({})).toBe(50n * TGAS);
    expect(withdrawGas({ withdraw_min_gas: -1 })).toBe(50n * TGAS);
    expect(withdrawGas({ withdraw_min_gas: "lots" })).toBe(50n * TGAS);
    // Never below what the contract refuses today: the old fixed 30 Tgas was refused.
    expect(withdrawGas({})).toBeGreaterThan(PLAYER_GAS);
  });

  test("the payout wallet goes in `to` only when given", () => {
    const base = { token: "usdc.fakes.testnet", amount: 1_500_000n, gas: 50n * TGAS };
    expect(withdrawCall(base).args).toEqual({ token: "usdc.fakes.testnet", amount: "1500000" });
    expect(withdrawCall({ ...base, to: " maya.testnet " }).args).toEqual({
      token: "usdc.fakes.testnet",
      amount: "1500000",
      to: "maya.testnet",
    });
  });

  test("a payout account must be a valid NEAR account that is neither this account nor the contract", () => {
    const me = "maya.tail-dev.testnet";
    const contract = "tail.tail-dev.testnet";
    const ok = (s: string) => payoutProblem(s, me, contract) === null;
    expect(ok("maya.testnet")).toBe(true);
    expect(ok("my_wallet-2.near")).toBe(true);
    expect(ok("ab".repeat(32))).toBe(true);
    expect(ok(`0x${"a1".repeat(20)}`)).toBe(true);
    expect(ok("")).toBe(false);
    expect(ok("Maya.testnet")).toBe(false);
    expect(ok("a")).toBe(false);
    expect(ok("maya..testnet")).toBe(false);
    expect(ok(".maya")).toBe(false);
    expect(ok("maya-.testnet")).toBe(false);
    expect(ok("maya testnet")).toBe(false);
    expect(ok("x".repeat(65))).toBe(false);
    expect(ok(me)).toBe(false);
    expect(ok(contract)).toBe(false);
  });
});

describe("match facts", () => {
  const view = {
    referee_pk: "ab".repeat(32),
    phase: "ended",
    players: [
      { account_id: "a.testnet", head: "0", out: true, paid: "0" },
      { account_id: "b.testnet", head: "0", out: false, paid: "2000000" },
    ],
  };

  test("read how the match settled and what each player was paid", () => {
    const f = parseMatchFacts({ ...view, settled_as: "payout", violation: null });
    expect(f?.players).toEqual(["a.testnet", "b.testnet"]);
    expect(f?.paid).toEqual([0n, 2_000_000n]);
    expect([f?.settledAs, f?.violation]).toEqual(["payout", null]);
    const refunded = parseMatchFacts({
      ...view,
      settled_as: "refunded_rule_violation",
      violation: "event 2: a Tag did not follow the ring",
    });
    expect([refunded?.settledAs, refunded?.violation]).toEqual([
      "refunded_rule_violation",
      "event 2: a Tag did not follow the ring",
    ]);
    // A match that ended before the upgrade: paid out by the old code, never replayed.
    expect(parseMatchFacts({ ...view, settled_as: "payout_unreplayed" })?.settledAs).toBe(
      "payout_unreplayed",
    );
  });

  test("a contract from before v2 reports no settlement; an unknown one is refused", () => {
    expect(parseMatchFacts(view)?.settledAs).toBeNull();
    expect(() => parseMatchFacts({ ...view, settled_as: "kept_by_relay" })).toThrow("not a settlement");
    expect(() => parseMatchFacts({ ...view, players: [{ account_id: "a.testnet", paid: 5 }] })).toThrow(
      "paid is not an amount",
    );
  });
});
