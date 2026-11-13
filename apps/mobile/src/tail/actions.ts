// TAIL's player actions (TECHNICAL.md 4.3, 4.7): Hint{kind, nonce, text?} and Strike{nonce}. The
// nonce lets the referee's "refused" answer name the action it refused. They travel in the next
// batch through the proximity layer (ProximityClient.queueAction), which does not read them.

import { type Action, HINT_TEXT_MAX, type HintKind } from "@tail/protocol";

const randomNonce = () => crypto.getRandomValues(new Uint32Array(1))[0] as number;

export class TailActions {
  constructor(private readonly nonce: () => number = randomNonce) {}

  hint(kind: HintKind, question?: string): Action {
    const text = question?.trim().slice(0, HINT_TEXT_MAX);
    return text
      ? { kind: "Hint", hint: kind, nonce: this.nonce(), text }
      : { kind: "Hint", hint: kind, nonce: this.nonce() };
  }

  strike(): Action {
    return { kind: "Strike", nonce: this.nonce() };
  }
}
