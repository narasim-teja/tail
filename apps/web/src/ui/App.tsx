// Loads the bundle, decodes it, and hands a playable match to the stage. Every state the relay
// can answer with has its own page.

import { useCallback, useEffect, useState } from "react";
import { TooltipProvider } from "../components/ui/tooltip.tsx";
import { timeOfDay } from "../lib/format.ts";
import { buildMatch, type Match } from "../model/match.ts";
import { type Loaded, loadBundle, type Source, sourceFromUrl } from "../replay/load.ts";
import type { ChainMatch } from "../verify/anchor.ts";
import { BundleError, type DecodedBundle, decodeBundle } from "../verify/bundle.ts";
import { nearReader } from "../verify/chain.ts";
import { type BatchCheck, checkBatches, checkHandler } from "../verify/checks.ts";
import { PINS } from "../verify/pins.ts";
import { PresencePage } from "./Presence.tsx";
import { Stage } from "./Stage.tsx";
import { Loading, PageState, ProgressLine, Retry } from "./States.tsx";

type Phase =
  | { kind: "loading" }
  | { kind: "ready"; decoded: DecodedBundle; match: Match; batches: BatchCheck }
  | { kind: "private"; players: number | null }
  | { kind: "not-finished"; chain: ChainMatch | null }
  | { kind: "missing" }
  | { kind: "error"; message: string };

export function App() {
  // `?presence=<proof>` (or a bare `?presence` to paste one) is the presence proof page.
  const presence = new URLSearchParams(location.search).get("presence");
  if (presence !== null)
    return (
      <TooltipProvider>
        <PresencePage initial={presence} />
      </TooltipProvider>
    );
  return <ReplayApp />;
}

function ReplayApp() {
  const [request, setRequest] = useState<{ source: Source; n: number }>(() => ({
    source: sourceFromUrl(location.search),
    n: 0,
  }));
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  useEffect(() => {
    const { source } = request;
    const ac = new AbortController();
    setPhase({ kind: "loading" });
    void (async () => {
      const r: Loaded = await loadBundle(source, ac.signal);
      if (ac.signal.aborted) return;
      if (r.kind === "ok") {
        try {
          const decoded = decodeBundle(r.json);
          // Trails are drawn only from batches whose hash the log holds.
          const batches = checkBatches(decoded);
          const match = buildMatch(decoded, batches.inLog, checkHandler(decoded));
          setPhase({ kind: "ready", decoded, match, batches });
        } catch (e) {
          setPhase({
            kind: "error",
            message: e instanceof BundleError ? e.message : "This replay couldn't be read.",
          });
        }
        return;
      }
      if (r.kind === "error") return setPhase({ kind: "error", message: r.message });
      if (r.kind === "missing") return setPhase({ kind: "missing" });
      // Private or unfinished: ask NEAR what it knows, to say who can watch and when.
      const chain =
        source.kind === "relay"
          ? await nearReader(PINS.network)
              .read(PINS.contract, source.matchId)
              .then((c) => (c.kind === "found" ? c.match : null))
          : null;
      if (ac.signal.aborted) return;
      setPhase(
        r.kind === "private"
          ? { kind: "private", players: chain?.players.length ?? null }
          : { kind: "not-finished", chain },
      );
    })();
    return () => ac.abort();
  }, [request]);

  const retry = useCallback(() => setRequest((r) => ({ ...r, n: r.n + 1 })), []);

  return (
    <TooltipProvider>
      {phase.kind === "loading" && (
        <>
          <ProgressLine value={0.15} />
          <Loading />
        </>
      )}
      {phase.kind === "ready" && (
        <Stage decoded={phase.decoded} match={phase.match} batches={phase.batches} source={request.source} />
      )}
      {phase.kind === "private" && (
        <PageState title="This match is private">
          The host kept the replay for the people who played it
          {phase.players ? `, the ${phase.players} players` : ""}. Ask one of them to open it, or ask the host
          to make the next match public.
        </PageState>
      )}
      {phase.kind === "not-finished" && (
        <PageState title="This match isn't over yet" action={<Retry onClick={retry} />}>
          {notFinishedLine(phase.chain)}
        </PageState>
      )}
      {phase.kind === "missing" && (
        <PageState title="No match here">
          There's no match with this link. Check that it was copied whole.
        </PageState>
      )}
      {phase.kind === "error" && (
        <PageState title="This replay didn't load" action={<Retry onClick={retry} />}>
          {phase.message} Check your connection and try again.
        </PageState>
      )}
    </TooltipProvider>
  );
}

function notFinishedLine(m: ChainMatch | null): string {
  if (!m) return "The replay opens a minute or so after the match ends and the referee settles it.";
  if (m.phase === "lobby") return "Players are still joining. The replay opens after the match ends.";
  if (m.phase === "running" && m.end_ms)
    return `It ends at ${timeOfDay(m.end_ms)}. The replay opens a minute or so after that, once the referee settles it.`;
  if (m.phase === "aborted")
    return "This match was called off before it ended, so there's nothing to replay.";
  return "It has just ended. The replay opens once the referee settles it, usually within a minute.";
}
