// Loads the bundle, decodes it, and hands a playable match to the stage. Every state the relay
// can answer with has its own page.

import { useCallback, useEffect, useState } from "react";
import { TooltipProvider } from "../components/ui/tooltip.tsx";
import { type PagePhase, pageState } from "../replay/copy.ts";
import { type Loaded, loadBundle, resolveSource, type SignIn, type Source } from "../replay/load.ts";
import { BundleError, type DecodedBundle, decodeBundle } from "../verify/bundle.ts";
import { nearReader } from "../verify/chain.ts";
import { type Prepared, prepare } from "../verify/index.ts";
import { PINS } from "../verify/pins.ts";
import { DossierPage } from "./Dossier.tsx";
import { PresencePage } from "./Presence.tsx";
import { Stage } from "./Stage.tsx";
import { Loading, PageState, ProgressLine, Retry } from "./States.tsx";

type Phase =
  | { kind: "loading" }
  | { kind: "ready"; decoded: DecodedBundle; prepared: Prepared; source: Source }
  | PagePhase;

/** `signIn`: a player's one-time sign-in for a private replay, taken from the address (main.tsx). */
export function App({ signIn }: { signIn: SignIn | null }) {
  // `/dossier/<account>` is a player's dossier.
  const dossier = /^\/dossier\/([^/]+)\/?$/.exec(location.pathname)?.[1];
  if (dossier) return <DossierPage account={decodeURIComponent(dossier)} />;
  // `?presence=<proof>` (or a bare `?presence` to paste one) is the presence proof page.
  const presence = new URLSearchParams(location.search).get("presence");
  if (presence !== null)
    return (
      <TooltipProvider>
        <PresencePage initial={presence} />
      </TooltipProvider>
    );
  return <ReplayApp signIn={signIn} />;
}

type LoadRequest = { search: string; n: number };

// One fetch per request, however often its effect runs. A sign-in's nonce works once, and
// StrictMode (in development) runs every effect twice: aborting the first fetch on cleanup does
// not stop the relay from spending the nonce, so the second would be refused. A stale answer is
// dropped instead of the fetch being aborted.
type Load = { source: Source; loaded: Loaded };
const loads = new WeakMap<LoadRequest, Promise<Load>>();
function loadOnce(request: LoadRequest, signIn: SignIn | null): Promise<Load> {
  let load = loads.get(request);
  if (!load) {
    load = resolveSource(request.search).then(async (source) => ({
      source,
      loaded: await loadBundle(source, signIn),
    }));
    loads.set(request, load);
  }
  return load;
}

function ReplayApp({ signIn }: { signIn: SignIn | null }) {
  const [request, setRequest] = useState<LoadRequest>(() => ({ search: location.search, n: 0 }));
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  useEffect(() => {
    let stale = false;
    setPhase({ kind: "loading" });
    void (async () => {
      const { source, loaded: r } = await loadOnce(request, signIn);
      if (stale) return;
      if (r.kind === "ok") {
        try {
          const decoded = decodeBundle(r.json);
          // Trails are drawn only from batches whose hash the log holds; every tag is checked once.
          setPhase({ kind: "ready", decoded, prepared: prepare(decoded), source });
        } catch (e) {
          setPhase({
            kind: "error",
            message: e instanceof BundleError ? e.message : "This replay couldn't be read.",
          });
        }
        return;
      }
      if (r.kind === "error") return setPhase({ kind: "error", message: r.message });
      if (r.kind === "missing" || r.kind === "purged") return setPhase({ kind: r.kind });
      // Private or unfinished: ask NEAR what it knows, to say who can watch and when.
      const chain =
        source.kind === "match"
          ? await nearReader(PINS.network)
              .read(PINS.contract, source.matchId)
              .then((c) => (c.kind === "found" ? c.match : null))
          : null;
      if (stale) return;
      setPhase(
        r.kind === "private"
          ? { kind: "private", players: chain?.players.length ?? null, refused: r.refused }
          : { kind: "not-finished", chain },
      );
    })();
    return () => {
      stale = true;
    };
  }, [request, signIn]);

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
        <Stage decoded={phase.decoded} prepared={phase.prepared} source={phase.source} />
      )}
      {phase.kind !== "loading" && phase.kind !== "ready" && <StatePage phase={phase} retry={retry} />}
    </TooltipProvider>
  );
}

function StatePage({ phase, retry }: { phase: PagePhase; retry: () => void }) {
  const p = pageState(phase);
  return (
    <PageState title={p.title} {...(p.retry ? { action: <Retry onClick={retry} /> } : {})}>
      {p.body}
    </PageState>
  );
}
