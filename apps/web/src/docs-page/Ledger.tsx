// One stake, one number (the docs): a worked hunt as a ledger, every figure from the pricing rule
// at the site's example stake, moved the way the contract moves it (a hint into the pool, the
// pool's debt onto the target when they fall, their head to the hunter). The last column never
// changes.

import { HINT_NAME, HintKind, PRICE_WINDOW_MS } from "@tail/protocol";
import { priceAt, STAKE, say, usdc } from "../landing/rules.ts";

/** Players at the example table. */
export const TABLE = 5;

export interface LedgerRow {
  what: string;
  you: bigint;
  target: bigint | null;
  pool: bigint;
}

export function ledger(stake: bigint = STAKE): LedgerRow[] {
  const first = priceAt(HintKind.Bearing, 0, stake);
  const second = priceAt(HintKind.Near, 1, stake);
  const you0 = stake;
  const you1 = you0 - first;
  const you2 = you1 - second;
  const won = you2 + stake + first + second;
  return [
    { what: "Everyone stakes", you: you0, target: stake, pool: 0n },
    {
      what: `You buy ${HINT_NAME[HintKind.Bearing]}, at its base price`,
      you: you1,
      target: stake,
      pool: first,
    },
    {
      what: `Then ${HINT_NAME[HintKind.Near]}: one hint in the last ${PRICE_WINDOW_MS / 60_000} minutes makes it dearer`,
      you: you2,
      target: stake,
      pool: first + second,
    },
    { what: "You strike: their head, and what you paid onto it", you: won, target: null, pool: 0n },
  ];
}

/** The worked hunt as a ledger: every figure from the pricing rule; the last column never changes. */
export function Ledger() {
  const rows = ledger();
  const others = STAKE * BigInt(TABLE - 2);
  const total = STAKE * BigInt(TABLE);
  return (
    <figure className="d-ledger">
      <div className="d-ledger-scroll">
        <table>
          <caption className="l-visually-hidden">A hunt at a table of {say(TABLE)}, in USDC</caption>
          <thead>
            <tr>
              <th scope="col">Move</th>
              <th scope="col">You</th>
              <th scope="col">Your target</th>
              <th scope="col">Hint pool</th>
              <th scope="col">Table</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.what}>
                <th scope="row">{r.what}</th>
                <td data-k="You">{usdc(r.you)}</td>
                <td data-k="Target">{r.target === null ? <span className="d-out">out</span> : usdc(r.target)}</td>
                <td data-k="Pool">{usdc(r.pool)}</td>
                <td data-k="Table" className="d-total">
                  {usdc(r.you + (r.target ?? 0n) + r.pool + others)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <figcaption>
        A table of {say(TABLE)} at {usdc(STAKE)} USDC each, priced by the rule above; the other {say(TABLE - 2)} hold{" "}
        {usdc(others)}. The table holds {usdc(total)} at every step.
      </figcaption>
    </figure>
  );
}
