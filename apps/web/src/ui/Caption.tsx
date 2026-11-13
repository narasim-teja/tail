// The event line: what just happened, in one sentence, with its mark. Hint lines quote the
// Handler verbatim. Tapping it opens the event in the inspector. The end is the finale's.

import { cn } from "@/lib/utils";
import { useStore } from "../lib/store.ts";
import { eventLine, statusLabel } from "../replay/copy.ts";
import { useReplay } from "./context.tsx";
import { Mark } from "./icons.tsx";

export function Caption({ compact }: { compact: boolean }) {
  const { match, play, verify, select, reduced } = useReplay();
  const cap = useStore(play, (s) => s.caption);
  const statuses = useStore(verify, (s) => s.statuses);
  // The end has its own finale (Finale.tsx); the line here covers everything before it.
  const found = cap ? match.events.find((e) => e.index === cap.event) : undefined;
  const ev = found?.kind === "end" ? undefined : found;
  return (
    <div
      aria-live="polite"
      className="pointer-events-none flex min-h-[4.5rem] flex-col items-center justify-end text-center"
    >
      {ev && (
        <button
          key={cap?.born}
          type="button"
          onClick={() => select({ kind: "event", index: ev.index })}
          className={cn(
            "pointer-events-auto flex max-w-[min(44rem,92vw)] flex-col items-center rounded-2xl px-3 py-1 outline-none focus-visible:outline-2 focus-visible:outline-text",
            !reduced && "animate-in fade-in-0 slide-in-from-bottom-2 duration-500 ease-out-quart",
          )}
        >
          <span className="flex items-center gap-2.5">
            <span
              className={cn(
                "over-map font-bold leading-tight tracking-[-0.01em] [font-stretch:104%] text-balance",
                compact ? "text-[1.375rem]" : "text-[2rem]",
                ev.kind === "tag" && "text-persimmon",
              )}
            >
              {eventLine(match, ev)}
            </span>
            <Mark status={statuses[ev.index] ?? "pending"} className={compact ? "size-5" : "size-6"} />
          </span>
          {ev.kind === "hint" && ev.handler?.text && (
            <q
              className={cn(
                "over-map mt-1.5 text-text-2 text-balance [quotes:'“'_'”'_'‘'_'’']",
                compact ? "text-[0.9375rem]" : "text-[1.1875rem]",
              )}
            >
              {ev.handler.text}
            </q>
          )}
          <span className="over-map mt-1 text-[0.75rem] font-semibold uppercase tracking-[0.08em] text-text-3">
            {statusLabel[statuses[ev.index] ?? "pending"]}
          </span>
        </button>
      )}
    </div>
  );
}
