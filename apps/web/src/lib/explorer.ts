// Links into the NEAR explorer, for a network.

const EXPLORER: Record<string, string> = {
  mainnet: "https://nearblocks.io",
  testnet: "https://testnet.nearblocks.io",
};
const base = (network: string) => EXPLORER[network] ?? (EXPLORER["testnet"] as string);

export const explorerTx = (network: string, hash: string) => `${base(network)}/txns/${hash}`;
export const explorerAccount = (network: string, account: string) => `${base(network)}/address/${account}`;
