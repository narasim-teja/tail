// The end of the film: who is left, and the final standings. Everyone in order (still standing
// by head, then the rest by how long they lasted), what their head ended at, counted up from the
// stake, what they won or lost, and how each one went out. Then the two things people do next:
// watch it again, or see what was checked. Over the map, nothing boxed. A match the contract's
// replay refunds says so under the headline, and every head ends at the stake.

import { RotateCcw } from "lucide-react";
import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { Button } from "../components/ui/button.tsx";
import { clock, money } from "../lib/format.ts";
import { useStore } from "../lib/store.ts";
import { type Match, snapshotAt } from "../model/match.ts";
import { endLine, refundLine } from "../replay/copy.ts";
import { useReplay } from "./context.tsx";
import { GameIcon } from "./icons.tsx";
import { useTween } from "./tween.ts";

/** Each row arrives a beat after the one above it. */
const STAGGER_MS = 90;

interface Standing {
  index: number;
  name: string;
  initials: string;
  alive: boolean;
  head: bigint;
  /** When and how they went out, for those who did. */
  out: { t: number; how: string } | null;
}

/** Standing players by head, then the rest by how long they lasted. */
export function standings(m: Match): Standing[] {
  const end = snapshotAt(m, m.durationMs);
  const rows = m.players.map((p): Standing => {
    const alive = !!end.alive[p.index];
    let out: Standing["out"] = null;
    if (!alive)
      for (const e of m.events) {
        if (e.kind === "tag" && e.b === p.index)
          out = { t: e.t, how: `Tagged by ${m.players[e.a ?? -1]?.name ?? "their hunter"}` };
        if (e.kind === "forfeit" && e.a === p.index)
          out = { t: e.t, how: e.leftZone ? "Left the zone" : "Went dark" };
      }
    return { index: p.index, name: p.name, initials: p.initials, alive, head: end.heads[p.index] ?? 0n, out };
  });
  return rows.sort((a, b) =>
    a.alive !== b.alive
      ? Number(b.alive) - Number(a.alive)
      : a.alive
        ? Number(b.head - a.head)
        : (b.out?.t ?? 0) - (a.out?.t ?? 0),
  );
}

export function Finale({ compact }: { compact: boolean }) {
  const { match, verify, seek, select, reduced } = useReplay();
  const decimals = useStore(verify, (s) => s.token.decimals);
  const rows = standings(match);
  const refund = refundLine(match.settlement);
  // A short staggered reveal: the headline, each standing, then the actions.
  const enter = (i: number): { className: string; style?: CSSProperties } =>
    reduced
      ? { className: "" }
      : {
          className:
            "animate-in fade-in-0 slide-in-from-bottom-2 fill-mode-backwards duration-500 ease-out-quart",
          style: { animationDelay: `${i * STAGGER_MS}ms` },
        };
  return (
    <section
      aria-label="Final standings"
      className={cn(
        "pointer-events-auto mx-auto flex w-full flex-col",
        compact ? "max-w-full gap-3" : "max-w-[34rem] gap-4",
      )}
    >
      <h2
        style={enter(0).style}
        className={cn(
          enter(0).className,
          "over-map text-center font-bold leading-tight tracking-[-0.01em] text-balance [font-stretch:104%]",
          compact ? "text-[1.375rem]" : "text-[2rem]",
        )}
      >
        {endLine(match)}
      </h2>
      {refund && (
        <p
          style={enter(0).style}
          className={cn(enter(0).className, "over-map text-center text-[0.9375rem] text-balance text-text-2")}
        >
          {refund}
        </p>
      )}
      {/* Twelve players fit; past the room there is, the list scrolls rather than covering the map. */}
      <ol className={cn("flex flex-col overflow-y-auto", compact ? "max-h-[46dvh]" : "max-h-[52dvh]")}>
        {rows.map((r, i) => (
          <Row
            key={r.index}
            r={r}
            rank={i + 1}
            stake={match.stake}
            decimals={decimals}
            reduced={reduced}
            compact={compact}
            onPick={() => select({ kind: "player", index: r.index })}
            {...enter(i + 1)}
          />
        ))}
      </ol>
      <div
        style={enter(rows.length + 1).style}
        className={cn(enter(rows.length + 1).className, "flex justify-center gap-2")}
      >
        <Button variant="solid" onClick={() => seek(0, true)}>
          <RotateCcw />
          Watch again
        </Button>
        <Button variant="quiet" onClick={() => select({ kind: "summary" })}>
          <GameIcon name="verified" />
          What was checked
        </Button>
      </div>
    </section>
  );
}

function Row({
  r,
  rank,
  stake,
  decimals,
  reduced,
  compact,
  onPick,
  className,
  style,
}: {
  r: Standing;
  rank: number;
  stake: bigint;
  decimals: number;
  reduced: boolean;
  compact: boolean;
  onPick: () => void;
  className: string;
  style?: CSSProperties | undefined;
}) {
  const head = useTween(r.head, reduced, decimals, stake);
  const delta = r.head - stake;
  const won = rank === 1 && r.alive;
  return (
    <li className={className} style={style}>
      <button
        type="button"
        onClick={onPick}
        aria-label={`${rank}. ${r.name}, ${r.alive ? `head ${money(r.head, decimals)} USDC` : `out, ${r.out?.how ?? ""}`}, ${delta >= 0n ? "up" : "down"} ${money(delta < 0n ? -delta : delta, decimals)}`}
        className={cn(
          "grid w-full grid-cols-[1.25rem_auto_1fr_auto_auto] items-center gap-x-3 rounded-xl px-2 text-left outline-none",
          "transition-colors duration-150 hover:bg-surface-2/70 focus-visible:outline-2 focus-visible:outline-text",
          compact ? "min-h-11 py-1" : "min-h-12 py-1.5",
        )}
      >
        <span className="over-map numeral text-right text-[0.8125rem] font-semibold text-text-3">{rank}</span>
        <span
          aria-hidden="true"
          className={cn(
            "grid size-7 place-items-center rounded-full text-[0.75rem] font-bold leading-none",
            r.alive ? (won ? "bg-persimmon text-ink" : "bg-text text-ink") : "border border-rail text-text-3",
          )}
        >
          {r.initials}
        </span>
        <span className="min-w-0">
          <span
            className={cn("over-map block truncate font-semibold", r.alive ? "text-text" : "text-text-2")}
          >
            {r.name}
          </span>
          {r.out && (
            <span className="over-map block truncate text-[0.8125rem] text-text-3">
              {r.out.how}, {clock(r.out.t)}
            </span>
          )}
        </span>
        <span
          className={cn(
            "over-map numeral text-right font-bold",
            compact ? "text-[1rem]" : "text-[1.125rem]",
            r.alive ? "text-text" : "text-text-3",
          )}
        >
          {money(head, decimals)}
        </span>
        <span className="over-map numeral min-w-[4.5rem] text-right text-[0.8125rem] font-semibold text-text-2">
          {delta === 0n ? "even" : `${delta > 0n ? "+" : "−"}${money(delta < 0n ? -delta : delta, decimals)}`}
        </span>
      </button>
    </li>
  );
}
