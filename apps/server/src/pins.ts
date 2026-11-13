// What main.ts checks before the relay serves: that the contract pins the referee the relay runs
// with. The contract checks every verdict against the keys and the VRF caller it pins, so beside
// another referee every verdict would be refused mid-match.

import { toHex } from "@tail/protocol";
import type { Config } from "./config.ts";
import type { ContractConfig } from "./near.ts";
import type { RefereeKeys } from "./referee.ts";

/**
 * Why the relay must not serve with this referee and contract, or null. `keys` is the referee's
 * `pubkeys` answer, or the error it failed with. OutLayer can be briefly unavailable, so an
 * enclave that does not answer cannot be checked and the relay starts anyway (the guard reports
 * it down); the local test referee is a binary on this machine, and one that does not answer is
 * missing or broken, which no wait will mend.
 */
export function pinProblem(
  config: Pick<Config, "refereeMode" | "vrfSender">,
  pinned: Pick<ContractConfig, "referee_pk" | "vrf_pk" | "vrf_sender">,
  keys: RefereeKeys | Error,
): string | null {
  const pin = `run REFEREE_MODE=${config.refereeMode} bun apps/server/scripts/pin-referee.ts`;
  if (keys instanceof Error) {
    return config.refereeMode === "local"
      ? `the local test referee does not answer (${keys.message}); build it with cargo build --release --manifest-path crates/referee-wasi/Cargo.toml --bin tail-referee, or set LOCAL_REFEREE_BIN`
      : null;
  }
  if (
    pinned.referee_pk !== toHex(keys.refereePk) ||
    pinned.vrf_pk !== toHex(keys.vrfPk) ||
    pinned.vrf_sender !== config.vrfSender
  )
    return `the contract pins another referee's keys or VRF caller; ${pin}`;
  return null;
}
