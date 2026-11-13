// The Dossier page: the contract's NFT card against the one drawn here from the same record.

import { describe, expect, test } from "bun:test";
import type { DossierView } from "@tail/brand";
import vectors from "@tail/brand/vectors/dossier.json" with { type: "json" };
import { renderToStaticMarkup } from "react-dom/server";
import { compareCard } from "../src/lib/dossier.ts";
import { Record } from "../src/ui/Dossier.tsx";
import { text } from "./render.tsx";

const v = vectors[2] as { view: DossierView; svg: string };
const uri = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
const token = (media: string | null) => ({ token_id: v.view.account_id, metadata: { media } });

describe("the dossier card", () => {
  test("the contract's card is compared byte for byte with the one drawn from the record", () => {
    expect(compareCard(token(uri(v.svg)), v.view)).toEqual({ kind: "same", media: uri(v.svg) });
    const other = uri(v.svg.replace("</svg>", "<g/></svg>"));
    expect(compareCard(token(other), v.view)).toEqual({ kind: "differs", media: other });
    expect(compareCard(token(null), v.view)).toEqual({ kind: "differs", media: null });
    expect(compareCard(null, v.view)).toEqual({ kind: "differs", media: null });
  });

  test("the page shows the contract's own card with one line saying whether it agrees", () => {
    const page = (card: Parameters<typeof Record>[0]["card"]) =>
      renderToStaticMarkup(<Record view={v.view} card={card} matches={{}} tokens={{}} sample={false} />);
    const same = page({ kind: "same", media: uri(v.svg) });
    expect(same).toContain(`src="${uri(v.svg)}"`);
    expect(text(same)).toContain("Same picture as the contract's NFT, byte for byte.");
    const other = uri(v.svg.replace("</svg>", "<g/></svg>"));
    const differs = page({ kind: "differs", media: other });
    expect(differs).toContain(`src="${other}"`);
    expect(differs).toContain('aria-label="Failed"');
    const unread = text(page({ kind: "unread" }));
    expect(unread).toContain("NEAR didn't return the NFT, so its picture wasn't compared.");
    expect(unread).toContain("Drawn here from the record");
  });
});
