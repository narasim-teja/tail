import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@tail/protocol";
// The relay's pinned near-api-js, used here only as an independent encoder to compare with.
import * as nearApi from "../../../relay/node_modules/near-api-js/lib/index.js";
import { fromBase58, toBase58 } from "../lib/base58";
import { encodeTransaction, nearPublicKeyString, PLAYER_GAS, signTransaction, type Transaction } from "./tx";

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
