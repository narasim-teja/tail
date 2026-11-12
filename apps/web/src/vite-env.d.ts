/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RELAY_URL?: string;
  readonly VITE_TAIL_CONTRACT?: string;
  readonly VITE_NEAR_RPC_TESTNET?: string;
  readonly VITE_NEAR_RPC_MAINNET?: string;
}
