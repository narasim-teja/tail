// The economy view: the money of the match synced to the playhead. It takes the roster's place
// (top-left on a laptop, under the title on a phone) and shows the hint pool, the hint price, every
// head on one shared scale, and each transfer as it lands. Every figure comes from the signed
// verdicts in the bundle (model/economy.ts); each transfer carries its verdict's mark.
//
// One accent: the player the viewer picked is persimmon, everyone else is neutral ink, so 12
// players never need 12 hues. The fast-forward plays the whole match in about a minute.

import { FastForward, X } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "../components/ui/button.tsx";
import { clock, money } from "../lib/format.ts";
import { useStore } from "../lib/store.ts";
import { buildEconomy, type Economy, type Step, stepPath, valueAt } from "../model/economy.ts";
import { snapshotAt } from "../model/match.ts";
import { statusLabel } from "../replay/copy.ts";
import { useReplay } from "./context.tsx";
import { Mark } from "./icons.tsx";
import { Roster } from "./Roster.tsx";

/** The fast-forward runs the whole match in about this long. */
const FAST_FORWARD_MS = 60_000;

/** `?view=economy` opens the replay on this view. */
const opensOnEconomy = () => new URLSearchParams(location.search).get("view") === "economy";

/** The roster, or the economy panel in its place. */
export function EconomySlot({ compact }: { compact: boolean }) {
  const [open, setOpen] = useState(opensOnEconomy);
  if (!open)
    return (
      <div className={cn("flex flex-col", compact ? "gap-1" : "gap-2")}>
        <Roster compact={compact} />
        <Button
          variant="ghost"
          size="sm"
          className={cn("pointer-events-auto self-start", !compact && "ml-1")}
          onClick={() => setOpen(true)}
        >
          Economy
        </Button>
      </div>
    );
  return <EconomyPanel compact={compact} onClose={() => setOpen(false)} />;
}

function EconomyPanel({ compact, onClose }: { compact: boolean; onClose: () => void }) {
  const { match, decoded } = useReplay();
  const eco = useMemo(() => buildEconomy(match, decoded), [match, decoded]);
  return (
    <section
      aria-label="Economy"
      className={cn(
        "pointer-events-auto flex flex-col overflow-y-auto overscroll-contain rounded-2xl bg-scrim/90 shadow-lift [scrollbar-width:thin]",
        compact
          ? "-mx-1 max-h-[46dvh] px-3.5 pt-3 pb-4"
          : "max-h-[calc(100dvh-14rem)] w-[clamp(20rem,27vw,24rem)] px-4 pt-3.5 pb-5 min-[1280px]:w-[clamp(38rem,46vw,46rem)]",
      )}
    >
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-[0.6875rem] font-semibold uppercase tracking-[0.09em] text-text-3">
          Economy
        </h2>
        <FastForwardButton />
        <Button variant="ghost" size="icon-sm" aria-label="Close the economy view" onClick={onClose}>
          <X />
        </Button>
      </div>
      <SourceLine eco={eco} />
      {/* Two columns where the screen has room: the market on the left, the players on the right. */}
      <div className={cn(!compact && "min-[1280px]:grid min-[1280px]:grid-cols-2 min-[1280px]:gap-x-7")}>
        <div className="flex flex-col">
          <Pool eco={eco} />
          <Price eco={eco} />
        </div>
        <div className="flex flex-col">
          <Heads eco={eco} compact={compact} />
          <Flows eco={eco} />
        </div>
      </div>
    </section>
  );
}

// ── Controls and the source line ─────────────────────────────────────────────────

function FastForwardButton() {
  const { match, play, seek } = useReplay();
  const speed = Math.max(1, Math.round(match.durationMs / FAST_FORWARD_MS));
  const on = useStore(play, (s) => s.mode === speed && s.playing);
  return (
    <Button
      variant={on ? "solid" : "quiet"}
      size="sm"
      aria-pressed={on}
      aria-label={
        on
          ? `Fast-forwarding at ${speed} times. Back to the film`
          : `Play the whole match in one minute, at ${speed} times`
      }
      onClick={() => {
        if (on) return play.set({ mode: "film" });
        play.set({ mode: speed });
        seek(0, true);
      }}
    >
      <FastForward className={cn(on && "fill-current")} />
      {on ? <span className="numeral">{speed}×</span> : "Whole match in 1 min"}
    </Button>
  );
}

function SourceLine({ eco }: { eco: Economy }) {
  const { verify } = useReplay();
  const failed = useStore(
    verify,
    (s) => eco.moneyVerdicts.filter((i) => s.statuses[i] === "mismatch").length,
  );
  return (
    <p className="mt-1 text-[0.8125rem] leading-snug text-text-2 text-pretty">
      Every number here comes from the referee's {eco.moneyVerdicts.length} signed money verdicts in this
      replay, each checked as it plays.
      {failed > 0 && <span className="font-semibold text-text"> {failed} failed a check.</span>}
    </p>
  );
}

// ── Charts ──────────────────────────────────────────────────────────────────────

/** Re-render about 600 times across the match, not every frame. */
function usePlayhead(): number {
  const { match, play } = useReplay();
  const step = Math.max(1_000, match.durationMs / 600);
  return useStore(play, (s) => Math.floor(s.t / step) * step);
}

function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e?.contentRect.width ?? 0)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function ChartLabel({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="mt-5 mb-1.5 flex items-baseline justify-between gap-3">
      <h3 className="text-[0.8125rem] font-semibold text-text">{label}</h3>
      <span className="numeral text-[0.9375rem] font-semibold text-text">{value}</span>
    </div>
  );
}

/**
 * A time chart across the whole match: drawn up to the playhead, with a hover rule that reads the
 * value at any moment (the timeline below is the control that moves the playhead).
 */
function TimeChart(props: {
  height: number;
  label: string;
  readout: (t: number) => string;
  children: (x: (t: number) => number, w: number, h: number) => ReactNode;
}) {
  const { match } = useReplay();
  const t = usePlayhead();
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const dur = match.durationMs;
  const x = (tt: number) => (Math.max(0, Math.min(dur, tt)) / dur) * w;
  const at = (e: { clientX: number; currentTarget: Element }) => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(dur, ((e.clientX - r.left) / r.width) * dur));
  };
  const h = props.height;
  return (
    <div
      ref={ref}
      role="img"
      aria-label={`${props.label}. Now: ${props.readout(t)}.`}
      className="relative cursor-crosshair touch-pan-y select-none"
      style={{ height: h }}
      onPointerMove={(e) => setHover(at(e))}
      onPointerLeave={() => setHover(null)}
    >
      {w > 0 && (
        <svg width={w} height={h} className="block overflow-visible" aria-hidden="true">
          <line x1={0} x2={w} y1={h - 0.5} y2={h - 0.5} className="stroke-hairline" strokeWidth={1} />
          {props.children(x, w, h)}
          <line x1={x(t)} x2={x(t)} y1={0} y2={h} className="stroke-text-3" strokeWidth={1} />
          {hover !== null && (
            <line x1={x(hover)} x2={x(hover)} y1={0} y2={h} className="stroke-text-2" strokeWidth={1} />
          )}
        </svg>
      )}
      {hover !== null && w > 0 && (
        <span
          className="numeral pointer-events-none absolute -top-6 z-tooltip whitespace-nowrap rounded-md bg-surface-3 px-1.5 py-0.5 text-[0.75rem] font-semibold text-text"
          style={{ left: Math.min(Math.max(0, x(hover) - 40), w - 96) }}
        >
          {clock(hover)} · {props.readout(hover)}
        </span>
      )}
    </div>
  );
}

function TimeAxis() {
  const { match } = useReplay();
  const mins = Math.round(match.durationMs / 60_000);
  const step = mins >= 40 ? 15 : mins >= 16 ? 5 : 2;
  const ticks = Array.from({ length: Math.floor(mins / step) + 1 }, (_, i) => i * step);
  return (
    <div aria-hidden="true" className="relative mt-1 h-4 text-[0.6875rem] text-text-3">
      {ticks.map((m) => (
        <span
          key={m}
          className="numeral absolute -translate-x-1/2 whitespace-nowrap first:translate-x-0 last:-translate-x-full"
          style={{ left: `${(100 * m * 60_000) / match.durationMs}%` }}
        >
          {m === mins ? `${m} min` : m}
        </span>
      ))}
    </div>
  );
}

function Pool({ eco }: { eco: Economy }) {
  const { verify } = useReplay();
  const decimals = useStore(verify, (s) => s.token.decimals);
  const t = usePlayhead();
  const fmt = (v: number) => money(BigInt(Math.round(v)), decimals);
  return (
    <>
      <ChartLabel label="Hint pool" value={`${fmt(valueAt(eco.pool, t))} USDC`} />
      <TimeChart
        height={52}
        label="Hint pool over the match"
        readout={(tt) => `${fmt(valueAt(eco.pool, tt))} USDC`}
      >
        {(_x, w, h) => {
          const line = stepPath(eco.pool, t, eco.durationMs, w, h - 1, 0, eco.maxPool);
          const until = (Math.min(t, eco.durationMs) / eco.durationMs) * w;
          return (
            <>
              <path d={`${line}V${h - 1}H0Z`} className="fill-text-2" fillOpacity={0.1} />
              <path d={line} className="fill-none stroke-text-2" strokeWidth={2} strokeLinejoin="round" />
              {until > 0 && (
                <circle
                  cx={until}
                  cy={yOf(valueAt(eco.pool, t), eco.maxPool, h - 1)}
                  r={4}
                  className="fill-text stroke-scrim"
                  strokeWidth={2}
                />
              )}
            </>
          );
        }}
      </TimeChart>
    </>
  );
}

const yOf = (v: number, max: number, h: number, lo = 0) => h - ((v - lo) / Math.max(1e-9, max - lo)) * h;

function Price({ eco }: { eco: Economy }) {
  const t = usePlayhead();
  const d = eco.demand;
  if (d.kind === "count") {
    const shown = d.counts.map(
      (_, k) => eco.hints.filter((h) => h.t <= t && Math.floor(h.t / d.bucketMs) === k).length,
    );
    const max = Math.max(1, ...d.counts);
    const now = shown[Math.min(shown.length - 1, Math.floor(t / d.bucketMs))] ?? 0;
    return (
      <>
        <ChartLabel label="Hints bought, per 5 min" value={now} />
        <TimeChart
          height={56}
          label="Hints bought per 5 minutes"
          readout={(tt) => `${shown[Math.min(shown.length - 1, Math.floor(tt / d.bucketMs))] ?? 0} hints`}
        >
          {(x, _w, h) =>
            shown
              .map((c, k) => ({ c, start: k * d.bucketMs }))
              .map(({ c, start }) => {
                if (c === 0) return null;
                const k = start / d.bucketMs;
                const x0 = x(start);
                const bw = Math.min(24, x((k + 1) * d.bucketMs) - x0 - 2);
                const top = yOf(c, max, h - 1);
                return (
                  <path
                    key={start}
                    d={roundTop(x0 + (x((k + 1) * d.bucketMs) - x0 - bw) / 2, top, bw, h - 1 - top)}
                    className="fill-text-2"
                  />
                );
              })
          }
        </TimeChart>
        <TimeAxis />
      </>
    );
  }
  const cap = 4;
  return (
    <>
      <ChartLabel
        label="Hint price"
        value={`${valueAt(d.series, t)
          .toFixed(2)
          .replace(/\.?0+$/, "")}× base`}
      />
      <p className="-mt-1 mb-2 flex items-center gap-3 text-[0.75rem] text-text-3">
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="h-0.5 w-3 rounded-full bg-text-2" />
          price now
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="size-2 rounded-full bg-text" />
          what a hint paid
        </span>
      </p>
      <TimeChart
        height={84}
        label="Hint price over the match, as a multiple of the base price"
        readout={(tt) =>
          `${valueAt(d.series, tt)
            .toFixed(2)
            .replace(/\.?0+$/, "")}× base`
        }
      >
        {(x, w, h) => (
          <>
            {[2, 3].map((g) => (
              <line
                key={g}
                x1={0}
                x2={w}
                y1={yOf(g, cap, h - 1, 1)}
                y2={yOf(g, cap, h - 1, 1)}
                className="stroke-hairline"
                strokeWidth={1}
              />
            ))}
            {[1, 2, 3, 4].map((g) => (
              <text
                key={g}
                x={w}
                y={yOf(g, cap, h - 1, 1) - 3}
                textAnchor="end"
                className="fill-text-3 text-[0.625rem]"
              >
                {g}×
              </text>
            ))}
            <path
              d={stepPath(d.series, t, eco.durationMs, w, h - 1, 1, cap)}
              className="fill-none stroke-text-2"
              strokeWidth={2}
              strokeLinejoin="round"
            />
            {eco.hints
              .filter((hb) => hb.t <= t && hb.paid !== null)
              .map((hb) => (
                <circle
                  key={hb.event}
                  cx={x(hb.t)}
                  cy={yOf(hb.paid ?? 1, cap, h - 1, 1)}
                  r={4}
                  className="fill-text stroke-scrim"
                  strokeWidth={2}
                />
              ))}
          </>
        )}
      </TimeChart>
      <TimeAxis />
    </>
  );
}

/** A bar rising from the baseline with 4 px rounded top corners. */
function roundTop(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x} ${y + h}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h}Z`;
}

// ── Heads, one small chart per player on one shared scale ────────────────────────

function Heads({ eco, compact }: { eco: Economy; compact: boolean }) {
  const { match, play, verify, select } = useReplay();
  const decimals = useStore(verify, (s) => s.token.decimals);
  const t = usePlayhead();
  const chosen = useStore(play, (s) => (s.selection?.kind === "player" ? s.selection.index : s.follow));
  const snap = snapshotAt(match, t);
  const top = money(BigInt(Math.round(eco.maxHead)), decimals);
  return (
    <>
      <div className="mt-5 mb-1.5 flex items-baseline justify-between gap-3">
        <h3 className="text-[0.8125rem] font-semibold text-text">Heads</h3>
        <span className="text-[0.75rem] text-text-3">
          one scale, 0 to <span className="numeral">{top}</span> USDC
        </span>
      </div>
      <ul className={cn("grid gap-1.5", compact || match.players.length > 9 ? "grid-cols-4" : "grid-cols-3")}>
        {match.players.map((p) => (
          <HeadCell
            key={p.index}
            name={p.name}
            series={eco.heads[p.index] ?? []}
            max={eco.maxHead}
            head={snap.heads[p.index] ?? 0n}
            alive={snap.alive[p.index] ?? false}
            hot={chosen === p.index}
            t={t}
            durationMs={eco.durationMs}
            decimals={decimals}
            onClick={() => select({ kind: "player", index: p.index })}
          />
        ))}
      </ul>
      <p className="mt-1.5 text-[0.75rem] text-text-3">
        {chosen !== null && chosen !== undefined && match.players[chosen] ? (
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className="size-2 rounded-full bg-persimmon" />
            {match.players[chosen].name}, your pick
          </span>
        ) : (
          "Pick a player to follow their money."
        )}
      </p>
    </>
  );
}

function HeadCell(props: {
  name: string;
  series: Step[];
  max: number;
  head: bigint;
  alive: boolean;
  hot: boolean;
  t: number;
  durationMs: number;
  decimals: number;
  onClick: () => void;
}) {
  const { name, series, max, head, alive, hot, t, durationMs, decimals, onClick } = props;
  const [ref, w] = useWidth<HTMLSpanElement>();
  const h = 30;
  const line = w > 0 ? stepPath(series, t, durationMs, w, h - 1, 0, max) : "";
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        aria-pressed={hot}
        aria-label={`${name}: ${alive ? `head ${money(head, decimals)} USDC` : "out"} at ${clock(t)}`}
        className={cn(
          "flex w-full min-w-0 flex-col rounded-lg px-1.5 pt-1 pb-1.5 text-left outline-none transition-colors duration-150",
          "hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-text",
          hot && "bg-surface-2",
        )}
      >
        <span className="flex items-center gap-1 text-[0.75rem] leading-tight">
          {hot && <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-persimmon" />}
          <span className={cn("truncate font-semibold", alive ? "text-text" : "text-text-3")}>{name}</span>
        </span>
        <span className={cn("numeral text-[0.8125rem] font-semibold", alive ? "text-text-2" : "text-text-3")}>
          {alive ? money(head, decimals) : "out"}
        </span>
        <span ref={ref} className="mt-0.5 block" style={{ height: h }}>
          {w > 0 && (
            <svg width={w} height={h} aria-hidden="true" className="block overflow-visible">
              <line x1={0} x2={w} y1={h - 0.5} y2={h - 0.5} className="stroke-hairline" strokeWidth={1} />
              <path
                d={line}
                className={cn(
                  "fill-none",
                  hot ? "stroke-persimmon" : alive ? "stroke-text-2" : "stroke-text-3",
                )}
                strokeWidth={hot ? 2 : 1.5}
                strokeLinejoin="round"
              />
            </svg>
          )}
        </span>
      </button>
    </li>
  );
}

// ── Transfers ────────────────────────────────────────────────────────────────────

function Flows({ eco }: { eco: Economy }) {
  const { match, verify, seek, select } = useReplay();
  const decimals = useStore(verify, (s) => s.token.decimals);
  const statuses = useStore(verify, (s) => s.statuses);
  const t = usePlayhead();
  const name = (i: number) => match.players[i]?.name ?? `Player ${i + 1}`;
  const m = (v: bigint) => money(v, decimals);
  const [all, setAll] = useState(false);
  const landed = eco.flows.filter((f) => f.t <= t).reverse();
  const shown = all ? landed : landed.slice(0, paidOutAt(eco, t) ? 2 : 3);
  const paidOut = paidOutAt(eco, t) ? eco.payout : null;
  const jump = (event: number, at: number) => {
    seek(Math.max(0, at - 20_000), true);
    select({ kind: "event", index: event });
  };
  return (
    <>
      <div className="mt-5 mb-1 flex items-baseline justify-between gap-3">
        <h3 className="text-[0.8125rem] font-semibold text-text">Money moved</h3>
        <span className="text-[0.75rem] text-text-3">winner ← loser's head + hint credit</span>
      </div>
      {landed.length === 0 && !paidOut && (
        <p className="text-[0.8125rem] text-text-3">Nothing yet. A tag moves a whole head.</p>
      )}
      <ol className="flex flex-col">
        {paidOut && (
          <Row
            at={paidOut.t}
            status={statuses[paidOut.event] ?? "pending"}
            onClick={() => jump(paidOut.event, paidOut.t)}
            title={
              paidOut.kind === "payout" ? "End: the pool pays the survivors" : "End: every stake refunded"
            }
            detail={
              paidOut.kind === "payout"
                ? paidOut.delta
                    .map((d, p) => (d > 0n ? `${name(p)} +${m(d)}` : null))
                    .filter(Boolean)
                    .join(", ") || "Nothing was owed"
                : "A rule was broken, so the contract returned every stake"
            }
          />
        )}
        {shown.map((f) => (
          <Row
            key={f.event}
            at={f.t}
            status={statuses[f.event] ?? "pending"}
            onClick={() => jump(f.event, f.t)}
            title={
              <span className="flex justify-between gap-2">
                <span className="truncate">
                  {name(f.winner)} <span className="text-text-3">←</span> {name(f.loser)}
                </span>
                <span className="numeral">{m(f.head + f.credit)}</span>
              </span>
            }
            detail={`${f.kind === "tag" ? "Tag" : "Forfeit"}: head ${m(f.head)}${f.credit > 0n ? ` + ${m(f.credit)} hint credit` : ""}`}
          />
        ))}
      </ol>
      {landed.length > shown.length || all ? (
        <Button variant="ghost" size="sm" className="mt-0.5 self-start" onClick={() => setAll((a) => !a)}>
          {all ? "Latest only" : `All ${landed.length + (paidOutAt(eco, t) ? 1 : 0)}`}
        </Button>
      ) : null}
    </>
  );
}

const paidOutAt = (eco: Economy, t: number) => eco.payout !== null && eco.payout.t <= t;

function Row(props: {
  at: number;
  status: Parameters<typeof Mark>[0]["status"];
  title: ReactNode;
  detail: string;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={props.onClick}
        className="grid w-full grid-cols-[3rem_1fr_auto] items-start gap-x-2 rounded-lg px-1 py-1.5 text-left outline-none hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-text"
      >
        <span className="numeral pt-px text-[0.8125rem] text-text-3">{clock(props.at)}</span>
        <span className="min-w-0">
          <span className="block text-[0.875rem] font-semibold leading-tight text-text">{props.title}</span>
          <span className="block text-[0.75rem] leading-snug text-text-3">{props.detail}</span>
        </span>
        <span className="pt-0.5" title={statusLabel[props.status]}>
          <Mark status={props.status} className="size-3.5" />
        </span>
      </button>
    </li>
  );
}
