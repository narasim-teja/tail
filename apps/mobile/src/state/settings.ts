// What a player may change (Settings > Advanced), kept in settings.json over what the build
// names. The contract is not a setting: the phone attests and holds its keys for the contract its
// build names (app.config.ts TAIL_CONTRACT), so neither a text box nor the relay may repoint it.

/** What the build names (app.config.ts `extra`); the settings file only overrides these. */
export interface BuildDefaults {
  /** TAIL_RELAY_URL; empty when the build names none, and first run then asks for one. */
  relayUrl: string;
  rpcUrl: string;
}

export interface Settings {
  relayUrl: string;
  rpcUrl: string;
  /**
   * Run the Offline Protocol mesh during a hunt (proximity/carry/mesh.ts). Off by default: whether the
   * mesh's Bluetooth advertising leaves room for TAIL's beacon token is not measured yet.
   */
  meshCarry: boolean;
}

/** The NEAR RPC a build uses unless the player sets another. */
export const DEFAULT_RPC = "https://test.rpc.fastnear.com";

/** An address as typed, without surrounding space or trailing slashes. */
export const cleanUrl = (u: string) => u.trim().replace(/\/+$/, "");

/**
 * The settings: the file's addresses where it holds one, else the build's. Older builds also kept
 * `contractId` and `replayUrl` here; both are ignored, never migrated (the build names the
 * contract, and the relay names the replay site).
 */
export function readSettings(text: string | null, build: BuildDefaults): Settings {
  const o = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  const url = (k: "relayUrl" | "rpcUrl") => {
    const v = o[k];
    return typeof v === "string" && cleanUrl(v) ? cleanUrl(v) : build[k];
  };
  return { relayUrl: url("relayUrl"), rpcUrl: url("rpcUrl"), meshCarry: o["meshCarry"] === true };
}

/**
 * The file for `s`: an address equal to the build's is stored empty, so the file holds only what
 * the player changed, and a later build's new default reaches a phone that never changed it.
 */
export function storedSettings(s: Settings, build: BuildDefaults): string {
  const own = (k: "relayUrl" | "rpcUrl") => (cleanUrl(s[k]) === build[k] ? "" : cleanUrl(s[k]));
  return JSON.stringify({ relayUrl: own("relayUrl"), rpcUrl: own("rpcUrl"), meshCarry: s.meshCarry });
}
