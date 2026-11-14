// Lobbies open only to players with a record (contracts/tail `create_match`'s `requires`): the
// contract refuses `join_match` to anyone whose Dossier has fewer settled matches played or
// survived. The contract owns that rule; the app never decides it. This module bounds the Create
// form, words the rule and the player's own record, and reads the contract's refusal back.

/** A lobby's rule: at least this many settled matches played, and survived. */
export interface Requires {
  minMatches: number;
  minSurvived: number;
}

/** What a player's Dossier counts: settled matches played and survived (refunds don't count). */
export interface DossierRecord {
  matches: number;
  survived: number;
}

/**
 * The Create form's bounds. The relay takes up to 1000; 20 settled matches is already a veteran.
 * Played starts at 1: a rule of 0 played (and so 0 survived) lets everyone in, which is the
 * "Everyone" choice.
 */
export const REQUIRE = { min: 1, max: 20 } as const;

/** The rule inside the form's bounds, survived never above played. */
export function boundRequires(r: Requires): Requires {
  const minMatches = Math.min(REQUIRE.max, Math.max(REQUIRE.min, Math.trunc(r.minMatches)));
  return { minMatches, minSurvived: Math.min(minMatches, Math.max(0, Math.trunc(r.minSurvived))) };
}

const matchesWord = (n: number) => (n === 1 ? "match" : "matches");

/** "3 matches played and 1 survived"; "1 match played". */
export function ruleText(r: Requires): string {
  const played = `${r.minMatches} ${matchesWord(r.minMatches)} played`;
  return r.minSurvived > 0 ? `${played} and ${r.minSurvived} survived` : played;
}

/** "Needs 3 matches played and 1 survived". */
export const requiresText = (r: Requires) => `Needs ${ruleText(r)}`;

/**
 * Whether a record falls short of a rule, for Create's warning to a host who would set a rule
 * their own record misses (the host joins their own lobby). Only a warning: `join_match` in the
 * contract is what decides (Dossier::meets), and Create stays enabled.
 */
export const belowRule = (d: DossierRecord, r: Requires) =>
  d.matches < r.minMatches || d.survived < r.minSurvived;

/** "You have 1 played and 0 survived." */
export const recordText = (d: DossierRecord) => `You have ${d.matches} played and ${d.survived} survived.`;

/**
 * Why the host can't create a lobby with this rule, as far as the app can tell, or null. The host
 * joins their own lobby at once, so the relay refuses a rule above the host's own record; this
 * mirrors that refusal before the tap. An unread record blocks nothing: the relay decides.
 */
export function hostBlock(record: DossierRecord | null, r: Requires | null): string | null {
  if (!r || !record) return null;
  if (record.matches < REQUIRE.min) return "You need a match that paid out first";
  return belowRule(record, r) ? "Your record is below this rule" : null;
}

type Obj = Record<string, unknown>;

const count = (o: Obj, k: string): number => {
  const v = o[k];
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new Error(`${k} is not a count`);
  return v;
};

/** `requires` in the contract's `get_match` view (snake_case), or null when the lobby has none. */
export function parseRequires(v: unknown): Requires | null {
  // Absent on a contract from before dossiers, null on a lobby anyone may join.
  if (v === null || v === undefined) return null;
  if (typeof v !== "object") throw new Error("requires is not an object");
  const o = v as Obj;
  return { minMatches: count(o, "min_matches"), minSurvived: count(o, "min_survived") };
}

/** The relay's `POST /matches` field (apps/server routes/matches.ts), passed to the contract as is. */
export const requiresBody = (r: Requires) => ({ min_matches: r.minMatches, min_survived: r.minSurvived });

/**
 * The player's record from the contract's `get_dossier`. An account without a dossier (registered
 * before dossiers existed) gets null there, and `join_match` reads it as an empty record, so it
 * is one here too.
 */
export function parseRecord(v: unknown): DossierRecord {
  if (v === null) return { matches: 0, survived: 0 };
  if (typeof v !== "object") throw new Error("dossier is not an object");
  const o = v as Obj;
  return { matches: count(o, "matches"), survived: count(o, "survived") };
}

// contracts/tail lib.rs join_match: the panic for a dossier below the lobby's rule.
const BELOW = /your dossier is below this match's requires: (\d+) settled matches and (\d+) survived/;

/** The rule a `join_match` refusal names, or null when the refusal is for something else. */
export function dossierRefusal(raw: string): Requires | null {
  const m = BELOW.exec(raw);
  return m?.[1] && m[2] ? { minMatches: Number(m[1]), minSurvived: Number(m[2]) } : null;
}

/** A join refused for the player's record, in plain words, with that record when the app has it. */
export function refusalText(r: Requires, record: DossierRecord | null): string {
  const rule = `This lobby needs ${ruleText(r)}.`;
  const mine = record ? ` ${recordText(record)}` : "";
  return `${rule}${mine} Only matches that paid out count.`;
}
