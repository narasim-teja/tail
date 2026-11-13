// The building blocks of the details sheet: title, meta line, labelled section, one proof row
// with its glyph, and the technical details fold.

import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { GlyphIcon } from "./icons.tsx";
import { type Check, proofGlyph } from "./marks.ts";

export function Title({ icon, children, hot }: { icon?: ReactNode; children: ReactNode; hot?: boolean }) {
  return (
    <h2
      className={cn(
        "flex items-start gap-2.5 pr-6 text-[1.5rem] font-bold leading-[1.15] tracking-[-0.01em] text-balance [font-stretch:104%]",
        hot && "text-persimmon",
      )}
    >
      {icon && <span className="mt-1 shrink-0">{icon}</span>}
      <span>{children}</span>
    </h2>
  );
}

export function Meta({ children }: { children: ReactNode }) {
  return <p className="numeral mt-1.5 text-[0.875rem] text-text-2">{children}</p>;
}

export function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="mt-7">
      <h3 className="mb-2.5 text-[0.6875rem] font-semibold uppercase tracking-[0.09em] text-text-3">
        {label}
      </h3>
      {children}
    </section>
  );
}

export function ProofLine({
  check,
  near = false,
  children,
  detail,
  href,
  linkLabel,
}: {
  check: Check;
  /** This row compares with NEAR: only it may show the ringed check. */
  near?: boolean;
  children: ReactNode;
  detail?: ReactNode;
  href?: string | null;
  linkLabel?: string;
}) {
  const glyph = (
    <GlyphIcon
      glyph={proofGlyph(check, near)}
      label={
        check === "pass"
          ? near
            ? "Matches NEAR"
            : "Checked"
          : check === "fail"
            ? "Failed"
            : check === "pending"
              ? "Checking"
              : "Not checked"
      }
      className="size-[1.125rem]"
    />
  );
  return (
    <li className="grid grid-cols-[auto_1fr] gap-x-3 py-2.5 [&+&]:border-t [&+&]:border-hairline">
      <span className="pt-px">{glyph}</span>
      <span>
        <span
          className={cn(
            "block text-[0.9375rem] font-semibold leading-snug",
            check === "info" && "text-text-2",
          )}
        >
          {children}
        </span>
        {detail && <span className="mt-0.5 block text-[0.8125rem] leading-snug text-text-2">{detail}</span>}
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-flex min-h-8 items-center gap-1 text-[0.8125rem] font-semibold text-text underline decoration-text-3 underline-offset-4 hover:decoration-text focus-visible:outline-2 focus-visible:outline-text"
          >
            {linkLabel}
            <ExternalLink className="size-3.5" aria-hidden="true" />
          </a>
        )}
      </span>
    </li>
  );
}

export function Details({ rows }: { rows: [string, string][] }) {
  return (
    <details className="group mt-7 text-[0.8125rem]">
      <summary className="inline-flex min-h-9 cursor-pointer list-none items-center gap-1.5 rounded-md font-semibold text-text-2 outline-none hover:text-text focus-visible:outline-2 focus-visible:outline-text [&::-webkit-details-marker]:hidden">
        <span
          className="inline-block transition-transform duration-200 group-open:rotate-90"
          aria-hidden="true"
        >
          ›
        </span>
        Technical details
      </summary>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-text-3">{k}</dt>
            <dd className="numeral min-w-0 break-all text-text-2">{v}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
