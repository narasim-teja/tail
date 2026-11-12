// The relay's NEAR side, and the only file that knows the contract's method names and JSON
// shapes. The relay pays for player accounts and their registration, hosts matches (create,
// lock), and submits the referee's signed verdicts. It never signs what a player key signs
// (join_match, leave_lobby, withdraw): those keys live on the phones.

import type { Logger } from "@tail/log";
import {
  Account,
  actions,
  baseEncode,
  JsonRpcProvider,
  type KeyPairString,
  nearToYocto,
  PublicKey,
  teraToGas,
} from "near-api-js";

/**
 * The only methods a player's key may call. `register` is not among them: registration costs a
 * storage deposit, which a function-call key cannot attach (F18), so the relay calls the payable
 * `register_for` when it creates the account.
 */
export const PLAYER_METHODS = ["join_match", "leave_lobby", "withdraw"];
/** Allowance is charged against prepaid gas, so 0.05 runs out after two calls (S4). */
export const PLAYER_ALLOWANCE = "0.5";
export const PLAYER_FUNDING = "0.1";
/** NEP-145 storage for one account on the token, so `withdraw` can pay it. */
export const TOKEN_STORAGE = "0.00125";
/** Each verdict burns at most ~2.5 Tgas on the contract; 20 per call stays well inside 300 Tgas. */
export const MAX_VERDICTS_PER_APPLY = 20;

export interface ContractConfig {
  owner: string;
  referee_pk: string;
  vrf_pk: string;
  allowed_tokens: string[];
  match_storage_deposit: string;
  /** Exact deposit `register_for` needs (payout record plus a balance per token). */
  registration_deposit: string;
  min_players: number;
  max_players: number;
  max_duration_ms: number;
}

export interface ChainPlayer {
  account_id: string;
  head: string;
  out: boolean;
  paid: string;
}

export interface ChainMatch {
  match_id: string;
  host: string;
  token: string;
  stake: string;
  duration_ms: number;
  zone_hash: string;
  public_replay: boolean;
  min_players: number;
  max_players: number;
  start_by_ms: number;
  phase: "lobby" | "running" | "ended" | "aborted";
  players: ChainPlayer[];
  invites: string[];
  /** Set by `lock_lobby`: no joins from then on, no leaves until this time. */
  locked_until_ms: number | null;
  sponsor_pot: string;
  seq: number;
  referee_pk: string;
  vrf_pk: string;
  ring_commit: string | null;
  start_ms: number | null;
  end_ms: number | null;
  alpha: string | null;
  vrf_signature: string | null;
}

export interface ChainRoots {
  checkpoints: { log_size: number; root: string }[];
  final_root: { log_size: number; root: string } | null;
}

export interface MatchCfg {
  token: string;
  stake: string;
  duration_ms: number;
  zone_hash: string;
  public_replay: boolean;
  min_players: number;
  max_players: number;
  start_by_ms: number;
  /** Who may join; empty means any registered account. */
  invites: string[];
}

/** Everything the relay does on chain, as an interface so tests can run without NEAR. */
export interface Chain {
  config(): Promise<ContractConfig>;
  accountExists(accountId: string): Promise<boolean>;
  /**
   * Creates `accountId` with only a function-call key (`nearPk`, 32 bytes), registers it on the
   * token (so `withdraw` can pay it) and in the contract with itself as the payout account.
   * Idempotent for an account this relay created with the same key; throws AccountTakenError
   * for any other existing account.
   */
  createPlayerAccount(accountId: string, nearPk: Uint8Array): Promise<void>;
  createMatch(cfg: MatchCfg): Promise<string>;
  /** Freezes joins and leaves; the referee `start` follows. Host (relay) only. */
  lockLobby(matchId: string): Promise<void>;
  getMatch(matchId: string): Promise<ChainMatch | null>;
  getRoots(matchId: string): Promise<ChainRoots | null>;
  getHeads(matchId: string): Promise<string[] | null>;
  getBalance(accountId: string, token: string): Promise<bigint>;
  /** Submits borsh SignedVerdicts in order in one `apply`; returns the transaction hash. */
  apply(verdicts: Uint8Array[]): Promise<string>;
  /** Testnet only: mints the test token to the relay and credits it to `accountId` in the contract. */
  topUp(accountId: string, amount: bigint): Promise<void>;
}

/** The account exists and is not one this relay created for this key. */
export class AccountTakenError extends Error {
  override name = "AccountTakenError";
}

export function nearPublicKey(raw: Uint8Array): PublicKey {
  if (raw.length !== 32) throw new Error("near_pk must be a 32-byte ed25519 public key");
  return PublicKey.fromString(`ed25519:${baseEncode(raw)}`);
}

export class NearChain implements Chain {
  readonly provider: JsonRpcProvider;
  readonly relay: Account;

  constructor(
    private readonly o: {
      rpcUrl: string;
      relayAccount: string;
      relayPrivateKey: string;
      contract: string;
      token: string;
    },
    private readonly log: Logger,
  ) {
    this.provider = new JsonRpcProvider({ url: o.rpcUrl });
    this.relay = new Account(o.relayAccount, this.provider, o.relayPrivateKey as KeyPairString);
  }

  // Optimistic finality: the loop reads get_match().seq right after its own apply, and a
  // `final` read lags a few blocks, which would resend verdicts the chain already has.
  private view<T>(method: string, args: Record<string, unknown>, contractId = this.o.contract): Promise<T> {
    return this.provider.callFunction({
      contractId,
      method,
      args,
      blockQuery: { finality: "optimistic" },
    }) as Promise<T>;
  }

  config() {
    return this.view<ContractConfig>("get_config", {});
  }

  async accountExists(accountId: string) {
    try {
      await this.provider.viewAccount({ accountId });
      return true;
    } catch (e) {
      // Only "does not exist" means no; any other failure (RPC down) must not look like a free name.
      if (/does not exist|UNKNOWN_ACCOUNT|doesn't exist/i.test(String((e as Error).message))) return false;
      throw e;
    }
  }

  async createPlayerAccount(accountId: string, nearPk: Uint8Array) {
    if (await this.accountExists(accountId)) {
      // Only the relay can create its sub-accounts. One that holds exactly this key is ours from
      // an enrolment that failed after account creation; finishing it is safe. Anything else is taken.
      const { keys } = await this.provider.viewAccessKeyList({ accountId });
      const want = nearPublicKey(nearPk).toString();
      if (
        keys.length !== 1 ||
        keys[0]?.public_key !== want ||
        keys[0].access_key.permission === "FullAccess"
      ) {
        throw new AccountTakenError(`${accountId} already exists`);
      }
    } else await this.createAccount(accountId, nearPk);
    await this.registerOnToken(accountId);
    await this.registerInContract(accountId);
    this.log.info({ accountId }, "player account ready");
  }

  private async createAccount(accountId: string, nearPk: Uint8Array) {
    await this.relay.signAndSendTransaction({
      receiverId: accountId,
      actions: [
        actions.createAccount(),
        actions.transfer(nearToYocto(PLAYER_FUNDING)),
        actions.addFunctionCallAccessKey(
          nearPublicKey(nearPk),
          this.o.contract,
          PLAYER_METHODS,
          nearToYocto(PLAYER_ALLOWANCE),
        ),
      ],
    });
  }

  private async registerInContract(accountId: string) {
    if (await this.view<string | null>("get_payout", { account_id: accountId })) return;
    const deposit = (await this.config()).registration_deposit;
    if (!deposit) throw new Error("the deployed contract has no registration_deposit in get_config");
    await this.relay.callFunction({
      contractId: this.o.contract,
      methodName: "register_for",
      args: { account_id: accountId, payout_account: accountId },
      gas: teraToGas("30"),
      deposit: BigInt(deposit),
    });
  }

  private async registerOnToken(accountId: string) {
    const reg = await this.view<unknown>("storage_balance_of", { account_id: accountId }, this.o.token);
    if (reg) return;
    await this.relay.callFunction({
      contractId: this.o.token,
      methodName: "storage_deposit",
      args: { account_id: accountId },
      gas: teraToGas("30"),
      deposit: nearToYocto(TOKEN_STORAGE),
    });
  }

  async createMatch(cfg: MatchCfg) {
    const { match_storage_deposit } = await this.config();
    const id = await this.relay.callFunction<string>({
      contractId: this.o.contract,
      methodName: "create_match",
      args: { cfg },
      gas: teraToGas("30"),
      deposit: BigInt(match_storage_deposit),
    });
    if (typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id))
      throw new Error("create_match returned no match id");
    return id;
  }

  async lockLobby(matchId: string) {
    await this.relay.callFunction({
      contractId: this.o.contract,
      methodName: "lock_lobby",
      args: { match_id: matchId },
      gas: teraToGas("30"),
    });
  }

  getMatch(matchId: string) {
    return this.view<ChainMatch | null>("get_match", { match_id: matchId });
  }

  getRoots(matchId: string) {
    return this.view<ChainRoots | null>("get_roots", { match_id: matchId });
  }

  getHeads(matchId: string) {
    return this.view<string[] | null>("get_heads", { match_id: matchId });
  }

  async getBalance(accountId: string, token: string) {
    return BigInt(await this.view<string>("get_balance", { account_id: accountId, token }));
  }

  async apply(verdicts: Uint8Array[]) {
    const res = await this.relay.callFunctionRaw({
      contractId: this.o.contract,
      methodName: "apply",
      args: { verdicts: verdicts.map((v) => Buffer.from(v).toString("base64")) },
      gas: teraToGas(Math.min(300, 100 + 10 * verdicts.length)),
    });
    return res.transaction.hash;
  }

  /** Owner only (the relay account owns the contract). Changes the keys new matches pin. */
  async pinKeys(keys: { refereePk?: string; vrfPk?: string }) {
    for (const [methodName, arg, value] of [
      ["set_referee_pk", "referee_pk", keys.refereePk],
      ["set_vrf_pk", "vrf_pk", keys.vrfPk],
    ] as const) {
      if (!value) continue;
      await this.relay.callFunction({
        contractId: this.o.contract,
        methodName,
        args: { [arg]: value },
        gas: teraToGas("30"),
        deposit: 1n,
      });
    }
  }

  /** The relay account's NEAR balance in yocto, for spend reports. */
  async relayBalance(): Promise<bigint> {
    const a = await this.provider.viewAccount({ accountId: this.o.relayAccount });
    return BigInt(a.amount);
  }

  async topUp(accountId: string, amount: bigint) {
    if (this.o.token !== "usdc.fakes.testnet") throw new Error("top-up mints only usdc.fakes.testnet");
    await this.registerOnToken(this.o.relayAccount);
    await this.relay.callFunction({
      contractId: this.o.token,
      methodName: "mint",
      args: { account_id: this.o.relayAccount, amount: amount.toString() },
      gas: teraToGas("30"),
    });
    const before = await this.getBalance(accountId, this.o.token);
    await this.relay.callFunction({
      contractId: this.o.token,
      methodName: "ft_transfer_call",
      args: {
        receiver_id: this.o.contract,
        amount: amount.toString(),
        msg: JSON.stringify({ credit: accountId }),
      },
      gas: teraToGas("60"),
      deposit: 1n,
    });
    // The contract refunds a credit it refuses (an unregistered account) instead of failing.
    if ((await this.getBalance(accountId, this.o.token)) < before + amount) {
      throw new Error(`the contract refused the credit for ${accountId} (is it registered?)`);
    }
  }
}
