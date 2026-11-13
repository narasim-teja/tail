// Renders the page's components to static HTML around a replay built from a bundle, for the tests
// that pin what the page says: the same prepare, verifyAll and stores the page uses, with NEAR's
// answer given as a ChainState. Rows come back as their glyph label, title and detail.

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Source } from "../src/replay/load.ts";
import { createPlayStore, createVerifyStore, type Selection } from "../src/replay/state.ts";
import { type Replay, ReplayProvider } from "../src/ui/context.tsx";
import type { ChainState, Expect } from "../src/verify/anchor.ts";
import { decodeBundle } from "../src/verify/bundle.ts";
import { anchoredRoots } from "../src/verify/history.ts";
import { prepare, verifyAll } from "../src/verify/index.ts";
import { PINS } from "../src/verify/pins.ts";
import { type Signer, signerOf } from "../src/verify/signer.ts";
import { chainFor } from "./chain.ts";

export const FIXTURE_SOURCE: Source = { kind: "fixture", name: "boston-common", url: "x" };

export interface RenderOptions {
  /** NEAR's answer; the chain the bundle's verdicts would make when left out. */
  chain?: ChainState;
  source?: Source;
  /** Overrides the signer derived from the chain (signerOf), as the page's store would hold it. */
  signer?: Signer;
  selection?: Selection;
}

export function replayOf(bundle: unknown, o: RenderOptions = {}): Replay {
  const decoded = decodeBundle(JSON.parse(JSON.stringify(bundle)));
  const prepared = prepare(decoded);
  const chain = o.chain ?? chainFor(decoded);
  const source = o.source ?? FIXTURE_SOURCE;
  const expect: Expect = {
    contract: PINS.contract,
    network: PINS.network,
    matchId: source.kind === "relay" ? source.matchId : null,
  };
  const v = verifyAll(decoded, chain, expect);
  const verify = createVerifyStore(decoded.verdicts.length, { symbol: "USDC", decimals: 6 }, v.binding);
  verify.set({
    local: v.local,
    anchors: v.anchors,
    statuses: v.statuses,
    chain,
    chainSummary: chain.kind,
    level: v.level,
    signer: o.signer ?? signerOf(source.kind === "fixture", chain, PINS),
    history: { verdictChain: v.verdictChain, consistency: v.consistency },
    anchored: anchoredRoots(decoded, v.binding.ok ? chain : null),
    progress: 1,
  });
  const play = createPlayStore();
  if (o.selection) play.set({ selection: o.selection });
  const noop = () => {};
  return {
    match: prepared.match,
    decoded,
    batches: prepared.batches,
    tags: prepared.tags,
    play,
    verify,
    source,
    reduced: true,
    seek: noop,
    select: noop,
    toggle: noop,
  };
}

export const html = (r: Replay, node: ReactNode) =>
  renderToStaticMarkup(<ReplayProvider value={r}>{node}</ReplayProvider>);

/** Rendered HTML as the text a reader sees: tags stripped, entities decoded. */
export const text = (h: string) =>
  h
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .trim();

export interface Row {
  /** The glyph's label: "Matches NEAR", "Checked", "Failed", "Checking", "Not checked", … */
  glyph: string;
  title: string;
  detail: string;
}

/** Every proof row in rendered HTML (sheet.tsx ProofLine). */
export function rows(h: string): Row[] {
  return h
    .split('<li class="grid grid-cols-[auto_1fr]')
    .slice(1)
    .map((li) => {
      const body = li.split("</li>")[0] ?? "";
      const [head, detail = ""] = body.split('<span class="mt-0.5 block');
      return {
        glyph: /aria-label="([^"]*)"/.exec(body)?.[1] ?? "",
        title: text(`<${(head ?? "").split("</svg></span>").slice(1).join("")}`),
        detail: text(`<span ${detail}`),
      };
    });
}

/** The one row whose title starts with `title`. */
export function row(h: string, title: string): Row {
  const found = rows(h).filter((r) => r.title.startsWith(title));
  if (found.length !== 1)
    throw new Error(
      `${found.length} rows titled "${title}": ${rows(h)
        .map((r) => r.title)
        .join(" | ")}`,
    );
  return found[0] as Row;
}
