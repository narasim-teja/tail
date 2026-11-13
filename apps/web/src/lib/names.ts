// Players' names as the replay and the front page show them, from their NEAR accounts.

/**
 * Ghost accounts (`ghost-<random>`) are the relay's test players, its testing door; their random
 * handle means nothing, so each is "Test player" and the first character of its handle.
 */
const GHOST = "ghost-";
const handleOf = (account: string) => account.split(".")[0] ?? account;
const ghostLetter = (account: string) =>
  handleOf(account)
    .slice(GHOST.length, GHOST.length + 1)
    .toUpperCase();

export function displayName(account: string): string {
  const head = handleOf(account);
  if (head.startsWith(GHOST)) return `Test player ${ghostLetter(account)}`.trim();
  const clean = head.replace(/[-_]+/g, " ").trim() || account;
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

/**
 * Names for the players of one match. Test players stay apart: by their handle's letter while no
 * two share one, else numbered in player order (1, 2, 3…), so no two read the same.
 */
export function displayNames(accounts: readonly string[]): string[] {
  const ghosts = accounts.filter((a) => handleOf(a).startsWith(GHOST));
  const letters = ghosts.map(ghostLetter);
  const distinct = letters.every((l, i) => l !== "" && letters.indexOf(l) === i);
  return accounts.map((a) =>
    handleOf(a).startsWith(GHOST) && !distinct ? `Test player ${ghosts.indexOf(a) + 1}` : displayName(a),
  );
}

/** One letter when it is unique in the match, else the shortest unique pair, else a number. */
export function initialsFor(names: string[]): string[] {
  const firsts = names.map((n) => n.charAt(0).toUpperCase());
  return names.map((n, i) => {
    const f = firsts[i] as string;
    if (firsts.filter((x) => x === f).length === 1) return f;
    const letters = n.replace(/[^a-z0-9]/gi, "").toUpperCase();
    for (let j = 1; j < letters.length; j++) {
      const pair = f + letters.charAt(j);
      const clash = names.some((m, k) => {
        if (k === i) return false;
        const other = m.replace(/[^a-z0-9]/gi, "").toUpperCase();
        return other.charAt(0) === f && other.includes(letters.charAt(j), 1);
      });
      if (!clash) return pair;
    }
    return `${f}${i + 1}`;
  });
}
