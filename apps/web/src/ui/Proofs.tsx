// The protocol v2 proofs in the details sheet: a tag's evidence with each cited contact's Merkle
// path (and NEAR's own check of it), presence proofs, the verdict chain and the append-only log.

import { EPOCH_MS, LOCK_EPOCHS, toHex, WINDOW_EPOCHS } from "@tail/protocol";
import { useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { clock, short } from "../lib/format.ts";
import { useStore } from "../lib/store.ts";
import type { MatchEvent } from "../model/match.ts";
import { toB64 } from "../verify/bundle.ts";
import { type InclusionAnswer, nearReader } from "../verify/chain.ts";
import { type EvidenceCheck, inclusionOf } from "../verify/evidence.ts";
import { PINS } from "../verify/pins.ts";
import { presenceFor, presenceParam, toPresenceJson } from "../verify/presence.ts";
import { useReplay } from "./context.tsx";
import { ProofLine, Section } from "./sheet.tsx";

const span = (e: number) => `${clock(e * EPOCH_MS)} to ${clock((e + 1) * EPOCH_MS)}`;

// ── Tag evidence ──────────────────────────────────────────────────────────────────

/** This v2 Tag's Evidence check, as prepared once for the replay (a v2 tag always has one). */
function useEvidence(ev: MatchEvent): EvidenceCheck {
  const c = useReplay().tags[ev.index];
  return c?.proto === 2 ? c.evidence : { kind: "missing" };
}

/** The Evidence entry the referee logged before this Tag, re-checked against the strike rule. */
export function EvidenceLines({ ev }: { ev: MatchEvent }) {
  const { match } = useReplay();
  const r = useEvidence(ev);
  const h = match.players[ev.a ?? 0]?.name;
  const t = match.players[ev.b ?? 0]?.name;
  if (r.kind !== "checked")
    return (
      <ProofLine
        check="fail"
        detail="Protocol v2 logs the evidence just before every tag; this one has none."
      >
        The tag's evidence is missing
      </ProofLine>
    );
  const e = r.strikeEpoch;
  const problems = [
    !r.sameTag && "the entry names another hunter or target",
    !r.inWindow && `a cited window is outside the ${WINDOW_EPOCHS} up to the strike, or repeats`,
    r.count < LOCK_EPOCHS && `it cites ${r.count}, and a tag needs ${LOCK_EPOCHS}`,
    !r.touching && "none is in the strike's window or the one before",
    r.afterAssigned === false && `a window is from before ${h} was hunting ${t}`,
    r.afterAssigned === null && `the log doesn't say when ${h} started hunting ${t}`,
    r.contacts.some((c) => c.logIndex === null) && "a cited window has no contact in the log before the tag",
    !r.targetOk && `${t} wasn't ${h}'s target`,
    r.strike === "differs" && "the hunter's released report doesn't carry this strike",
  ].filter(Boolean);
  return (
    <>
      <ProofLine
        check={r.ok ? "pass" : "fail"}
        detail={
          r.ok
            ? `${r.strike === "match" ? "The strike came in" : "The referee's entry puts the strike in"} ${span(e)}. The referee cites ${r.count} windows in the ${WINDOW_EPOCHS} up to it, one in the strike's window or the one before, all after ${h} started hunting ${t}, each a contact it logged before the tag. A tag needs ${LOCK_EPOCHS}.`
            : `This doesn't meet the rule: ${problems.join("; ")}.`
        }
      >
        The referee logged {r.count} contact window{r.count === 1 ? "" : "s"}
      </ProofLine>
      <ProofLine
        check={r.strike === "match" ? "pass" : r.strike === "differs" ? "fail" : "info"}
        detail={
          r.strike === "match"
            ? `${h}'s released report #${r.strikeSeq} carries the strike, in that window.`
            : r.strike === "differs"
              ? `${h}'s released report #${r.strikeSeq} has no strike in ${span(e)}.`
              : "The phones' reports weren't released, so the strike's window comes from the referee's entry alone."
        }
      >
        The strike report
      </ProofLine>
    </>
  );
}

/** Each contact the Tag's evidence cites, with its Merkle path. */
export function EvidenceContacts({ ev }: { ev: MatchEvent }) {
  const r = useEvidence(ev);
  if (r.kind !== "checked") return null;
  return (
    <Section label="Contacts behind the tag">
      <p className="mb-2 text-[0.8125rem] leading-snug text-text-2">
        Each window is a Contact entry in the match log, with its path to an anchored root: anyone can check
        it was there.
      </p>
      <ul>
        {r.contacts.map((c) =>
          c.logIndex === null ? (
            <ProofLine
              key={c.epoch}
              check="fail"
              detail="The log holds no contact for this window before the tag."
            >
              <span className="numeral">{span(c.epoch)}</span>
            </ProofLine>
          ) : (
            <ContactProof key={c.epoch} logIndex={c.logIndex} epoch={c.epoch} />
          ),
        )}
      </ul>
    </Section>
  );
}

/** One Contact entry: its inclusion path checked here, and on NEAR by the contract's own view. */
export function ContactProof({
  logIndex,
  epoch,
  withPresence = false,
}: {
  logIndex: number;
  epoch: number;
  /** Offer "Make presence proof" for this contact. */
  withPresence?: boolean;
}) {
  const { decoded, verify } = useReplay();
  const anchored = useStore(verify, (s) => s.anchored);
  const chain = useStore(verify, (s) => s.chainSummary);
  const binding = useStore(verify, (s) => s.binding);
  const [answer, setAnswer] = useState<InclusionAnswer | "checking" | null>(null);
  const inc = anchored ? inclusionOf(decoded, logIndex, anchored.roots) : null;
  const onNear = anchored?.source === "near" && binding.ok && chain === "found";
  const entry = decoded.log[logIndex];

  const check = () => {
    if (!inc || !entry) return;
    setAnswer("checking");
    void nearReader(PINS.network)
      .verifyInclusion(PINS.contract, {
        matchId: decoded.raw.match.id,
        entry: toB64(entry.bytes),
        index: inc.index,
        size: inc.size,
        path: inc.path.map(toB64),
      })
      .then(setAnswer);
  };

  return (
    <ProofLine
      check={!anchored ? "pending" : inc?.ok ? "pass" : "fail"}
      detail={
        <>
          {!anchored
            ? "Waiting for NEAR's roots…"
            : !inc
              ? "No anchored root covers this entry."
              : `Entry ${logIndex}: a ${inc.path.length}-step path to the root ${onNear ? "NEAR holds" : "the referee signed"} at size ${inc.size}, ${inc.ok ? "checked here" : "and it doesn't lead there"}.`}
          {inc && (
            <details className="mt-1">
              <summary className="cursor-pointer text-text-3 hover:text-text">Path</summary>
              <ol className="numeral mt-1 space-y-0.5 break-all text-text-3">
                {inc.path.map((p, i) => (
                  <li key={toHex(p)}>
                    {i + 1}. {short(toHex(p), 10)}
                  </li>
                ))}
                <li>root {short(toHex(inc.root), 10)}</li>
              </ol>
            </details>
          )}
          {inc && onNear && (
            <span className="mt-1.5 flex flex-wrap items-center gap-2">
              <Button size="sm" variant="quiet" onClick={check} disabled={answer === "checking"}>
                Check on NEAR
              </Button>
              {answer && answer !== "checking" && (
                <span aria-live="polite">
                  {answer.kind === "answered"
                    ? answer.included
                      ? "NEAR's contract checked the path: the entry is in the log it anchored."
                      : "NEAR's contract says the path doesn't lead to its root."
                    : answer.kind === "no-view"
                      ? "This contract has no verify_inclusion view yet, so NEAR couldn't check it."
                      : "NEAR couldn't be reached."}
                </span>
              )}
            </span>
          )}
          {inc && !onNear && (
            <span className="mt-1 block text-text-3">
              {chain === "checking"
                ? "Asking NEAR…"
                : !binding.ok
                  ? "This replay isn't for the contract and match this page checks, so NEAR wasn't asked."
                  : chain === "unreachable"
                    ? "NEAR couldn't be reached, so it couldn't check the path."
                    : "NEAR has no match with this id, so it holds no root to check the path against."}
            </span>
          )}
          {withPresence && <PresenceMaker logIndex={logIndex} />}
        </>
      }
    >
      <span className="numeral">{span(epoch)}</span>
    </ProofLine>
  );
}

// ── Presence proofs ───────────────────────────────────────────────────────────────

/** "Make presence proof" for one Contact entry: the JSON, to copy or open on the presence page. */
export function PresenceMaker({ logIndex }: { logIndex: number }) {
  const { decoded, verify } = useReplay();
  const anchored = useStore(verify, (s) => s.anchored);
  const [open, setOpen] = useState(false);
  const proof = open && anchored ? presenceFor(decoded, logIndex, anchored.roots) : null;
  const json = proof ? JSON.stringify(toPresenceJson(proof), null, 2) : "";
  return (
    <span className="mt-1.5 block">
      <Button size="sm" variant="quiet" onClick={() => setOpen((o) => !o)} disabled={!anchored}>
        {open ? "Hide presence proof" : "Make presence proof"}
      </Button>
      {open && !proof && (
        <span className="mt-1 block">
          No anchored root covers this contact yet, so there's nothing to prove it against.
        </span>
      )}
      {proof && (
        <span className="mt-2 block">
          <textarea
            readOnly
            value={json}
            aria-label="Presence proof"
            className="numeral h-40 w-full resize-y rounded-xl bg-surface-2 p-3 text-[0.75rem] text-text-2 outline-none focus-visible:outline-2 focus-visible:outline-text"
          />
          <span className="mt-1.5 flex flex-wrap gap-2">
            <Button size="sm" variant="quiet" onClick={() => void navigator.clipboard?.writeText(json)}>
              Copy
            </Button>
            <Button size="sm" variant="quiet" asChild>
              <a href={`?presence=${presenceParam(proof)}`} target="_blank" rel="noreferrer">
                Check it against NEAR
              </a>
            </Button>
          </span>
        </span>
      )}
    </span>
  );
}

// ── Verdict chain and append-only log, for the summary ────────────────────────────

export function HistoryLines() {
  const { decoded, verify } = useReplay();
  const history = useStore(verify, (s) => s.history);
  if (!history)
    return (
      <>
        <ProofLine check="pending">Verdict history is one unbroken chain</ProofLine>
        <ProofLine check="pending">Each checkpoint extends the previous one</ProofLine>
      </>
    );
  const { verdictChain: vc, consistency: cs } = history;
  const n = decoded.verdicts.length;
  const links = cs.links.length;
  const bad = cs.links.filter((l) => !l.ok);
  // "Same as on NEAR" only when NEAR's head was read and compared.
  const sameAsNear = vc.kind === "checked" && vc.breakAt === null && vc.onNear === "match";
  return (
    <>
      <ProofLine
        near={sameAsNear}
        check={vc.kind === "v1" ? "info" : vc.breakAt !== null || vc.onNear === "mismatch" ? "fail" : "pass"}
        detail={
          vc.kind === "v1"
            ? "Recorded before protocol v2, when verdicts weren't chained, so there is no chain to check."
            : vc.breakAt !== null
              ? `Verdict #${vc.breakAt + 1} doesn't link to the one before it (its seq, link or signature is off).`
              : vc.onNear === "match"
                ? `All ${n} verdicts link to the one before, and the last is the head NEAR's contract holds (${short(toHex(vc.head ?? new Uint8Array()), 6)}).`
                : vc.onNear === "mismatch"
                  ? "Every verdict links to the one before, but NEAR's contract holds a different head: it has verdicts this replay doesn't."
                  : vc.onNear === "no-view"
                    ? `All ${n} verdicts link to the one before. NEAR's contract doesn't expose its chain head yet, so the head wasn't compared.`
                    : `All ${n} verdicts link to the one before. NEAR's head wasn't compared (no such match on NEAR, or it couldn't be reached).`
        }
      >
        {sameAsNear
          ? "Verdict history is one unbroken chain, same as on NEAR"
          : "Verdict history is one unbroken chain"}
      </ProofLine>
      <ProofLine
        near={cs.source === "near" && cs.ok && links > 0}
        check={links === 0 ? "info" : cs.ok ? "pass" : "fail"}
        detail={
          links === 0
            ? "There's only one anchored root, so there is nothing to compare it with."
            : cs.ok
              ? `Over this bundle's log, each root ${cs.source === "near" ? "NEAR holds" : "the referee signed"} extends the one before it: ${links} consistency proofs, built from the bundle's leaves, fit both roots of every pair, so the log at each checkpoint is a prefix of the next.${decoded.version === 2 ? " NEAR's contract checks the referee's own proof before it stores a checkpoint, too." : ""}`
              : `${bad.length} of ${links} links fail: over this bundle's log, the root at ${bad.map((l) => l.from).join(", ")} entries doesn't extend into the next. Either the log changed after that checkpoint, or this isn't the log that was anchored.${decoded.version === 2 ? " NEAR's contract would have refused a checkpoint that didn't extend the last." : ""}`
        }
      >
        Each checkpoint extends the previous one
      </ProofLine>
    </>
  );
}
