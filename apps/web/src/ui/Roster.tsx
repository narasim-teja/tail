// Top-left: who is playing, what each head is worth right now, and how tight each hunter's lock
// is. Heads move as the film plays: on a tag the target's head drains into the hunter's.

import { EPOCH_MS } from "@tail/protocol";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { money } from "../lib/format.ts";
import { useStore } from "../lib/store.ts";
import { focusAt } from "../model/film.ts";
import { lockAt, snapshotAt } from "../model/match.ts";
import { useReplay } from "./context.tsx";
import { useTween } from "./tween.ts";

export function Roster({ compact }: { compact: boolean }) {
  const { match, play, verify, select, reduced } = useReplay();
  const decimals = useStore(verify, (s) => s.token.decimals);
  // Re-render on a new snapshot, a new lock epoch or a new focus, not every frame.
  const key = useStore(play, (s) => {
    const snap = match.snapshots.indexOf(snapshotAt(match, s.t));
    const f = focusAt(match, s.t);
    const fk = f.kind === "chase" ? `${f.hunter}>${f.target}` : f.kind;
    return `${snap}|${Math.floor(s.t / EPOCH_MS)}|${fk}|${s.selection?.kind === "player" ? s.selection.index : ""}|${s.follow ?? ""}`;
  });
  const t = play.get().t;
  const snap = snapshotAt(match, t);
  const focus = focusAt(match, t);
  const sel = play.get().selection;
  void key;

  return (
    <nav
      aria-label="Players"
      className={cn(
        "pointer-events-auto",
        compact ? "-mx-4 overflow-x-auto px-4 [scrollbar-width:none]" : "w-[clamp(15rem,22vw,19rem)]",
      )}
    >
      {!compact && (
        <div className="over-map mb-1.5 flex items-baseline justify-between px-2 text-[0.6875rem] font-semibold uppercase tracking-[0.09em] text-text-3">
          <span>{match.players.length} players</span>
          <span>Head, USDC</span>
        </div>
      )}
      <ul className={cn(compact ? "flex gap-1.5" : "flex flex-col")}>
        {match.players.map((p) => {
          const alive = snap.alive[p.index] ?? false;
          const tg = snap.target[p.index] ?? -1;
          const lock = alive && tg >= 0 ? lockAt(match, p.index, tg, t) : 0;
          const role =
            focus.kind === "chase"
              ? focus.hunter === p.index
                ? "hunter"
                : focus.target === p.index
                  ? "target"
                  : null
              : null;
          const selected = (sel?.kind === "player" && sel.index === p.index) || play.get().follow === p.index;
          return (
            <Row
              key={p.index}
              compact={compact}
              name={p.name}
              initials={p.initials}
              head={snap.heads[p.index] ?? 0n}
              decimals={decimals}
              alive={alive}
              lock={lock}
              hunting={tg >= 0 ? (match.players[tg]?.name ?? null) : null}
              role={role}
              selected={selected}
              reduced={reduced}
              onClick={() => select({ kind: "player", index: p.index })}
            />
          );
        })}
      </ul>
    </nav>
  );
}

function Row(props: {
  compact: boolean;
  name: string;
  initials: string;
  head: bigint;
  decimals: number;
  alive: boolean;
  lock: number;
  hunting: string | null;
  role: "hunter" | "target" | null;
  selected: boolean;
  reduced: boolean;
  onClick: () => void;
}) {
  const { compact, name, initials, head, decimals, alive, lock, hunting, role, selected, reduced, onClick } =
    props;
  const shown = useTween(head, reduced, decimals);
  const prev = useRef(head);
  const [delta, setDelta] = useState<{ v: bigint; id: number } | null>(null);
  useEffect(() => {
    const d = head - prev.current;
    prev.current = head;
    if (d === 0n) return;
    setDelta({ v: d, id: performance.now() });
    const h = setTimeout(() => setDelta(null), 2_600);
    return () => clearTimeout(h);
  }, [head]);

  const label = `${name}, ${alive ? `head ${money(head, decimals)} USDC` : "out"}${alive && hunting ? `, lock ${lock} of 4 on ${hunting}` : ""}`;
  const marker = (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-full text-[0.75rem] font-bold leading-none transition-colors duration-300",
        alive ? (role ? "bg-persimmon text-ink" : "bg-text text-ink") : "border border-rail text-text-3",
        selected && "outline-2 outline-offset-2 outline-text",
      )}
    >
      {initials}
    </span>
  );

  if (compact)
    return (
      <li>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          className="flex min-h-11 flex-col items-center gap-1 rounded-xl px-1.5 py-1 outline-none focus-visible:outline-2 focus-visible:outline-text"
        >
          {marker}
          <span
            className={cn(
              "over-map numeral text-[0.75rem] font-semibold",
              alive ? "text-text" : "text-text-3",
            )}
          >
            {money(shown, decimals)}
          </span>
        </button>
      </li>
    );

  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        aria-pressed={selected}
        className={cn(
          "group grid min-h-11 w-full grid-cols-[auto_1fr_auto_auto] items-center gap-x-3 rounded-xl px-2 py-1 text-left outline-none transition-colors duration-150",
          "hover:bg-scrim/70 focus-visible:outline-2 focus-visible:outline-text",
        )}
      >
        {marker}
        <span className="over-map min-w-0">
          <span
            className={cn(
              "block truncate text-[0.9375rem] font-semibold leading-tight",
              alive ? "text-text" : "text-text-3",
            )}
          >
            {name}
          </span>
          {!alive && <span className="block text-[0.75rem] leading-tight text-text-3">Out</span>}
        </span>
        <LockMeter lock={alive && hunting ? lock : 0} hot={role === "hunter"} hidden={!alive || !hunting} />
        <span className="relative text-right">
          <span
            className={cn(
              "over-map numeral block min-w-[4.25rem] text-[1.0625rem] font-semibold leading-none",
              alive ? "text-text" : "text-text-3",
            )}
          >
            {money(shown, decimals)}
          </span>
          {delta && (
            <span
              key={delta.id}
              className={cn(
                "over-map numeral absolute top-full right-0 mt-0.5 text-[0.75rem] font-semibold whitespace-nowrap",
                delta.v > 0n && role ? "text-persimmon" : "text-text-2",
                !reduced && "animate-in fade-in-0 slide-in-from-top-1 duration-500",
              )}
            >
              {delta.v > 0n ? "+" : "−"}
              {money(delta.v > 0n ? delta.v : -delta.v, decimals)}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

/** Four segments, one per contact window a strike needs; the number is in the label. */
function LockMeter({ lock, hot, hidden }: { lock: number; hot: boolean; hidden: boolean }) {
  return (
    <span aria-hidden="true" className={cn("flex gap-[3px]", hidden && "invisible")}>
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className={cn(
            "h-3 w-[5px] rounded-[1.5px] transition-colors duration-300",
            i < lock ? (hot ? "bg-persimmon" : "bg-text-2") : "bg-rail",
          )}
        />
      ))}
    </span>
  );
}
