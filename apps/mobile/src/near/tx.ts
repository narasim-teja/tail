// NEAR transactions for the player's function-call key: join_match, leave_lobby, withdraw.
// Borsh layout of nearcore's `Transaction` (V0) and `SignedTransaction`:
//
//   Transaction { signer_id: String, public_key: PublicKey, nonce: u64, receiver_id: String,
//                 block_hash: [u8; 32], actions: Vec<Action> }
//   PublicKey   = u8 key type (0 = ed25519) ‖ [u8; 32]
//   Action::FunctionCall = u8 2 ‖ { method_name: String, args: Vec<u8>, gas: u64, deposit: u128 }
//   SignedTransaction { transaction, signature: u8 0 ‖ [u8; 64] }
//
// The signature is ed25519 over SHA256(borsh(Transaction)). A function-call key cannot attach a
// deposit (TECHNICAL.md F18), so deposit is always 0.

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256, utf8, Writer } from "@tail/protocol";
import { toBase58 } from "../lib/base58";

/** 30 Tgas per player call (TECHNICAL.md 4.9, contracts/tail/README.md). */
export const PLAYER_GAS = 30_000_000_000_000n;

export interface FunctionCall {
  methodName: string;
  args: object;
  gas: bigint;
}

export interface Transaction {
  signerId: string;
  publicKey: Uint8Array;
  nonce: bigint;
  receiverId: string;
  blockHash: Uint8Array;
  actions: FunctionCall[];
}

export const nearPublicKeyString = (pk: Uint8Array) => `ed25519:${toBase58(pk)}`;

export function encodeTransaction(t: Transaction): Uint8Array {
  return new Writer()
    .string(t.signerId)
    .u8(0)
    .fixed(t.publicKey, 32)
    .u64(t.nonce)
    .string(t.receiverId)
    .fixed(t.blockHash, 32)
    .vec(t.actions, (w, a) => {
      w.u8(2)
        .string(a.methodName)
        .vecU8(utf8(JSON.stringify(a.args)))
        .u64(a.gas)
        .u128(0n);
    })
    .bytes();
}

/** Returns the borsh SignedTransaction and the transaction hash (what explorers show, base58). */
export function signTransaction(t: Transaction, secretKey: Uint8Array): { signed: Uint8Array; hash: string } {
  const tx = encodeTransaction(t);
  const digest = sha256(tx);
  const sig = ed25519.sign(digest, secretKey);
  return { signed: new Writer().raw(tx).u8(0).fixed(sig, 64).bytes(), hash: toBase58(digest) };
}
