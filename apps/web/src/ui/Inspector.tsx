// The sheet on the right (bottom on a phone) for whatever was tapped: an event, a player, a lock
// line, or the verification summary. Not a modal: the film keeps playing behind it, Esc closes.

import { EPOCH_MS, LOCK_EPOCHS, toHex, WINDOW_EPOCHS } from "@tail/protocol";
import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { Button } from "../components/ui/button.tsx";
import { clock, money, short } from "../lib/format.ts";
import { useStore } from "../lib/store.ts";
import { lockAt, type MatchEvent, snapshotAt, snapshotBefore, walked } from "../model/match.ts";
import { drawSource, eventLine, list, statusLabel, TEST_PLAYER } from "../replay/copy.ts";
import type { Selection } from "../replay/state.ts";
import { attestationUrl, isEnclave } from "../verify/attestation.ts";
import { explorerTx } from "../verify/chain.ts";
import { checkSalts, enrolments, type HandlerCheck, localOk, ringOk } from "../verify/checks.ts";
import { tagEvidence } from "../verify/evidence.ts";
import { PINS } from "../verify/pins.ts";
import { matchProblem, summarize } from "../verify/report.ts";
import { useReplay } from "./context.tsx";
import { GameIcon, Mark } from "./icons.tsx";
import { type Check, overall } from "./marks.ts";
import { ContactProof, EvidenceContacts, EvidenceLines, HistoryLines, PresenceMaker } from "./Proofs.tsx";
import { Details, Meta, ProofLine, Section, Title } from "./sheet.tsx";
import { leadIn } from "./Timeline.tsx";

export function Inspector({ compact }: { compact: boolean }) {
  const { play, select, reduced } = useReplay();
  const sel = useStore(play, (s) => s.selection);
  const panel = useRef<HTMLElement>(null);
  const key = sel ? JSON.stringify(sel) : "";

  // Move focus into the sheet when it opens or changes, so keyboard and screen reader follow.
  useEffect(() => {
    if (key) panel.current?.focus({ preventScroll: true });
  }, [key]);

  if (!sel) return null;
  return (
    <aside
      ref={panel}
      tabIndex={-1}
      aria-label="Details"
      className={cn(
        "pointer-events-auto absolute z-sheet flex flex-col overflow-hidden bg-surface text-text shadow-lift outline-none",
        compact
          ? "inset-x-0 bottom-0 max-h-[64dvh] rounded-t-3xl pb-[max(1rem,env(safe-area-inset-bottom))]"
          : "top-4 right-4 bottom-4 w-[min(26rem,calc(100vw-2rem))] rounded-3xl",
        !reduced &&
          (compact
            ? "animate-in slide-in-from-bottom-8 fade-in-0 duration-300 ease-out-quart"
            : "animate-in slide-in-from-right-8 fade-in-0 duration-300 ease-out-quart"),
      )}
    >
      <div className="flex shrink-0 justify-end px-3 pt-3">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => select(null)}
          aria-label="Close details"
          aria-keyshortcuts="Escape"
        >
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-6">
        <Body sel={sel} />
      </div>
    </aside>
  );
}

function Body({ sel }: { sel: Selection }) {
  switch (sel.kind) {
    case "event":
      return <EventBody index={sel.index} />;
    case "player":
      return <PlayerBody index={sel.index} />;
    case "contact":
      return <ContactBody hunter={sel.hunter} target={sel.target} />;
    case "summary":
      return <SummaryBody />;
  }
}

// ── Shared proof: referee signature + attestation, NEAR anchor ────────────────────

/** Whether the End verdict, which reveals the draw, ran a published build in the enclave. */
function useEndInEnclave(): boolean {
  const { decoded, verify } = useReplay();
  const end = decoded.verdicts.findIndex((x) => x.v?.body.kind === "End");
  return useStore(verify, (s) => end >= 0 && isEnclave(s.attestations[end]));
}

function SignedAndSettled({ index }: { index: number }) {
  const { decoded, verify } = useReplay();
  const local = useStore(verify, (s) => s.local[index]);
  const anchor = useStore(verify, (s) => s.anchors[index]);
  const chain = useStore(verify, (s) => s.chainSummary);
  const by = useStore(verify, (s) => s.signer);
  const att = useStore(verify, (s) => s.attestations[index]);
  const binding = useStore(verify, (s) => s.binding);
  const v = decoded.verdicts[index];
  const fixture = by === "fixture";
  // Only the enclave project leaves a record to read, and only from the pinned OutLayer API.
  const url = v?.v && by === "enclave" ? attestationUrl(PINS.outlayerApi, v.v.callId) : null;
  const enclave = isEnclave(att);

  const signed: Check = !local
    ? "pending"
    : local.decodes && local.signature && local.order
      ? "pass"
      : "fail";
  const logged: Check = !local ? "pending" : local.inLog && local.rootClaim !== false ? "pass" : "fail";
  const settled: Check =
    anchor === undefined ? "pending" : anchor === "match" ? "pass" : anchor === "mismatch" ? "fail" : "info";

  const attDetail =
    by === "fixture"
      ? "This fixture is signed with a public test key, not by an enclave."
      : by === "local"
        ? "Signed by the local test referee on the relay's computer, not by an enclave."
        : by === "unknown"
          ? "NEAR's referee key for this match isn't one this page knows, so nothing vouches for the code that signed."
          : by === null
            ? "Asking NEAR which referee key this match uses…"
            : att === undefined
              ? "Looking up the enclave's record…"
              : att.kind === "found"
                ? att.check.kind === "published"
                  ? `The enclave's record for this call shows it ran the published referee build ${short(att.check.wasm, 8)}.`
                  : att.check.kind === "other-code"
                    ? `The enclave's record shows it ran ${short(att.check.wasm, 8)}, which isn't a published referee build.`
                    : att.check.kind === "other-call"
                      ? "The record OutLayer returned is for a different call."
                      : "The record doesn't say which code ran."
                : att.kind === "missing"
                  ? "OutLayer has no record for this call."
                  : "The enclave's record couldn't be read from here, so no enclave is claimed; open it to check.";
  const attFail = att?.kind === "found" && att.check.kind !== "published";

  return (
    <>
      <ProofLine
        check={signed === "pass" && attFail ? "fail" : signed}
        detail={signed === "fail" ? "The signature doesn't check out against the referee's key." : attDetail}
        href={url}
        linkLabel="Attestation record"
      >
        {enclave
          ? "Signed by the referee in a sealed enclave"
          : by === "local" || by === "fixture"
            ? "Signed by the test referee"
            : "Signed by the referee"}
      </ProofLine>
      <ProofLine
        check={logged}
        detail={
          logged === "fail" ? "It isn't the entry the match log holds." : "It is in the match log, in order."
        }
      >
        Written into the match log
      </ProofLine>
      <ProofLine
        check={settled}
        near
        detail={
          settled === "pass"
            ? "NEAR holds the same log."
            : settled === "fail"
              ? binding.ok
                ? "What NEAR holds is different."
                : "This replay isn't for the contract and match this page checks."
              : chain === "absent"
                ? fixture
                  ? "This is a fixture: it was never sent to NEAR."
                  : "NEAR has no match with this id."
                : chain === "unreachable"
                  ? "NEAR couldn't be reached, so this wasn't checked."
                  : "Asking NEAR…"
        }
        href={v?.txHash && binding.ok ? explorerTx(PINS.network, v.txHash) : null}
        linkLabel="Transaction"
      >
        Settled on NEAR
      </ProofLine>
    </>
  );
}

// ── Event ─────────────────────────────────────────────────────────────────────────

function EventBody({ index }: { index: number }) {
  const { match, decoded, verify, seek } = useReplay();
  const signer = useStore(verify, (s) => s.signer);
  const endInEnclave = useEndInEnclave();
  const ev = match.events.find((e) => e.index === index);
  const status = useStore(verify, (s) => s.statuses[index] ?? "pending");
  const local = useStore(verify, (s) => s.local[index]);
  const level = useStore(verify, (s) => s.level);
  const decimals = useStore(verify, (s) => s.token.decimals);
  if (!ev) return null;
  const v = decoded.verdicts[index]?.v;
  const name = (i: number | undefined) => (i === undefined ? "?" : (match.players[i]?.name ?? "?"));
  const testPlayers = [ev.a, ev.b].filter(
    (i, k, all): i is number =>
      i !== undefined && all.indexOf(i) === k && match.players[i]?.attested === false,
  );

  const icon =
    ev.kind === "tag" ? (
      <GameIcon name="strike" className="size-6 text-persimmon" />
    ) : ev.kind === "hint" ? (
      <GameIcon name="handler" className="size-6 text-text-2" />
    ) : ev.kind === "forfeit" ? (
      <GameIcon name={ev.leftZone ? "zone" : "dark"} className="size-6 text-text-2" />
    ) : ev.kind === "start" ? (
      <GameIcon name="zone" className="size-6 text-text-2" />
    ) : ev.kind === "end" ? (
      <GameIcon name="head" className="size-6 text-text-2" />
    ) : null;

  const rows: [string, string][] = [
    ["Verdict", `#${ev.seq}`],
    ["Call", v ? short(toHex(v.callId), 8) : "?"],
  ];
  if (ev.logIndex !== null) rows.push(["Log entry", String(ev.logIndex)]);
  if (v?.body.kind === "Checkpoint" || v?.body.kind === "End") {
    rows.push(["Log size", String(v.body.logSize)], ["Root", short(toHex(v.body.root), 10)]);
  }

  return (
    <>
      <Title icon={icon} hot={ev.kind === "tag"}>
        {ev.kind === "checkpoint" ? "Saved to NEAR" : eventLine(match, ev)}
      </Title>
      <Meta>
        {clock(ev.t)} into the match ·{" "}
        <span className="inline-flex items-center gap-1.5 align-[-3px]">
          <Mark status={status} labelled={false} className="size-4" />
          {statusLabel[status]}
        </span>
      </Meta>
      {testPlayers.length > 0 && (
        <p className="mt-3 rounded-2xl bg-surface-2 px-4 py-3 text-[0.875rem] leading-snug text-text-2">
          Involves a {TEST_PLAYER}: {list(testPlayers.map((i) => name(i)))}. The referee took{" "}
          {testPlayers.length === 1 ? "this phone" : "these phones"} without checking an Apple attestation, so
          nothing shows {testPlayers.length === 1 ? "it was" : "they were"} a real iPhone running the app.
        </p>
      )}

      {ev.kind === "tag" && <TagStory ev={ev} />}
      {ev.kind === "hint" && (
        <>
          {ev.question && (
            <p className="mt-6 text-[0.9375rem] text-text-2">
              {name(ev.a)} asked: <q className="text-text">{ev.question}</q>
            </p>
          )}
          {ev.handler?.text && (
            <blockquote className="mt-4 text-[1.1875rem] leading-snug font-medium text-balance">
              <q>{ev.handler.text}</q>
              <footer className="mt-1.5 text-[0.8125rem] font-normal text-text-3">The Handler</footer>
            </blockquote>
          )}
          {ev.handler && ev.handler.text === null && (
            <p className="mt-4 text-[0.9375rem] text-text-2">
              The Handler's answer was sealed to {name(ev.a)}'s phone, so only {name(ev.a)} read it.
            </p>
          )}
          <p className="numeral mt-5 text-[0.9375rem] text-text-2">
            {name(ev.a)} paid {money(ev.amount ?? 0n, decimals)} USDC to {name(ev.b)}, the target.
          </p>
        </>
      )}
      {ev.kind === "forfeit" && <ForfeitStory ev={ev} />}
      {ev.kind === "checkpoint" && v?.body.kind === "Checkpoint" && (
        <p className="numeral mt-6 text-[0.9375rem] text-text-2">
          Every minute the referee anchors the match log on NEAR. This one covers the first{" "}
          {Number(v.body.logSize).toLocaleString()} entries.
        </p>
      )}
      {ev.kind === "start" && (
        <p className="mt-6 text-[0.9375rem] text-text-2">
          {list(match.players.map((p) => p.name))} each put in {money(match.stake, decimals)} USDC. Who hunts
          whom was drawn in secret and sealed.
        </p>
      )}
      {ev.kind === "end" && <Standings />}

      <Section label="Proof">
        <ul>
          {ev.kind === "tag" && (decoded.version === 2 ? <EvidenceLines ev={ev} /> : <HeardLine ev={ev} />)}
          {ev.kind === "hint" && ev.handler && (
            <>
              {ev.handler.verified !== null && (
                <ProofLine
                  check={ev.handler.verified ? "pass" : "fail"}
                  detail={
                    ev.handler.verified
                      ? "The quote is the exact line the match log committed to."
                      : "This quote isn't the line the match log committed to."
                  }
                >
                  The Handler's line, word for word
                </ProofLine>
              )}
              <ModelSignatureLine check={ev.handler.signature} />
            </>
          )}
          {ev.kind === "forfeit" && <QuietLine ev={ev} />}
          {(ev.kind === "start" || ev.kind === "end") && local?.ring && (
            <ProofLine
              check={ringOk(local.ring) ? "pass" : "fail"}
              detail={
                ev.kind === "start"
                  ? "The player list and the sealed draw are the ones the referee signed."
                  : `The draw revealed at the end is the one sealed at the start, and it comes from ${drawSource(signer ?? "unknown", endInEnclave)}.`
              }
            >
              {ev.kind === "start" ? "The draw was sealed" : "The draw was fair"}
            </ProofLine>
          )}
          {ev.kind === "end" && level && (
            <ProofLine
              check={level.payouts === null ? "info" : level.payouts ? "pass" : "fail"}
              near
              detail={
                level.payouts === null
                  ? "The match hasn't ended on NEAR, so nothing was paid out to compare."
                  : level.payouts
                    ? "What NEAR paid out is what these verdicts add up to."
                    : "What NEAR paid out isn't what these verdicts add up to."
              }
            >
              Payouts match NEAR
            </ProofLine>
          )}
          <SignedAndSettled index={index} />
        </ul>
      </Section>
      {ev.kind === "tag" && decoded.version === 2 && <EvidenceContacts ev={ev} />}

      {(ev.kind === "tag" || ev.kind === "forfeit" || ev.kind === "hint") && (
        <Button
          variant="quiet"
          size="sm"
          className="mt-6"
          onClick={() => seek(Math.max(0, ev.t - leadIn(ev)), true)}
        >
          Watch it again
        </Button>
      )}
      <Details rows={rows} />
    </>
  );
}

function TagStory({ ev }: { ev: MatchEvent }) {
  const { match, verify } = useReplay();
  const decimals = useStore(verify, (s) => s.token.decimals);
  const after = snapshotAt(match, ev.t);
  const before = snapshotBefore(match, ev);
  const h = ev.a ?? 0;
  const t = ev.b ?? 0;
  const moved = before.heads[t] ?? 0n;
  const next = after.target[h] ?? -1;
  return (
    <div className="mt-6 space-y-3 text-[0.9375rem] text-text-2">
      <p className="numeral">
        <span className="text-text">{match.players[t]?.name}</span>’s head, {money(moved, decimals)} USDC,
        went to <span className="text-text">{match.players[h]?.name}</span>, who now holds{" "}
        <span className="font-semibold text-persimmon">{money(after.heads[h] ?? 0n, decimals)}</span>.
      </p>
      {next >= 0 && (
        <p>
          {match.players[h]?.name} now hunts {match.players[next]?.name}.
        </p>
      )}
    </div>
  );
}

/** The referee's strike rule, re-run over the Contact entries it logged before the tag. */
function HeardLine({ ev }: { ev: MatchEvent }) {
  const { match, decoded, batches } = useReplay();
  const r = tagEvidence(decoded, match, batches.inLog, ev);
  if (r.kind === "no-strike")
    return (
      <ProofLine
        check="info"
        detail="The hunter's strike report wasn't released with this replay, so the lock window can't be placed."
      >
        The lock wasn't re-checked
      </ProofLine>
    );
  const from = clock(Math.max(0, r.epoch - WINDOW_EPOCHS + 1) * EPOCH_MS);
  const to = clock((r.epoch + 1) * EPOCH_MS);
  return (
    <ProofLine
      check={r.ok ? "pass" : "fail"}
      detail={
        !r.targetOk
          ? `${match.players[ev.b ?? 0]?.name} wasn't ${match.players[ev.a ?? 0]?.name}'s target when the strike came in.`
          : `From ${from} to ${to}, the fifteen-second windows up to the strike, the log holds ${r.windows} of the ${WINDOW_EPOCHS} as contacts between the two phones${r.touching ? ", one of them in the strike's window or the one before" : ", but none in the strike's window or the one before"}. A tag needs ${LOCK_EPOCHS}. These are the referee's own entries; the phones' sightings behind them stay sealed.`
      }
    >
      The referee logged {r.windows} contact window{r.windows === 1 ? "" : "s"}
    </ProofLine>
  );
}

/** The NEAR AI signature on the Handler's chat, recovered in the browser (see HandlerCheck). */
function ModelSignatureLine({ check }: { check: HandlerCheck | null }) {
  if (!check) return null;
  const s = check.signature;
  return (
    <ProofLine
      check={s === "signed" ? "pass" : s === "bad" ? "fail" : "info"}
      detail={
        s === "signed"
          ? `The key ${short(check.signer ?? "", 6)} signed hashes of this chat's request and response for ${check.model}. That this key lives in NEAR AI's sealed hardware is shown by NEAR AI's attestation report, which this page doesn't fetch, and the response hash isn't matched to the quote here.`
          : s === "bad"
            ? "The signature in the log doesn't come from the address logged with it."
            : s === "unsigned"
              ? "No model signature was logged for this line (a template line, or the lookup failed)."
              : "This replay doesn't carry the text the model signed, so the signature wasn't checked."
      }
    >
      {s === "signed" ? "The model's chat is signed" : "The model's signature"}
    </ProofLine>
  );
}

function ForfeitStory({ ev }: { ev: MatchEvent }) {
  const { match, verify } = useReplay();
  const decimals = useStore(verify, (s) => s.token.decimals);
  const after = snapshotAt(match, ev.t);
  const before = match.snapshots[match.snapshots.indexOf(after) - 1] ?? after;
  const who = match.players[ev.a ?? 0]?.name;
  const to = match.players[ev.b ?? 0]?.name;
  return (
    <p className="numeral mt-6 text-[0.9375rem] text-text-2">
      {ev.leftZone ? `${who} was outside the zone` : `${who}'s phone stopped reporting`} for three minutes, so{" "}
      {who} is out. Their head, {money(before.heads[ev.a ?? 0] ?? 0n, decimals)} USDC, went to {to}, who was
      hunting them.
    </p>
  );
}

/** The forfeiting player's last report in the log, against the forfeit's time. */
function QuietLine({ ev }: { ev: MatchEvent }) {
  const { match, decoded } = useReplay();
  const p = ev.a ?? 0;
  let lastBatch = -1;
  decoded.log.forEach((e, i) => {
    if (e.entry?.kind === "Batch" && e.entry.player === p && (ev.logIndex === null || i < ev.logIndex))
      lastBatch = i;
  });
  const tr = match.tracks[p];
  const lastFix = tr?.t.length ? (tr.t[tr.t.length - 1] as number) : null;
  const gap = lastFix === null ? null : ev.t - lastFix;
  return (
    <ProofLine
      check={gap === null ? "info" : gap >= 170_000 ? "pass" : "fail"}
      detail={
        gap === null
          ? lastBatch < 0
            ? "The log holds no report from this phone."
            : "The trails weren't released, so the silence can't be timed here."
          : `The last report in the log came ${clock(gap)} before the forfeit.`
      }
    >
      The phone went quiet
    </ProofLine>
  );
}

function Standings() {
  const { match, verify } = useReplay();
  const decimals = useStore(verify, (s) => s.token.decimals);
  const chain = useStore(verify, (s) => s.chain);
  const end = snapshotAt(match, match.durationMs);
  const paid = chain?.kind === "found" ? chain.match.players.map((p) => BigInt(p.paid)) : null;
  const order = [...match.players].sort((a, b) =>
    Number((end.heads[b.index] ?? 0n) - (end.heads[a.index] ?? 0n)),
  );
  return (
    <ol className="mt-6">
      {order.map((p) => (
        <li key={p.index} className="flex items-center justify-between py-1.5 text-[0.9375rem]">
          <span className={cn("font-semibold", !end.alive[p.index] && "text-text-3")}>
            {p.name}
            {!end.alive[p.index] && <span className="ml-2 text-[0.8125rem] font-normal">out</span>}
          </span>
          <span className="numeral font-semibold">
            {money(paid?.[p.index] ?? end.heads[p.index] ?? 0n, decimals)}
            <span className="ml-1 text-[0.8125rem] font-normal text-text-3">USDC</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

// ── Player ────────────────────────────────────────────────────────────────────────

function PlayerBody({ index }: { index: number }) {
  const { match, play, verify, seek, select } = useReplay();
  const decimals = useStore(verify, (s) => s.token.decimals);
  const statuses = useStore(verify, (s) => s.statuses);
  const t = useStore(play, (s) => Math.floor(s.t / 1000) * 1000);
  const follow = useStore(play, (s) => s.follow);
  const p = match.players[index];
  if (!p) return null;
  const snap = snapshotAt(match, t);
  const alive = snap.alive[index];
  const tg = snap.target[index] ?? -1;
  const hunter = snap.target.findIndex((x, h) => x === index && snap.alive[h]);
  const outBy = match.events.find(
    (e) => (e.kind === "tag" && e.b === index) || (e.kind === "forfeit" && e.a === index),
  );
  const mine = match.events.filter(
    (e) =>
      (e.kind === "tag" || e.kind === "hint" || e.kind === "forfeit") && (e.a === index || e.b === index),
  );
  const km = walked(match.tracks[index] ?? null, t);
  return (
    <>
      <Title
        icon={
          <span className="grid size-8 place-items-center rounded-full bg-text text-[0.875rem] font-bold text-ink">
            {p.initials}
          </span>
        }
      >
        {p.name}
      </Title>
      <Meta>
        {p.account}
        {p.attested === false && ` · ${TEST_PLAYER}`}
      </Meta>
      <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-4">
        <div>
          <dt className="text-[0.75rem] text-text-3">Head now</dt>
          <dd className="numeral text-[1.5rem] font-semibold leading-tight">
            {money(snap.heads[index] ?? 0n, decimals)}
            <span className="ml-1 text-[0.8125rem] font-normal text-text-3">USDC</span>
          </dd>
        </div>
        <div>
          <dt className="text-[0.75rem] text-text-3">Walked so far</dt>
          <dd className="numeral text-[1.5rem] font-semibold leading-tight">
            {match.hasTrails
              ? km >= 1000
                ? `${(km / 1000).toFixed(2)} km`
                : `${Math.round(km)} m`
              : "Not released"}
          </dd>
        </div>
      </dl>
      <p className="mt-5 text-[0.9375rem] text-text-2">
        {alive
          ? `${tg >= 0 ? `Hunting ${match.players[tg]?.name}` : "Last one standing"}${hunter >= 0 ? `, hunted by ${match.players[hunter]?.name}` : ""}.`
          : outBy
            ? outBy.kind === "tag"
              ? `Tagged by ${match.players[outBy.a ?? 0]?.name} at ${clock(outBy.t)}.`
              : `Went dark and forfeited at ${clock(outBy.t)}.`
            : "Out."}
      </p>
      {alive && match.hasTrails && (
        <Button
          variant={follow === index ? "solid" : "quiet"}
          size="sm"
          className="mt-4"
          onClick={() => play.set({ follow: follow === index ? null : index, camera: "follow" })}
          aria-pressed={follow === index}
        >
          {follow === index ? `Following ${p.name}` : `Follow ${p.name}`}
        </Button>
      )}
      {mine.length > 0 && (
        <Section label="Moments">
          <ul>
            {mine.map((e) => (
              <li key={e.index}>
                <button
                  type="button"
                  onClick={() => {
                    seek(Math.max(0, e.t - leadIn(e)), true);
                    select({ kind: "event", index: e.index });
                  }}
                  className="flex min-h-11 w-full items-center gap-3 rounded-lg text-left text-[0.9375rem] outline-none hover:text-text focus-visible:outline-2 focus-visible:outline-text"
                >
                  <span className="numeral w-[3.5ch] text-text-3">{clock(e.t)}</span>
                  <span
                    className={cn("flex-1 font-semibold", e.kind === "tag" ? "text-persimmon" : "text-text")}
                  >
                    {eventLine(match, e)}
                  </span>
                  <Mark status={statuses[e.index] ?? "pending"} />
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

// ── Lock line ─────────────────────────────────────────────────────────────────────

function ContactBody({ hunter, target }: { hunter: number; target: number }) {
  const { match, play, decoded } = useReplay();
  const t = useStore(play, (s) => Math.floor(s.t / 1000) * 1000);
  const lock = lockAt(match, hunter, target, t);
  const [a, b] = hunter < target ? [hunter, target] : [target, hunter];
  const e = Math.floor(t / EPOCH_MS);
  const windows = match.contacts.filter(
    (c) => c.a === a && c.b === b && c.epoch <= e && c.epoch > e - WINDOW_EPOCHS,
  );
  const h = match.players[hunter]?.name;
  const tg = match.players[target]?.name;
  return (
    <>
      <Title icon={<GameIcon name="lock" className="size-6 text-persimmon" />}>
        {h} is closing on {tg}
      </Title>
      <Meta>
        Lock {lock} of {LOCK_EPOCHS} at {clock(t)}
      </Meta>
      <p className="mt-6 text-[0.9375rem] text-text-2">
        The line tightens each time both phones hear each other in a fifteen-second window. At {LOCK_EPOCHS}{" "}
        windows in two minutes, {h} can tag.
      </p>
      <Section label="Windows in the last two minutes">
        <p className="mb-2 text-[0.8125rem] leading-snug text-text-2">
          A presence proof shows two phones were near each other in a window, and anyone can check it against
          NEAR alone.
        </p>
        <ul>
          {windows.map((c) =>
            decoded.version === 2 ? (
              <ContactProof key={c.epoch} logIndex={c.logIndex} epoch={c.epoch} withPresence />
            ) : (
              <ProofLine key={c.epoch} check="pass" detail={<PresenceMaker logIndex={c.logIndex} />}>
                <span className="numeral">
                  {clock(c.epoch * EPOCH_MS)} to {clock((c.epoch + 1) * EPOCH_MS)}
                </span>
              </ProofLine>
            ),
          )}
          {windows.length === 0 && <ProofLine check="info">None yet</ProofLine>}
        </ul>
      </Section>
    </>
  );
}

// ── Summary ───────────────────────────────────────────────────────────────────────

function SummaryBody() {
  const { decoded, verify, source, batches, match } = useReplay();
  const statuses = useStore(verify, (s) => s.statuses);
  const local = useStore(verify, (s) => s.local);
  const chain = useStore(verify, (s) => s.chainSummary);
  const level = useStore(verify, (s) => s.level);
  const binding = useStore(verify, (s) => s.binding);
  const signer = useStore(verify, (s) => s.signer);
  const attestations = useStore(verify, (s) => s.attestations);
  const endInEnclave = useEndInEnclave();
  const sum = summarize(statuses);
  const history = useStore(verify, (s) => s.history);
  const problem = matchProblem(binding, level, history);
  const n = decoded.verdicts.length;
  const done = local.filter(Boolean).length;
  const signed = local.filter((l) => l?.decodes && l.signature && l.order).length;
  const logged = local.filter((l) => l?.inLog && l.rootClaim !== false).length;
  const allLocal = local.every((l) => l && localOk(l));
  const lines = match.events.flatMap((e) => (e.handler ? [e.handler] : []));
  const quoted = lines.filter((h) => h.verified !== null);
  const handlerOk = quoted.filter((h) => h.verified).length;
  const modelSigned = lines.filter((h) => h.signature?.signature === "signed").length;
  const modelBad = lines.filter((h) => h.signature?.signature === "bad").length;
  const modelUnchecked = lines.filter((h) => h.signature?.signature === "unchecked").length;
  const status = overall(sum, chain, problem);
  const end = decoded.verdicts.findIndex((x) => x.v?.body.kind === "End");
  const ring = end >= 0 ? local[end]?.ring : undefined;
  // Undecodable verdicts name no call, so they have no record to wait for.
  const calls = decoded.verdicts.filter((x) => x.v).length;
  const records = attestations.filter(Boolean).length;
  const inEnclave = attestations.filter(isEnclave).length;
  const recordsBad = attestations.filter((a) => a?.kind === "found" && a.check.kind !== "published").length;
  const testPlayers = match.players.filter((p) => p.attested === false);
  const enrolledOk = enrolments(decoded).every((e) => e.attested !== null && e.sameAccount === true);
  const salts = checkSalts(decoded);

  return (
    <>
      <Title icon={<Mark status={status} className="size-6" />}>What this page checked</Title>
      <Meta>
        In your browser, from the {decoded.log.length.toLocaleString()}-entry match log and {n} verdicts.
      </Meta>
      {problem && (
        <p className="mt-5 rounded-2xl bg-surface-2 px-4 py-3 text-[0.875rem] leading-snug text-text">
          {problem.detail}
        </p>
      )}
      {signer === "local" && (
        <p className="mt-5 rounded-2xl bg-surface-2 px-4 py-3 text-[0.875rem] leading-snug text-text-2">
          This match was judged by the local test referee: the same referee code, run on the relay's computer
          instead of in an enclave. NEAR's referee key for it is the test referee's. Its signatures and NEAR
          settlement are checked here as usual, but no enclave vouches for the code that signed.
        </p>
      )}
      {signer === "unknown" && chain === "found" && (
        <p className="mt-5 rounded-2xl bg-surface-2 px-4 py-3 text-[0.875rem] leading-snug text-text-2">
          NEAR's referee key for this match isn't one this page knows, so nothing vouches for the code that
          signed. The signatures and NEAR settlement are still checked.
        </p>
      )}
      {decoded.version === 1 && (
        <p className="mt-5 rounded-2xl bg-surface-2 px-4 py-3 text-[0.875rem] leading-snug text-text-2">
          Recorded before protocol v2. Its verdicts aren't chained, its tags carry no evidence entry and its
          players' enrolments aren't in the log, so those checks don't apply. Everything else is checked as
          usual.
        </p>
      )}
      {source.kind === "fixture" && (
        <p className="mt-5 rounded-2xl bg-surface-2 px-4 py-3 text-[0.875rem] leading-snug text-text-2">
          This is a fixture: a generated match on real Boston Common paths, signed with public test keys. It
          was never played or sent to NEAR, so nothing here is anchored.
        </p>
      )}
      <Section label="Checks">
        <ul>
          <ProofLine
            check={done < n ? "pending" : signed === n ? "pass" : "fail"}
            detail={`${signed} of ${n} verdicts carry the referee's signature, numbered without gaps.`}
          >
            Signed by the referee
          </ProofLine>
          <HistoryLines />
          {signer === "enclave" && binding.ok && (
            <ProofLine
              check={
                recordsBad > 0 ? "fail" : records < calls ? "pending" : inEnclave === n ? "pass" : "info"
              }
              detail={`${inEnclave} of ${n} verdicts have an OutLayer record, read from ${PINS.outlayerApi}, showing their call ran a published referee build.${inEnclave < records && recordsBad === 0 ? " The others' records couldn't be read here, so no enclave is claimed for them." : ""}`}
            >
              Ran the published code in the enclave
            </ProofLine>
          )}
          <ProofLine
            check={done < n ? "pending" : logged === n ? "pass" : "fail"}
            detail="Each verdict is in the match log, and every root the referee published is the log's own."
          >
            The log adds up
          </ProofLine>
          <ProofLine
            near
            check={
              !binding.ok
                ? "fail"
                : chain === "checking"
                  ? "pending"
                  : chain === "found"
                    ? sum.verified === n && level?.identity && level.complete
                      ? "pass"
                      : "fail"
                    : "info"
            }
            detail={
              !binding.ok
                ? "This replay isn't for the contract and match this page checks, so nothing was compared."
                : chain === "found"
                  ? `${sum.verified} of ${n} verdicts are covered by roots NEAR holds for this match on ${PINS.contract}${level && !level.complete ? ", but NEAR holds more than this replay includes" : ""}.`
                  : chain === "absent"
                    ? "NEAR has no match with this id."
                    : chain === "unreachable"
                      ? "NEAR couldn't be reached, so nothing was compared."
                      : "Asking NEAR…"
            }
          >
            Matches NEAR
          </ProofLine>
          {level && (
            <ProofLine
              check={level.payouts === null ? "info" : level.payouts ? "pass" : "fail"}
              near
              detail={
                level.payouts === null
                  ? "The match hasn't ended on NEAR, so nothing was paid out to compare."
                  : "Every payout equals what the verdicts add up to."
              }
            >
              Payouts match NEAR
            </ProofLine>
          )}
          {ring && (
            <ProofLine
              check={ringOk(ring) ? "pass" : "fail"}
              detail={`The secret draw revealed at the end was sealed at the start and comes from ${drawSource(signer ?? "unknown", endInEnclave)}.${ring.ringRebuilt === null ? " The server sent no copy of the hunting order, so the page's own rebuild is the only one." : ""}`}
            >
              The draw was fair
            </ProofLine>
          )}
          <ProofLine
            check={decoded.batches.length === 0 ? "info" : batches.failed.length === 0 ? "pass" : "fail"}
            detail={
              decoded.batches.length === 0
                ? "The referee hasn't released the phones' reports for this match, so no paths are drawn."
                : `${batches.inLog.size.toLocaleString()} of ${decoded.batches.length.toLocaleString()} phone reports match the log; only those are drawn.${batches.unchecked.size > 0 ? ` For ${batches.unchecked.size.toLocaleString()} of them the log lacks the report before, so their link to it wasn't checked.` : ""}`
            }
          >
            Trails come from the log
          </ProofLine>
          {decoded.version === 2 && (
            <ProofLine
              check={!enrolledOk ? "fail" : testPlayers.length === 0 ? "pass" : "info"}
              detail={
                !enrolledOk
                  ? "The log's enrolments don't name every player once, under the account the match lists."
                  : testPlayers.length === 0
                    ? "The referee checked every phone's Apple App Attest attestation when it enrolled."
                    : `${list(testPlayers.map((p) => p.name))} ${testPlayers.length === 1 ? "is a" : "are"} ${TEST_PLAYER}${testPlayers.length === 1 ? "" : "s"}: the referee enrolled ${testPlayers.length === 1 ? "this phone" : "them"} without one. The others' attestations were checked.`
              }
            >
              {testPlayers.length === 0
                ? "Every phone enrolled with Apple's attestation"
                : "Not every phone has Apple's attestation"}
            </ProofLine>
          )}
          {salts.kind !== "v1" && (
            <ProofLine
              check={salts.kind === "no-key" ? "info" : salts.bad.length === 0 ? "pass" : "fail"}
              detail={
                salts.kind === "no-key"
                  ? "This replay doesn't carry the match key, so the log's salts weren't checked."
                  : salts.bad.length === 0
                    ? `All ${salts.salted.toLocaleString()} contact, Handler and tag-evidence entries carry the salt the match key gives their place in the log. The referee released that key only after the end, so during play the server couldn't read them by guessing from its hashes.`
                    : `${salts.bad.length} of ${salts.salted.toLocaleString()} salted entries carry a salt the match key doesn't give them.`
              }
            >
              The log stayed private during play
            </ProofLine>
          )}
          {quoted.length > 0 && (
            <ProofLine
              check={handlerOk === quoted.length ? "pass" : "fail"}
              detail={`${handlerOk} of ${quoted.length} quotes are the exact lines the log committed to.`}
            >
              Handler lines are word for word
            </ProofLine>
          )}
          {lines.length > 0 && (
            <ProofLine
              check={modelBad > 0 ? "fail" : modelSigned === lines.length ? "pass" : "info"}
              detail={
                modelUnchecked === lines.length
                  ? "This replay doesn't carry the text the model signed, so the model signatures weren't checked."
                  : `${modelSigned} of ${lines.length} lines have a NEAR AI chat signature that recovers to the address logged with it. It shows that address signed the chat's request and response hashes, not that the address is in sealed hardware.`
              }
            >
              Handler chats are signed
            </ProofLine>
          )}
        </ul>
      </Section>
      {!allLocal && done === n && (
        <p className="mt-5 text-[0.875rem] text-text-2">
          Events that fail a check still play, marked “Doesn't match NEAR”.
        </p>
      )}
      <Details
        rows={[
          ["Match", short(match.id, 8)],
          ["Contract", PINS.contract],
          ...(match.contract !== PINS.contract ? [["Replay names", match.contract] as [string, string]] : []),
          ["Referee key", short(toHex(decoded.refereePk), 8)],
          ["Network", PINS.network],
        ]}
      />
    </>
  );
}
