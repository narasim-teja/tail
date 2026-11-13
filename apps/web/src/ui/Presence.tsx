// The presence proof page (`/?presence=<proof>`, or `/?presence` to paste one): checks that two
// phones were near each other in one fifteen-second window, against the pinned contract alone.
// The anchored roots and the player list are read from NEAR over RPC; nothing comes from a relay.

import { EPOCH_MS, encodeLogEntry, type PresenceProof, toHex } from "@tail/protocol";
import { useCallback, useEffect, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { day } from "../lib/format.ts";
import { displayName } from "../model/match.ts";
import type { ChainState } from "../verify/anchor.ts";
import { toB64 } from "../verify/bundle.ts";
import { type InclusionAnswer, nearReader } from "../verify/chain.ts";
import { PINS } from "../verify/pins.ts";
import { checkPresence, fromPresenceParam, type PresenceCheck, parsePresence } from "../verify/presence.ts";
import { ProofLine } from "./sheet.tsx";

type Result =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "unreadable"; message: string }
  | { kind: "done"; proof: PresenceProof; chain: ChainState; check: PresenceCheck };

const WHY: Record<string, string> = {
  "not-contact": "The proof isn't about a contact between two phones.",
  "no-root": "NEAR holds no root of the size this proof names for this match.",
  "bad-path":
    "The Merkle path doesn't lead to the root NEAR holds, so this contact isn't in the anchored log.",
  "unknown-player": "The contact names a player this match doesn't have.",
  "wrong-accounts": "The accounts in the proof aren't the players NEAR lists for this match.",
  "no-match": "NEAR has no such match on the contract this page checks.",
};

export function PresencePage({ initial }: { initial: string }) {
  const [text, setText] = useState(() => {
    if (!initial) return "";
    try {
      return JSON.stringify(JSON.parse(fromPresenceParam(initial)), null, 2);
    } catch {
      return initial;
    }
  });
  const [result, setResult] = useState<Result>({ kind: "idle" });
  const [nearCheck, setNearCheck] = useState<InclusionAnswer | "checking" | null>(null);

  const run = useCallback(async (input: string) => {
    let proof: PresenceProof;
    try {
      proof = parsePresence(input);
    } catch (e) {
      setResult({ kind: "unreadable", message: e instanceof Error ? e.message : "unreadable" });
      return;
    }
    setResult({ kind: "checking" });
    setNearCheck(null);
    // The pinned contract and the proof's match id; the proof's own contract is only compared.
    const chain = await nearReader(PINS.network).read(PINS.contract, toHex(proof.matchId));
    setResult({ kind: "done", proof, chain, check: checkPresence(proof, chain, PINS.contract) });
  }, []);

  // Only the proof the page was opened with runs on its own.
  const [linked] = useState(text);
  useEffect(() => {
    if (initial) void run(linked);
  }, [initial, linked, run]);

  const askNear = (proof: PresenceProof) => {
    setNearCheck("checking");
    void nearReader(PINS.network)
      .verifyInclusion(PINS.contract, {
        matchId: toHex(proof.matchId),
        entry: toB64(encodeLogEntry(proof.entry)),
        index: Number(proof.index),
        size: Number(proof.size),
        path: proof.path.map(toB64),
      })
      .then(setNearCheck);
  };

  return (
    <main className="min-h-dvh bg-dusk px-4 py-10 sm:px-6">
      <div className="mx-auto w-full max-w-[34rem]">
        <h1 className="text-[1.75rem] font-bold leading-tight tracking-[-0.01em] text-balance [font-stretch:104%]">
          Were these two phones near each other?
        </h1>
        <p className="mt-3 text-[1rem] leading-relaxed text-text-2 text-pretty">
          A presence proof is one contact from a TAIL match log with its path to a root NEAR stored. This page
          checks it against {PINS.contract} on NEAR, and nothing else.
        </p>
        <label className="mt-6 block text-[0.8125rem] font-semibold text-text-2" htmlFor="proof">
          Presence proof (JSON, or base64)
        </label>
        <textarea
          id="proof"
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          className="numeral mt-2 h-48 w-full resize-y rounded-2xl bg-surface p-4 text-[0.8125rem] text-text outline-none focus-visible:outline-2 focus-visible:outline-text"
        />
        <Button
          variant="solid"
          className="mt-4"
          onClick={() => void run(text)}
          disabled={!text.trim() || result.kind === "checking"}
        >
          Check against NEAR
        </Button>
        <div className="mt-8" aria-live="polite">
          {result.kind === "checking" && <p className="text-text-2">Reading the match from NEAR…</p>}
          {result.kind === "unreadable" && (
            <p className="text-text">This isn't a presence proof this page can read ({result.message}).</p>
          )}
          {result.kind === "done" && (
            <Outcome result={result} nearCheck={nearCheck} onAskNear={() => askNear(result.proof)} />
          )}
        </div>
      </div>
    </main>
  );
}

function Outcome({
  result,
  nearCheck,
  onAskNear,
}: {
  result: Extract<Result, { kind: "done" }>;
  nearCheck: InclusionAnswer | "checking" | null;
  onAskNear: () => void;
}) {
  const { proof, chain, check } = result;
  const [a, b] = proof.accounts;
  if (!check.ok) {
    const why =
      check.why === "other-contract"
        ? `It names the contract ${check.named}, but this page checks ${PINS.contract}.`
        : check.why === "unreachable"
          ? "NEAR couldn't be reached, so nothing was checked. Try again in a moment."
          : (WHY[check.why] ?? "It doesn't hold.");
    return (
      <ul className="rounded-3xl bg-surface px-5 py-2">
        <ProofLine check={check.why === "unreachable" ? "info" : "fail"} near detail={why}>
          {check.why === "unreachable" ? "Not checked" : "This proof doesn't hold"}
        </ProofLine>
      </ul>
    );
  }
  const start = chain.kind === "found" ? chain.match.start_ms : null;
  const from = start === null ? null : start + check.epoch * EPOCH_MS;
  const at = (ms: number) =>
    new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
  return (
    <>
      <h2 className="text-[1.375rem] font-bold leading-snug">
        {displayName(a)} and {displayName(b)} were near each other
      </h2>
      <p className="numeral mt-1.5 text-[0.9375rem] text-text-2">
        {from === null
          ? `In window ${check.epoch} of the match`
          : `${day(from)}, ${at(from)} to ${at(from + EPOCH_MS)}`}{" "}
        · match {toHex(proof.matchId).slice(0, 8)}
      </p>
      <ul className="mt-5 rounded-3xl bg-surface px-5 py-2">
        <ProofLine
          check="pass"
          near
          detail={`The contact's ${proof.path.length}-step Merkle path leads to the root NEAR stored at log size ${proof.size}, and NEAR lists ${a} and ${b} as these two players. The roots and players were read from NEAR here.`}
        >
          Matches NEAR
        </ProofLine>
        <ProofLine
          check="info"
          detail="No new signature: the proof is as strong as the referee's signature on that root, which NEAR checked before storing it. The contact itself is the referee's: the phones' sightings behind it stay sealed."
        >
          What it rests on
        </ProofLine>
        <ProofLine
          check={
            nearCheck && nearCheck !== "checking" && nearCheck.kind === "answered"
              ? nearCheck.included
                ? "pass"
                : "fail"
              : "info"
          }
          near={
            nearCheck !== null &&
            nearCheck !== "checking" &&
            nearCheck.kind === "answered" &&
            nearCheck.included
          }
          detail={
            <>
              {nearCheck === null || nearCheck === "checking"
                ? "Have NEAR's contract run the path check itself, with its verify_inclusion view."
                : nearCheck.kind === "answered"
                  ? nearCheck.included
                    ? "NEAR's contract checked the path itself: the contact is in the log it anchored."
                    : "NEAR's contract says the path doesn't lead to its root."
                  : nearCheck.kind === "no-view"
                    ? "This contract has no verify_inclusion view yet, so NEAR couldn't check it itself."
                    : "NEAR couldn't be reached."}
              <span className="mt-1.5 block">
                <Button size="sm" variant="quiet" onClick={onAskNear} disabled={nearCheck === "checking"}>
                  Check on NEAR
                </Button>
              </span>
            </>
          }
        >
          NEAR's own check
        </ProofLine>
      </ul>
      <a
        href={`?match=${toHex(proof.matchId)}`}
        className="mt-5 inline-flex min-h-9 items-center text-[0.875rem] font-semibold text-text underline decoration-text-3 underline-offset-4 hover:decoration-text"
      >
        Watch the match
      </a>
    </>
  );
}
