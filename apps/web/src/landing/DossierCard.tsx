// The Dossier, the soulbound NFT every player holds, with a key to its card. The card is a
// configured player's (VITE_DOSSIER_ACCOUNT), read the way the dossier page reads it
// (lib/dossier.ts): the contract's own `nft_token` media. Without one, or when NEAR returns no
// card, it is the "full record" golden vector drawn by `dossierSvg`, the builder the contract's
// is byte-identical to, and labelled as an example. Everything loads once the section nears the
// screen.

import type { DossierView } from "@tail/brand";
import { useEffect, useRef, useState } from "react";
import { displayName } from "../lib/names.ts";

export interface Card {
  account: string;
  media: string;
  view: DossierView;
  /** Drawn here from a test vector, not read from NEAR. */
  example?: boolean;
}

/** The card to show from a dossier read, or null when there is nothing the contract drew. */
export function cardOf(
  account: string,
  read: Awaited<ReturnType<typeof import("../lib/dossier.ts")["readDossier"]>>,
): Card | null {
  if (read.kind !== "found") return null;
  const media = read.card.kind === "same" || read.card.kind === "differs" ? read.card.media : null;
  return media ? { account, media, view: read.view } : null;
}

/** The example: the golden vector with a full record, drawn by the contract's twin builder. */
async function exampleCard(): Promise<Card | null> {
  const [{ dossierSvg }, vectors] = await Promise.all([
    import("@tail/brand"),
    import("@tail/brand/vectors/dossier.json"),
  ]);
  const view = vectors.default.find((v) => v.name === "a full record")?.view as DossierView | undefined;
  if (!view) return null;
  const media = `data:image/svg+xml;utf8,${encodeURIComponent(dossierSvg(view))}`;
  return { account: view.account_id, media, view, example: true };
}

/** What the marks on a card mean, each drawn as the card draws it. */
export function DossierKey() {
  return (
    <ul className="l-dossier-key">
      <li>
        <svg width="28" height="16" viewBox="0 0 28 16" aria-hidden="true">
          <circle cx="14" cy="8" r="5" fill="var(--persimmon)" />
        </svg>
        Survived
      </li>
      <li>
        <svg width="28" height="16" viewBox="0 0 28 16" aria-hidden="true">
          <circle cx="14" cy="8" r="5" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
        Tagged out
      </li>
      <li>
        <svg width="28" height="16" viewBox="0 0 28 16" aria-hidden="true">
          <path d="M14 4v8" stroke="var(--persimmon)" strokeWidth="2" strokeLinecap="round" />
        </svg>
        A tag you landed
      </li>
      <li>
        <svg width="28" height="16" viewBox="0 0 28 16" aria-hidden="true">
          <path d="M2 8h24" stroke="currentColor" strokeOpacity=".5" strokeWidth="2" strokeDasharray="5 5" />
        </svg>
        Refunded, counts for nothing
      </li>
    </ul>
  );
}

export function DossierSection({ account }: { account: string | null }) {
  const ref = useRef<HTMLElement>(null);
  const [card, setCard] = useState<Card | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let live = true;
    const go = async () => {
      let c: Card | null = null;
      if (account) {
        const [{ readDossier }, { PINS }] = await Promise.all([
          import("../lib/dossier.ts"),
          import("../verify/pins.ts"),
        ]);
        c = cardOf(account, await readDossier(PINS.network, PINS.contract, account));
      }
      c ??= await exampleCard();
      if (live) setCard(c);
    };
    if (typeof IntersectionObserver === "undefined") {
      void go();
      return () => {
        live = false;
      };
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          void go();
        }
      },
      { rootMargin: "900px 0px" },
    );
    io.observe(el);
    return () => {
      live = false;
      io.disconnect();
    };
  }, [account]);

  const name = card ? displayName(card.account) : null;
  const href = card
    ? `${import.meta.env.BASE_URL}dossier/${encodeURIComponent(card.account)}${card.example ? "?fixture" : ""}`
    : null;
  return (
    <section className="l-dossier" id="dossier" aria-labelledby="dossier-title" ref={ref}>
      <figure className="l-dossier-figure">
        {card ? (
          <img
            className="l-dossier-card"
            src={card.media}
            width={400}
            height={500}
            alt={`${card.example ? "An example" : `${name}'s`} dossier card: ${card.view.matches} matches, ${card.view.survived} survived, ${card.view.tags} tags`}
          />
        ) : (
          <div className="l-dossier-card l-dossier-blank" />
        )}
        <figcaption className="l-dossier-caption">
          {card?.example
            ? "An example card from the test vectors, drawn by the same code the contract runs."
            : card
              ? `${name}'s card, as the contract draws it today.`
              : " "}
        </figcaption>
      </figure>
      <div className="l-dossier-words">
        <h2 id="dossier-title" className="l-h2">
          Your record, minted on NEAR
        </h2>
        <p className="l-lede">
          Sign up and you get a Dossier: an NFT on the TAIL contract, with your account as its token id. When
          a match settles, the contract writes it in: survived or tagged out, tags landed, what you took home.
        </p>
        <p className="l-lede">
          The card is your trail through your matches. The contract draws it as an SVG every time anyone reads
          it, so it grows as you play and there is no image host to go stale.
        </p>
        <p className="l-lede">
          You can't sell it or send it. A match can require a record to join, say three matches played, and a
          record you could buy would measure money instead of play.
        </p>
        <DossierKey />
        {card && href && (
          <a className="l-link" href={href}>
            {card.example ? "Open the example dossier" : `Open ${name}'s dossier`}
          </a>
        )}
      </div>
    </section>
  );
}
