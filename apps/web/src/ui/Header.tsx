// Top-right: where and when, and the quiet verification line. Tapping the line opens the full
// account of what was checked.

import { cn } from "@/lib/utils";
import { day, minutes, money, timeOfDay } from "../lib/format.ts";
import { useStore } from "../lib/store.ts";
import { matchProblem, summarize, summaryLine } from "../verify/report.ts";
import { useReplay } from "./context.tsx";
import { Mark, TrailMark } from "./icons.tsx";
import { overall } from "./marks.ts";

export function Header({ place, compact }: { place: string | null | undefined; compact: boolean }) {
  const { match, verify, source, select, reduced } = useReplay();
  const statuses = useStore(verify, (s) => s.statuses);
  const localDone = useStore(verify, (s) => s.local.filter(Boolean).length);
  const chain = useStore(verify, (s) => s.chainSummary);
  const level = useStore(verify, (s) => s.level);
  const binding = useStore(verify, (s) => s.binding);
  const decimals = useStore(verify, (s) => s.token.decimals);
  const sum = summarize(statuses);
  const problem = matchProblem(binding, level);
  const line = summaryLine(sum, chain, problem, localDone);
  const status = overall(sum, chain, problem);
  const title = place === undefined ? null : (place ?? `Match ${match.id.slice(0, 6)}`);

  return (
    <header
      className={cn("pointer-events-auto flex flex-col", compact ? "items-start" : "items-end text-right")}
    >
      <div className={cn("flex items-center gap-2.5", compact ? "" : "flex-row-reverse")}>
        <TrailMark className={compact ? "size-5" : "size-6"} />
        {/* The height is held while the name loads, so nothing below it jumps. */}
        <h1
          className={cn(
            "over-map min-h-[1em] font-bold leading-none tracking-[-0.012em] [font-stretch:108%]",
            compact ? "text-[1.25rem]" : "text-[1.75rem]",
            title && !reduced && "animate-in fade-in-0 duration-700",
          )}
        >
          {title ?? <span className="sr-only">Loading the place name</span>}
        </h1>
      </div>
      <p
        className={cn("over-map numeral mt-1.5 text-text-2", compact ? "text-[0.75rem]" : "text-[0.875rem]")}
      >
        {day(match.startMs)} · {timeOfDay(match.startMs)} · {minutes(match.durationMs)} ·{" "}
        {money(match.stake, decimals)} USDC each
      </p>
      {!match.hasTrails && (
        <p className={cn("over-map mt-1 text-text-3", compact ? "text-[0.75rem]" : "text-[0.8125rem]")}>
          Paths weren't released for this match
        </p>
      )}
      <button
        type="button"
        onClick={() => select({ kind: "summary" })}
        className={cn(
          "mt-2 inline-flex min-h-9 items-center gap-2 rounded-full px-1 text-[0.875rem] font-semibold outline-none",
          "hover:text-text focus-visible:outline-2 focus-visible:outline-text",
          compact ? "-ml-1" : "-mr-1",
          status === "mismatch" ? "text-text" : "text-text-2",
        )}
      >
        <Mark status={status} labelled={false} className="size-[1.125rem]" />
        <span className="over-map" aria-live="polite">
          {line}
        </span>
        {source.kind === "fixture" && (
          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-text-2">
            Fixture
          </span>
        )}
      </button>
    </header>
  );
}
