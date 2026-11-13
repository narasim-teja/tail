// One player's Dossier, the soulbound NFT on the pinned contract, read the way the dossier page
// reads it (lib/dossier.ts): the card is the contract's own `nft_token` media. Shown only when a
// player is configured (VITE_DOSSIER_ACCOUNT) and NEAR returned their card; otherwise the
// section is simply not there. The RPC client loads only once the section nears the screen.

import type { DossierView } from "@tail/brand";
import { useEffect, useRef, useState } from "react";
import { displayName } from "../lib/names.ts";

export interface Card {
  account: string;
  media: string;
  view: DossierView;
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

export function DossierSection({ account }: { account: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [card, setCard] = useState<Card | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let live = true;
    const go = async () => {
      const [{ readDossier }, { PINS }] = await Promise.all([
        import("../lib/dossier.ts"),
        import("../verify/pins.ts"),
      ]);
      const c = cardOf(account, await readDossier(PINS.network, PINS.contract, account));
      if (live) setCard(c);
    };
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

  const name = displayName(account);
  return (
    <div ref={ref}>
      {card && (
        <section className="l-dossier" aria-labelledby="dossier-title">
          <img
            className="l-dossier-card"
            src={card.media}
            width={400}
            height={500}
            alt={`${name}'s dossier card: ${card.view.matches} matches, ${card.view.survived} survived, ${card.view.tags} tags`}
          />
          <div className="l-dossier-words">
            <h2 id="dossier-title" className="l-h2">
              A record you can't sell
            </h2>
            <p className="l-lede">
              Every player holds a Dossier, a soulbound NFT. The contract draws its picture from the player's
              record each time anyone reads it, and it can never be transferred.
            </p>
            <p className="l-dossier-counts">
              <span>
                <b>{card.view.matches}</b> matches
              </span>
              <span>
                <b>{card.view.survived}</b> survived
              </span>
              <span>
                <b>{card.view.tags}</b> tags
              </span>
            </p>
            <a className="l-link" href={`${import.meta.env.BASE_URL}dossier/${encodeURIComponent(account)}`}>
              Open {name}'s dossier
            </a>
          </div>
        </section>
      )}
    </div>
  );
}
