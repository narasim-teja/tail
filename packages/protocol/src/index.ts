export * from "./borsh.ts";
export * from "./bytes.ts";
export * from "./constants.ts";
export * from "./crypto.ts";
export * from "./messages.ts";
export * from "./replay.ts";

import { HINT_BPS, type HintKind } from "./constants.ts";

/** Hint price: HINT_BPS[kind] × stake / 10 000, rounded down. Paid from asker's head to target's. */
export const hintPrice = (stake: bigint, kind: HintKind) => (stake * BigInt(HINT_BPS[kind])) / 10_000n;
