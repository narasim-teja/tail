// Pins the referee's keys in the contract (testnet only): its `verdicts` signing key as
// referee_pk and its VRF key as vrf_pk, both read from the referee's `pubkeys`. With
// REFEREE_MODE=local those are the local test referee's keys; with the default, the enclave's.
// Signed by NEAR_RELAY_ACCOUNT, the contract owner, with 1 yocto each. Matches created afterwards
// pin these keys; running ones keep theirs. Does nothing when the keys already match.
//
//   bun apps/server/scripts/pin-referee.ts

import { createLogger } from "@tail/log";
import { toHex } from "@tail/protocol";
import { loadConfig, loadRepoEnv } from "../src/config.ts";
import { NearChain } from "../src/near.ts";
import { makeReferee } from "../src/referee.ts";

loadRepoEnv();
const config = loadConfig(process.env);
const log = createLogger("pin-referee");
const chain = new NearChain(config, log);
const referee = makeReferee(config);

const keys = await referee.pubkeys();
const want = { referee_pk: toHex(keys.refereePk), vrf_pk: toHex(keys.vrfPk) };
const before = await chain.config();
console.log(`contract ${config.contract}, owner ${before.owner}`);
console.log(`referee_pk: chain ${before.referee_pk}, referee ${want.referee_pk}`);
console.log(`vrf_pk:     chain ${before.vrf_pk}, referee ${want.vrf_pk}`);
if (before.owner !== config.relayAccount) throw new Error(`${config.relayAccount} does not own the contract`);

await chain.pinKeys({
  ...(before.referee_pk !== want.referee_pk ? { refereePk: want.referee_pk } : {}),
  ...(before.vrf_pk !== want.vrf_pk ? { vrfPk: want.vrf_pk } : {}),
});
const after = await chain.config();
const ok = after.referee_pk === want.referee_pk && after.vrf_pk === want.vrf_pk;
console.log(ok ? "pinned: the contract now pins this referee's keys" : "FAILED: keys still differ");
console.log(`OutLayer spend: $${referee.spendUsd().toFixed(4)}`);
process.exit(ok ? 0 : 1);
