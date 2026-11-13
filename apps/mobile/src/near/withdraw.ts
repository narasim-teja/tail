// Withdrawing a contract balance (contracts/tail `withdraw(token, amount, to?)`).
//
// Gas: the contract refuses a withdraw with less than its `withdraw_min_gas` (get_config, in
// Tgas), because the call attaches gas to ft_transfer and to a callback that restores the
// balance if the transfer fails. The phone sends exactly what the contract asks for.
//
// Payout: accounts the relay creates hold only this phone's function-call key, so their payout
// account starts as the account itself and tokens paid there could never leave. The first
// withdraw then names a wallet in `to`, which becomes the payout for good.

import type { FunctionCall } from "./tx";

const TGAS = 1_000_000_000_000n;
/** Used when get_config does not say (a contract older than `withdraw_min_gas`). */
export const WITHDRAW_FALLBACK_TGAS = 50n;

/** Gas for withdraw from get_config's `withdraw_min_gas` (Tgas, a number or a decimal string). */
export function withdrawGas(config: Record<string, unknown>): bigint {
  const v = config["withdraw_min_gas"];
  const tgas =
    typeof v === "number" && Number.isSafeInteger(v) && v > 0
      ? BigInt(v)
      : typeof v === "string" && /^[1-9][0-9]{0,5}$/.test(v)
        ? BigInt(v)
        : WITHDRAW_FALLBACK_TGAS;
  return tgas * TGAS;
}

// NEAR account id rules (nearcore `AccountId`): 2–64 characters, lower-case letters, digits and
// `-` `_` separators inside dot-separated parts. Implicit accounts (64 hex, or 0x + 40 hex) fit.
const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/**
 * Why `input` cannot be the payout account, or null when it can. It must be a valid account id,
 * not this account (that is what strands the tokens) and not the contract (which refuses it).
 */
export function payoutProblem(input: string, me: string, contract: string): string | null {
  const id = input.trim();
  if (!id) return "Enter the NEAR account to withdraw to.";
  if (id !== id.toLowerCase()) return "NEAR account names are lower case.";
  if (id.length < 2 || id.length > 64 || !ACCOUNT_ID.test(id)) return "That isn't a NEAR account name.";
  if (id === me) return "That's this game account. Enter a wallet you hold the keys to.";
  if (id === contract) return "That's the game contract. Enter your own wallet.";
  return null;
}

/** The withdraw call; `to` only when the payout is still the account itself. */
export function withdrawCall(o: { token: string; amount: bigint; gas: bigint; to?: string }): FunctionCall {
  return {
    methodName: "withdraw",
    args: {
      token: o.token,
      amount: o.amount.toString(),
      ...(o.to === undefined ? {} : { to: o.to.trim() }),
    },
    gas: o.gas,
  };
}
