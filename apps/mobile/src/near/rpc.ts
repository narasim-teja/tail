// The few NEAR JSON-RPC calls a phone makes: the access key's nonce, a recent block hash, sending
// a signed transaction, and contract views. The relay pays for everything else.

import { utf8 } from "@tail/protocol";
import { toB64 } from "../lib/b64";
import { fromBase58 } from "../lib/base58";
import type { Fetch } from "../relay/client";
import { type FunctionCall, nearPublicKeyString, signTransaction } from "./tx";

export class NearError extends Error {
  override name = "NearError";
}

type Obj = Record<string, unknown>;

export interface NearKey {
  accountId: string;
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export class NearRpc {
  constructor(
    private readonly url: string,
    private readonly fetchFn: Fetch = (url, init) => fetch(url, init),
  ) {}

  private async call(method: string, params: unknown): Promise<Obj> {
    let res: Response;
    try {
      res = await this.fetchFn(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "tail", method, params }),
      });
    } catch {
      throw new NearError("Can't reach NEAR.");
    }
    const body = (await res.json()) as Obj;
    if (body["error"]) {
      const e = body["error"] as Obj;
      const cause = (e["cause"] as Obj | undefined)?.["name"];
      throw new NearError(`NEAR refused: ${String(cause ?? e["message"] ?? "error")}`);
    }
    return body["result"] as Obj;
  }

  /** A view call on a contract; the result is the method's JSON return value. */
  async view<T>(contract: string, method: string, args: object): Promise<T> {
    const r = await this.call("query", {
      request_type: "call_function",
      finality: "final",
      account_id: contract,
      method_name: method,
      args_base64: toB64(utf8(JSON.stringify(args))),
    });
    const bytes = Uint8Array.from(r["result"] as number[]);
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  }

  /** Signs and sends one function call with the player's key; resolves once it executed. */
  async functionCall(key: NearKey, contract: string, call: FunctionCall): Promise<string> {
    const ak = await this.call("query", {
      request_type: "view_access_key",
      finality: "final",
      account_id: key.accountId,
      public_key: nearPublicKeyString(key.publicKey),
    });
    const { signed, hash } = signTransaction(
      {
        signerId: key.accountId,
        publicKey: key.publicKey,
        nonce: BigInt(ak["nonce"] as number) + 1n,
        receiverId: contract,
        blockHash: fromBase58(ak["block_hash"] as string),
        actions: [call],
      },
      key.secretKey,
    );
    const r = await this.call("send_tx", {
      signed_tx_base64: toB64(signed),
      wait_until: "EXECUTED_OPTIMISTIC",
    });
    const status = r["status"] as Obj | undefined;
    // Without a status the transaction was accepted but its outcome is not known yet; the lobby
    // poll shows whether it took effect.
    if (status && "Failure" in status) throw new NearError(failureText(status["Failure"]));
    return hash;
  }
}

/** The contract's panic message, when there is one, is the most useful thing to show. */
function failureText(f: unknown): string {
  const s = JSON.stringify(f);
  const m = /"ExecutionError":"([^"]+)"/.exec(s) ?? /"FunctionCallError":\{[^}]*"([^"]+)"/.exec(s);
  return m?.[1] ? m[1].replace(/^Smart contract panicked: /, "") : "The transaction failed.";
}
