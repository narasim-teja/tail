// What this page trusts, fixed when it is built. Nothing here may come from the bundle: the relay
// that serves a bundle could run its own contract copy, its own referee or its own OutLayer
// mirror, so every value the page checks the bundle against is pinned in this file (or, for the
// contract, by VITE_TAIL_CONTRACT at build time) and reviewed like code.

export type Network = "testnet" | "mainnet";

export interface Pins {
  network: Network;
  /** The TAIL contract whose state is the anchor for every "Matches NEAR". */
  contract: string;
  /** OutLayer HTTPS API base the attestation records are read from. */
  outlayerApi: string;
  /** ed25519 verdict keys of the referee project on OutLayer, lowercase hex. */
  enclaveRefereePks: readonly string[];
  /** ed25519 verdict keys of the local test referee (the same code, not in an enclave). */
  localRefereePks: readonly string[];
  /** sha256 of every referee wasm build that was published, lowercase hex. */
  refereeWasmSha256: readonly string[];
}

const CONTRACT = import.meta.env.VITE_TAIL_CONTRACT || "tail.tail-dev-a38d13.testnet";

/** A NEAR account's network follows from its top-level name, so the two cannot disagree. */
export function networkOf(account: string): Network {
  return account.endsWith(".testnet") ? "testnet" : "mainnet";
}

const OUTLAYER_API: Record<Network, string> = {
  testnet: "https://testnet-api.outlayer.ai",
  mainnet: "https://api.outlayer.ai",
};

export const PINS: Pins = {
  network: networkOf(CONTRACT),
  contract: CONTRACT,
  outlayerApi: OUTLAYER_API[networkOf(CONTRACT)],
  // `pubkeys` of tail-dev-a38d13.testnet/tail-referee on OutLayer testnet (`referee_pk_hex`).
  enclaveRefereePks: ["e1c64271f1d5370eef04929835bbc60aab9ddef5b92f092217d287198a7d6c56"],
  // The local test referee's key (.keys/local-referee), pinned on the contract while OutLayer
  // testnet was down; read back with `get_config`.
  localRefereePks: ["d35338a9a4636d104deca3291c588cd9a7369c0b957b284b68be8ce64d286594"],
  // Referee builds published on OutLayer (crates/referee-wasi/README.md): the protocol v2 build
  // active since 2026-11-13, and the v1 build that judged the matches before it.
  refereeWasmSha256: [
    "3f9320a61236f02f72481c2ec2b920854f22c7554924a315eebbea52aad85690",
    "20446c643bd4b1cc8a017669596ed361506ad557c99464ecfe19beead6d08664",
  ],
};
