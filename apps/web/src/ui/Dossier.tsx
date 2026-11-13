// The Dossier page (`/dossier/<account>`): a player's soulbound NEP-171 token on the pinned
// contract. The card is the contract's own `nft_token` media, drawn here by the same builder
// (`@tail/brand` dossierSvg, byte-identical to the contract's); below it, the record as a ledger,
// each entry with the root its match anchored and a check against NEAR's `get_roots`, and the
// access rule (`requires`) it clears. `?fixture` shows a sample record that is not on NEAR.

import { type DossierEntry, type DossierResult, type DossierView, dossierSvg } from "@tail/brand";
import { ArrowUpRight } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { type DossierRead, type RootAnswer, readDossier, rootOnNear } from "../lib/dossier.ts";
import { day, money, short } from "../lib/format.ts";
import { cn } from "../lib/utils.ts";
import { PINS } from "../verify/pins.ts";
import { GameIcon } from "./icons.tsx";
import { Loading, PageState, Retry } from "./States.tsx";

type Phase = { kind: "loading" } | DossierRead | { kind: "fixture"; view: DossierView };

const RESULT: Record<DossierResult, string> = {
  survived: "Survived",
  tagged: "Tagged out",
  forfeit: "Forfeited",
  refunded: "Refunded",
};

export function DossierPage({ account }: { account: string }) {
  const fixture = new URLSearchParams(location.search).has("fixture");
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  // Each load (the first, and every retry) is a new request; a stale answer is dropped.
  const [request, setRequest] = useState(() => ({ account, fixture }));

  useEffect(() => {
    let live = true;
    setPhase({ kind: "loading" });
    void (async () => {
      const next: Phase = request.fixture
        ? {
            kind: "fixture",
            view: (await import("@tail/brand/vectors/dossier.json")).default[2]?.view as DossierView,
          }
        : await readDossier(PINS.network, PINS.contract, request.account);
      if (live) setPhase(next);
    })();
    return () => {
      live = false;
    };
  }, [request]);
  const retry = useCallback(() => setRequest((r) => ({ ...r })), []);

  useEffect(() => {
    const who = phase.kind === "found" || phase.kind === "fixture" ? phase.view.account_id : account;
    document.title = `${who.split(".")[0]}'s dossier · TAIL`;
  }, [phase, account]);

  if (phase.kind === "loading") return <Loading />;
  if (phase.kind === "absent")
    return (
      <PageState title="No dossier here">
        {account} has no dossier on {PINS.contract}. Every player gets one when they first register; an
        account registered before dossiers existed mints its own once.
      </PageState>
    );
  if (phase.kind === "no-view")
    return (
      <PageState title="This contract has no dossiers yet">
        {PINS.contract} was deployed before dossiers. They appear once the contract is upgraded.
      </PageState>
    );
  if (phase.kind === "unreachable")
    return (
      <PageState title="NEAR didn't answer" action={<Retry onClick={retry} />}>
        The dossier is read straight from {PINS.contract}, and the request failed. Try again in a moment.
      </PageState>
    );
  return phase.kind === "fixture" ? (
    <Record view={phase.view} matches={{}} tokens={{}} sample />
  ) : (
    <Record view={phase.view} matches={phase.matches} tokens={phase.tokens} sample={false} />
  );
}

function Record({
  view,
  matches,
  tokens,
  sample,
}: {
  view: DossierView;
  matches: Extract<DossierRead, { kind: "found" }>["matches"];
  tokens: Extract<DossierRead, { kind: "found" }>["tokens"];
  sample: boolean;
}) {
  const handle = view.account_id.split(".")[0] ?? view.account_id;
  const svg = dossierSvg(view);
  const alt =
    `${handle}'s dossier card: a trail through ${view.entries.length} recent matches, ` +
    `${view.matches} settled, ${view.survived} survived, ${view.tags} tags.`;
  return (
    <main className="min-h-dvh bg-dusk px-4 pb-16 pt-8 sm:px-8 sm:pt-12">
      <div className="mx-auto grid w-full max-w-[68rem] gap-10 lg:grid-cols-[minmax(0,25rem)_minmax(0,1fr)] lg:gap-16">
        <figure className="self-start lg:sticky lg:top-12">
          <img
            src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`}
            alt={alt}
            width={400}
            height={500}
            className="mx-auto h-auto w-full max-w-[25rem] drop-shadow-[0_24px_48px_oklch(0.12_0.02_255/0.65)]"
          />
          <figcaption className="mx-auto mt-4 max-w-[25rem] text-[0.8125rem] leading-relaxed text-text-3 text-pretty">
            {sample
              ? "A sample record, not on NEAR. "
              : `The contract draws this card on every read of nft_token("${view.account_id}"), so it changes as the record grows. `}
            One segment per settled match, oldest first: a persimmon dot for a survival, a ring for a tag-out,
            a tick for each tag landed, a dashed grey segment for a refund.
          </figcaption>
        </figure>

        <section aria-labelledby="who" className="min-w-0">
          <p className="text-[0.75rem] font-semibold uppercase tracking-[0.18em] text-text-3">
            Dossier{sample ? " · sample" : ""}
          </p>
          <h1
            id="who"
            className="mt-2 break-words text-[clamp(2.25rem,6vw,3.5rem)] font-bold leading-[1.02] tracking-[-0.02em] [font-stretch:104%]"
          >
            {handle}
          </h1>
          <p className="mt-2 break-all font-mono text-[0.8125rem] text-text-2">{view.account_id}</p>

          <dl className="mt-8 flex flex-wrap gap-x-8 gap-y-4 border-y border-hairline py-5">
            {(
              [
                ["Matches", view.matches],
                ["Survived", view.survived],
                ["Tags", view.tags],
                ["Forfeits", view.forfeits],
                ["Refunded", view.refunded],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="flex flex-col-reverse">
                <dt className="text-[0.8125rem] text-text-3">{label}</dt>
                <dd className="numeral text-[1.75rem] font-bold leading-none">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-[0.8125rem] leading-relaxed text-text-3 text-pretty">
            Counted only from matches that paid out after the contract replayed them. A refunded match stays
            on the record and counts for nothing.
          </p>

          <h2 className="mt-10 text-[1.0625rem] font-semibold">What it opens</h2>
          <p className="mt-2 max-w-[60ch] text-[0.9375rem] leading-relaxed text-text-2 text-pretty">
            A host can ask for a record when they open a match (<code className="text-text">requires</code>),
            and <code className="text-text">join_match</code> reads this dossier before it takes the stake.{" "}
            {handle} gets into any match that asks for at most{" "}
            <strong className="font-semibold text-text">
              {view.matches} settled {view.matches === 1 ? "match" : "matches"}
            </strong>{" "}
            and <strong className="font-semibold text-text">{view.survived} survived</strong>.
          </p>

          <h2 className="mt-10 text-[1.0625rem] font-semibold">Record</h2>
          {view.entries.length === 0 ? (
            <p className="mt-2 text-[0.9375rem] text-text-2">
              No settled matches yet. The trail starts with the first.
            </p>
          ) : (
            <ol className="mt-3">
              {view.entries.map((e) => (
                <Entry key={e.match_id} e={e} facts={matches[e.match_id]} tokens={tokens} sample={sample} />
              ))}
            </ol>
          )}
          {view.matches + view.refunded > view.entries.length && (
            <p className="mt-3 text-[0.8125rem] text-text-3">
              The newest {view.entries.length} are kept; the counts above cover every match.
            </p>
          )}

          <h2 className="mt-10 text-[1.0625rem] font-semibold">Bound to {handle}</h2>
          <p className="mt-2 max-w-[60ch] text-[0.9375rem] leading-relaxed text-text-2 text-pretty">
            A NEP-171 token whose id and owner are this account. Transfers are refused with “a dossier is
            bound to the player who earned it”, so a record can't be bought to get into a match.
          </p>
        </section>
      </div>
    </main>
  );
}

function Entry({
  e,
  facts,
  tokens,
  sample,
}: {
  e: DossierEntry;
  facts: { token: string; endMs: number | null; publicReplay: boolean } | undefined;
  tokens: Extract<DossierRead, { kind: "found" }>["tokens"];
  sample: boolean;
}) {
  const [answer, setAnswer] = useState<RootAnswer | "checking" | null>(null);
  const token = facts ? tokens[facts.token] : undefined;
  const payout = token ? `${money(BigInt(e.payout), token.decimals)} ${token.symbol}` : null;
  const anchored = e.log_size !== "0";
  const check = () => {
    setAnswer("checking");
    void rootOnNear(PINS.network, PINS.contract, e).then(setAnswer);
  };
  return (
    <li className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-3 border-t border-hairline py-4 first:border-t-0">
      <ResultGlyph result={e.result} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4">
          <p className="text-[1rem] font-semibold">
            {RESULT[e.result]}
            {e.tags > 0 && (
              <span className="font-normal text-text-2">
                {" · "}
                {e.tags} {e.tags === 1 ? "tag" : "tags"}
              </span>
            )}
          </p>
          {payout && <p className="numeral text-[0.9375rem] text-text-2">{payout}</p>}
        </div>
        <p className="mt-0.5 text-[0.8125rem] text-text-3">
          {facts?.endMs ? `${day(facts.endMs)} · ` : ""}match{" "}
          <span className="font-mono">{short(e.match_id)}</span>
        </p>
        <p className="mt-1.5 break-all text-[0.8125rem] text-text-3">
          {anchored ? (
            <>
              Root <span className="font-mono text-text-2">{short(e.root, 8)}</span> at {e.log_size} log
              entries
            </>
          ) : (
            "Called off before the first checkpoint: nothing was anchored."
          )}
        </p>
        {!sample && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {anchored && (
              <Button size="sm" onClick={check} disabled={answer === "checking"}>
                <GameIcon name="verified" />
                Check on NEAR
              </Button>
            )}
            {facts?.publicReplay && e.result !== "refunded" && (
              <Button size="sm" variant="ghost" asChild>
                <a href={`/?match=${e.match_id}`}>
                  Replay
                  <ArrowUpRight />
                </a>
              </Button>
            )}
            <span
              aria-live="polite"
              className={cn("text-[0.8125rem]", answer === "not-held" ? "text-text" : "text-text-2")}
            >
              {answer === "checking" && "Asking NEAR…"}
              {answer === "held" && "NEAR's get_roots lists this root for the match."}
              {answer === "not-held" && "NEAR holds no such root for this match."}
              {answer === "unreachable" && "NEAR didn't answer. Try again."}
            </span>
          </div>
        )}
      </div>
    </li>
  );
}

/** The card's own marks: a filled dot, a ring, a slashed ring, a small grey dot. */
function ResultGlyph({ result }: { result: DossierResult }) {
  return (
    <svg viewBox="0 0 20 20" className="mt-1 size-5" aria-hidden="true">
      {result === "survived" && <circle cx="10" cy="10" r="6" fill="var(--persimmon)" />}
      {(result === "tagged" || result === "forfeit") && (
        <circle cx="10" cy="10" r="5.5" fill="none" stroke="var(--dusk-ink)" strokeWidth="2" />
      )}
      {result === "forfeit" && <path d="M6.5 13.5l7-7" stroke="var(--dusk-ink)" strokeWidth="2" />}
      {result === "refunded" && <circle cx="10" cy="10" r="3.5" fill="var(--dusk-ink)" fillOpacity=".4" />}
    </svg>
  );
}
