// What NEAR says about a published match, for its row on the front page: how the pinned contract
// settled it (`get_match`'s `settled_as`), read live. This is the contract's own record of the
// payout, not the replay's checks: the replay re-checks everything when the row is opened.

import type { ChainState } from "../verify/anchor.ts";

export type RowState =
  | "paid"
  /** Paid out by the contract before protocol v2, which did not replay the match first. */
  | "paid-unreplayed"
  | "refunded"
  /** On NEAR, not settled yet (running, or ended and waiting). */
  | "open"
  /** The pinned contract has no such match. */
  | "absent"
  | "unreachable"
  | "checking";

export function rowState(c: ChainState): RowState {
  if (c.kind === "unreachable") return "unreachable";
  if (c.kind === "absent") return "absent";
  switch (c.match.settled_as) {
    case "payout":
      return "paid";
    case "payout_unreplayed":
      return "paid-unreplayed";
    case "refunded_rule_violation":
    case "refunded_abort":
      return "refunded";
    default:
      return "open";
  }
}

export const ROW_WORDS: Record<RowState, string> = {
  paid: "Paid out on NEAR",
  "paid-unreplayed": "Paid out on NEAR, before replay checks",
  refunded: "Refunded on NEAR",
  open: "Not settled on NEAR yet",
  absent: "Not on NEAR",
  unreachable: "NEAR didn't answer",
  checking: "Asking NEAR",
};

/** Reads each match from the pinned contract; the RPC client loads only when there is a row. */
export async function readRows(ids: readonly string[]): Promise<Map<string, RowState>> {
  const [{ nearReader }, { PINS }] = await Promise.all([
    import("../verify/chain.ts"),
    import("../verify/pins.ts"),
  ]);
  const reader = nearReader(PINS.network);
  const states = await Promise.all(
    ids.map(async (id) => [id, rowState(await reader.read(PINS.contract, id))] as const),
  );
  return new Map(states);
}
