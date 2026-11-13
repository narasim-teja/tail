// Writes vectors/dossier.json: dossier views and the SVG `dossierSvg` draws for each. The
// contract's Rust builder (contracts/tail/src/art.rs) must produce the same bytes; both sides
// test against this file. Regenerate only when the art changes on purpose:
// `bun run --cwd packages/brand dossier-vectors`.

import { createHash } from "node:crypto";
import { type DossierEntry, type DossierResult, type DossierView, dossierSvg } from "../src/dossier.ts";

const seed = (account: string) => createHash("sha256").update(account).digest("hex");
const hex = (b: number, n: number) => b.toString(16).padStart(2, "0").repeat(n);

function view(account: string, results: [DossierResult, number][]): DossierView {
  // Newest first, as the contract returns them.
  const entries: DossierEntry[] = results
    .map(([result, tags], i) => ({
      match_id: hex(i + 1, 16),
      result,
      tags,
      payout: result === "survived" ? "2500000" : result === "refunded" ? "1000000" : "0",
      log_size: String(100 + i),
      root: hex(0xa0 + i, 32),
    }))
    .reverse();
  const settled = results.filter(([r]) => r !== "refunded");
  return {
    account_id: account,
    seed: seed(account),
    matches: settled.length,
    survived: settled.filter(([r]) => r === "survived").length,
    tags: settled.reduce((a, [, t]) => a + t, 0),
    forfeits: settled.filter(([r]) => r === "forfeit").length,
    refunded: results.length - settled.length,
    won: String(entries.reduce((a, e) => a + (e.result === "refunded" ? 0n : BigInt(e.payout)), 0n)),
    entries,
  };
}

export const cases: { name: string; view: DossierView }[] = [
  { name: "new player", view: view("ana.tail-dev-a38d13.testnet", []) },
  {
    name: "a few matches",
    view: view("eli.tail-dev-a38d13.testnet", [
      ["tagged", 0],
      ["survived", 2],
      ["refunded", 0],
      ["forfeit", 1],
      ["survived", 1],
    ]),
  },
  {
    name: "a full record",
    view: view("dee.tail-dev-a38d13.testnet", [
      ["survived", 3],
      ["tagged", 1],
      ["survived", 0],
      ["refunded", 0],
      ["tagged", 0],
      ["survived", 2],
      ["forfeit", 0],
      ["survived", 4],
      ["tagged", 2],
      ["refunded", 0],
      ["survived", 1],
      ["survived", 5],
    ]),
  },
  {
    // The largest card: a 64-character id and every match an 11-tag survival.
    name: "maximal",
    view: view(
      `${"x".repeat(56)}.testnet`,
      Array.from({ length: 12 }, (): [DossierResult, number] => ["survived", 11]),
    ),
  },
];

if (import.meta.main) {
  const out = cases.map(({ name, view: v }) => ({ name, view: v, svg: dossierSvg(v) }));
  await Bun.write(new URL("../vectors/dossier.json", import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
  for (const c of out) console.log(`${c.name}: ${c.svg.length} bytes`);
}
