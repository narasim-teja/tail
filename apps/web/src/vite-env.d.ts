/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RELAY_URL?: string;
  readonly VITE_TAIL_CONTRACT?: string;
  readonly VITE_NEAR_RPC_TESTNET?: string;
  readonly VITE_NEAR_RPC_MAINNET?: string;
  readonly VITE_REPO_URL?: string;
  readonly VITE_DOCS_URL?: string;
  readonly VITE_DOSSIER_ACCOUNT?: string;
  readonly VITE_SITE_URL?: string;
}
