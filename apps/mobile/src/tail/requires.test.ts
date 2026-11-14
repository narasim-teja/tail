import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  belowRule,
  boundRequires,
  dossierRefusal,
  parseRecord,
  parseRequires,
  REQUIRE,
  recordText,
  refusalText,
  requiresText,
} from "./requires";

describe("a lobby open only to players with a record", () => {
  test("the form keeps played within bounds and survived at or under played", () => {
    expect(boundRequires({ minMatches: 0, minSurvived: 0 })).toEqual({ minMatches: 1, minSurvived: 0 });
    expect(boundRequires({ minMatches: 99, minSurvived: 99 })).toEqual({
      minMatches: REQUIRE.max,
      minSurvived: REQUIRE.max,
    });
    // Lowering played pulls survived down with it.
    expect(boundRequires({ minMatches: 2, minSurvived: 5 })).toEqual({ minMatches: 2, minSurvived: 2 });
    expect(boundRequires({ minMatches: 4, minSurvived: -1 })).toEqual({ minMatches: 4, minSurvived: 0 });
  });

  test("a host whose own record misses the rule is warned; one that meets it is not", () => {
    const rule = { minMatches: 3, minSurvived: 1 };
    expect(belowRule({ matches: 2, survived: 2 }, rule)).toBe(true);
    expect(belowRule({ matches: 5, survived: 0 }, rule)).toBe(true);
    expect(belowRule({ matches: 3, survived: 1 }, rule)).toBe(false);
    expect(belowRule({ matches: 9, survived: 4 }, rule)).toBe(false);
  });

  test("the rule and a record in plain words", () => {
    expect(requiresText({ minMatches: 3, minSurvived: 1 })).toBe("Needs 3 matches played and 1 survived");
    expect(requiresText({ minMatches: 1, minSurvived: 0 })).toBe("Needs 1 match played");
    expect(recordText({ matches: 1, survived: 0 })).toBe("You have 1 played and 0 survived.");
  });

  test("the contract's refusal names the rule, and the player's record when the app has it", () => {
    const raw = "your dossier is below this match's requires: 3 settled matches and 1 survived";
    const rule = dossierRefusal(raw);
    expect(rule).toEqual({ minMatches: 3, minSurvived: 1 });
    if (!rule) throw new Error("unreachable");
    expect(refusalText(rule, { matches: 1, survived: 0 })).toBe(
      "This lobby needs 3 matches played and 1 survived. You have 1 played and 0 survived. " +
        "Only matches that paid out count.",
    );
    expect(refusalText(rule, null)).toBe(
      "This lobby needs 3 matches played and 1 survived. Only matches that paid out count.",
    );
    expect(dossierRefusal("match is full")).toBeNull();
  });

  test("the refusal is read in the contract's own words (contracts/tail lib.rs join_match)", () => {
    const lib = readFileSync(new URL("../../../../contracts/tail/src/lib.rs", import.meta.url), "utf8");
    const panic = /"(your dossier is below this match's requires: [^"]*)"/.exec(lib)?.[1];
    expect(panic).toBeDefined();
    const said = `Smart contract panicked: ${(panic ?? "").replace("{}", "7").replace("{}", "2")}`;
    expect(dossierRefusal(said)).toEqual({ minMatches: 7, minSurvived: 2 });
  });

  test("the chain's rule and the player's dossier are read strictly", () => {
    expect(parseRequires(null)).toBeNull();
    expect(parseRequires(undefined)).toBeNull();
    expect(parseRequires({ min_matches: 2, min_survived: 0 })).toEqual({ minMatches: 2, minSurvived: 0 });
    expect(() => parseRequires({ min_matches: -1, min_survived: 0 })).toThrow("min_matches is not a count");
    // No dossier is what join_match reads as an empty record.
    expect(parseRecord(null)).toEqual({ matches: 0, survived: 0 });
    expect(parseRecord({ matches: 4, survived: 2, tags: 1 })).toEqual({ matches: 4, survived: 2 });
    expect(() => parseRecord({ matches: 4 })).toThrow("survived is not a count");
  });
});
