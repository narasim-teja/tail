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
import type { Check } from "./marks.ts";
import { ProofLine, Section } from "./sheet.tsx";

export function HandlerVerified({ check }: { check: HandlerCheck | null }) {
  if (!check) return null;
  return (
    <Section label="Verified">
      <ul>
        <SignatureLine check={check} />
        {check.signature === "signed" && check.signer && (
          <AttestationLines signer={check.signer} model={check.model ?? HANDLER_MODEL} />
        )}
      </ul>
    </Section>
  );
}

/** The NEAR AI signature on the Handler's chat, recovered in the browser (see HandlerCheck). */
function SignatureLine({ check }: { check: HandlerCheck }) {
  const s = check.signature;
  return (
    <ProofLine
      check={s === "signed" ? "pass" : s === "bad" ? "fail" : "info"}
      detail={
        s === "signed"
          ? `The key ${short(check.signer ?? "", 6)} signed hashes of this chat's request and response for ${check.model} (ECDSA, recovered in your browser). The response hash isn't matched to the quote here.`
          : s === "bad"
            ? "The signature in the log doesn't come from the address logged with it."
            : s === "unsigned"
              ? "No model signature was logged for this line (a template line, or the lookup failed), so there is no key to tie to NEAR AI's hardware."
              : "This replay doesn't carry the text the model signed, so the signature wasn't checked."
      }
    >
      {s === "signed" ? "The model's chat is signed" : "The model's signature"}
    </ProofLine>
  );
}

const TITLES: Record<Exclude<CheckId, "signer">, string> = {
  tdx: "Intel TDX quote is genuine",
  address: "The quote names the signing key",
  nonce: "The quote is fresh",
  compose: "The measured container manifest",
  gpu: "NVIDIA GPU attestation",
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

  const row = (id: (typeof ORDER)[number]) => {
    const c: AttestationCheck | undefined =
      id === "gpu" && here ? gpuSaved : node.checks.find((x) => x.id === id);
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
    const glyph: Check = !c.ok ? "fail" : forThisKey ? "pass" : "info";
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
      <ProofLine check={signerCheck.ok ? "pass" : "info"} detail={signerCheck.detail}>
        {signerCheck.ok
          ? "The signing key is NEAR AI's attested key"
          : "The signing key isn't in NEAR AI's report"}
      </ProofLine>
      {ORDER.map(row)}
      <li className="pt-2 text-[0.75rem] leading-snug text-text-3">
        {here
          ? `Checked in your browser at ${when(here.at)}, against a report NEAR AI made for the fresh nonce ${short(here.nonce, 6)}: the TDX quote with dcap-qvl and Intel-signed collateral (fetched through Phala's cache), the key and nonce in its report data, and the manifest. ${savedAt ? `NVIDIA's service doesn't answer browsers, so the GPU row was checked by scripts/verify-nearai.ts at ${savedAt}.` : ""}`
          : `NEAR AI's report couldn't be fetched here (${live.kind === "unreachable" ? live.reason : ""}). Checked by scripts/verify-nearai.ts at ${savedAt}, with the nonce ${short(saved?.nonce ?? "", 6)}.`}
      </li>
    </>
  );
}
