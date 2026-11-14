// The Handler line's "Verified" panel: the chat signature (recovered in the browser), then NEAR AI's
// attestation for the key that made it. See verify/nearai.ts for the checks and nearai-live.ts for
// which run here and which come from scripts/verify-nearai.ts.

import { useEffect, useState } from "react";
import { short } from "../lib/format.ts";
import type { HandlerCheck } from "../verify/checks.ts";
import {
  type Check as AttestationCheck,
  type CheckId,
  checkSigner,
  HANDLER_MODEL,
  type NodeResult,
  nodeOk,
} from "../verify/nearai.ts";
import { type Attested, attestation } from "../verify/nearai-live.ts";
import { useReplay } from "./context.tsx";
import type { Check } from "./marks.ts";
import { ProofLine, Section } from "./sheet.tsx";

export function HandlerVerified({ check }: { check: HandlerCheck | null }) {
  const { source } = useReplay();
  if (!check) return null;
  // A generated match's lines are written by hand and signed with a public test key: no NEAR AI
  // model made them, and the name they log is not one NEAR AI serves. The panel says so, then
  // checks NEAR AI's live attestation for the model real matches use, so the checks still run.
  const generated = source.kind === "fixture";
  return (
    <Section label="Verified">
      <ul>
        <SignatureLine check={check} generated={generated} />
        {check.signature === "signed" && check.signer && (
          <>
            {generated && (
              <ProofLine
                check="info"
                detail={`This generated match's Handler lines were written by hand and signed with a public test key, not by NEAR AI. Below is NEAR AI's live attestation for ${HANDLER_MODEL}, the model real matches use; the test key isn't in it.`}
              >
                A test key signed this line
              </ProofLine>
            )}
            <AttestationLines
              signer={check.signer}
              model={generated ? HANDLER_MODEL : (check.model ?? HANDLER_MODEL)}
            />
          </>
        )}
      </ul>
    </Section>
  );
}

/** The NEAR AI signature on the Handler's chat, recovered in the browser (see HandlerCheck). */
function SignatureLine({ check, generated }: { check: HandlerCheck; generated: boolean }) {
  const s = check.signature;
  return (
    <ProofLine
      check={s === "signed" ? "pass" : s === "bad" ? "fail" : "info"}
      detail={
        s === "signed" && generated
          ? `The key ${short(check.signer ?? "", 6)} signed hashes of this line's request and response (ECDSA, recovered in your browser), the way NEAR AI signs a real chat.`
          : s === "signed"
            ? `The key ${short(check.signer ?? "", 6)} signed hashes of this chat's request and response for ${check.model} (ECDSA, recovered in your browser). The response hash isn't matched to the quote here.`
            : s === "bad"
              ? "The signature in the log doesn't come from the address logged with it."
              : s === "unsigned"
                ? "No model signature was logged for this line (a template line, or the lookup failed), so there is no key to tie to NEAR AI's hardware."
                : "This replay doesn't carry the text the model signed, so the signature wasn't checked."
      }
    >
      {s === "signed" && generated
        ? "The line is signed"
        : s === "signed"
          ? "The model's chat is signed"
          : "The model's signature"}
    </ProofLine>
  );
}

// Each title says exactly what its check shows. None of them pins the image NEAR AI should run:
// NEAR AI publishes no expected MRTD, RTMRs or manifest (see verify/nearai.ts).
const TITLES: Record<Exclude<CheckId, "signer">, string> = {
  tdx: "Intel TDX quote is genuine and up to date",
  address: "The quote names the signing key",
  nonce: "The quote is fresh",
  compose: "The quote measures this container manifest",
  gpu: "GPUs attested by NVIDIA for the same nonce",
};
const ORDER = ["tdx", "address", "nonce", "compose", "gpu"] as const;

const when = (d: Date) => d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function AttestationLines({ signer, model }: { signer: string; model: string }) {
  const [state, setState] = useState<Attested | null>(null);
  useEffect(() => {
    let live = true;
    attestation(model).then((a) => live && setState(a));
    return () => {
      live = false;
    };
  }, [model]);

  if (!state)
    return (
      <ProofLine check="pending" detail="Fetching NEAR AI's attestation report with a fresh nonce.">
        Checking the key's hardware
      </ProofLine>
    );

  const { live, saved } = state;
  const here = live.kind === "checked" ? live : null;
  const savedAt = saved ? when(new Date(saved.checkedAt)) : null;
  const nodes: NodeResult[] = here?.nodes ?? (saved?.model === model ? saved.nodes : []);
  if (nodes.length === 0)
    return (
      <ProofLine
        check="info"
        detail={`NEAR AI's report couldn't be fetched here${live.kind === "unreachable" ? ` (${live.reason})` : ""}, and this page has no saved result for ${model}. Run scripts/verify-nearai.ts.`}
      >
        The key's hardware wasn't checked
      </ProofLine>
    );

  const signerCheck = checkSigner(
    nodes.filter(nodeOk).map((n) => n.signingAddress),
    signer,
  );
  const node = nodes.find((n) => n.signingAddress === signer.toLowerCase()) ?? (nodes[0] as NodeResult);
  const forThisKey = node.signingAddress === signer.toLowerCase();
  const gpuSaved = saved?.nodes
    .find((n) => n.signingAddress === node.signingAddress)
    ?.checks.find((c) => c.id === "gpu");

  // A row the script checked, not this page: the GPUs always (NVIDIA refuses browsers), and every
  // row when NEAR AI's report couldn't be fetched here.
  const fromSaved = (id: (typeof ORDER)[number]) => !here || id === "gpu";
  const row = (id: (typeof ORDER)[number]) => {
    const pool = id === "gpu" && here ? (gpuSaved ? [gpuSaved] : []) : node.checks.filter((x) => x.id === id);
    // The worst of a row's checks, so a failing one is never hidden behind a passing one.
    const c: AttestationCheck | undefined = pool.find((x) => !x.ok) ?? pool[0];
    if (!c)
      return (
        <ProofLine
          key={id}
          check="info"
          detail="NVIDIA's attestation service doesn't answer browsers, and scripts/verify-nearai.ts hasn't checked this key."
        >
          {TITLES[id]}
        </ProofLine>
      );
    const glyph: Check = !c.ok ? "fail" : !forThisKey ? "info" : fromSaved(id) ? "earlier" : "pass";
    const key = forThisKey
      ? ""
      : `For NEAR AI's current key ${short(node.signingAddress, 6)}, not this line's: `;
    // In the browser the GPU row is the script's, made for the script's own nonce.
    const prefix = id === "gpu" && here ? `${key}By scripts/verify-nearai.ts, for its own nonce: ` : key;
    return (
      <ProofLine key={id} check={glyph} detail={`${prefix}${c.detail}`}>
        {TITLES[id]}
      </ProofLine>
    );
  };

  return (
    <>
      <ProofLine check={!signerCheck.ok ? "info" : here ? "pass" : "earlier"} detail={signerCheck.detail}>
        {signerCheck.ok
          ? "The signing key is NEAR AI's attested key"
          : "The signing key isn't in NEAR AI's report"}
      </ProofLine>
      {ORDER.map(row)}
      <li className="pt-2 text-[0.75rem] leading-snug text-text-3">
        {here
          ? `Checked in your browser at ${when(here.at)}, against a report NEAR AI made for the fresh nonce ${short(here.nonce, 6)}: the TDX quote with dcap-qvl and Intel-signed collateral (fetched through Phala's cache), the key and nonce in its report data, and the manifest. ${savedAt ? `NVIDIA's service doesn't answer browsers, so the GPU row was checked by scripts/verify-nearai.ts at ${savedAt}.` : ""}`
          : `NEAR AI's report couldn't be fetched here (${live.kind === "unreachable" ? live.reason : ""}). Checked by scripts/verify-nearai.ts at ${savedAt}, with the nonce ${short(saved?.nonce ?? "", 6)}.`}{" "}
        Nothing here pins the image NEAR AI should run: it publishes no expected measurements, so a pass shows
        a genuine Intel TDX machine, not in debug mode, holds the key, not which code it runs. The GPUs are
        tied to it only by the shared nonce.
      </li>
    </>
  );
}
