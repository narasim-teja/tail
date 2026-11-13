// When the relay plays on another contract than this build, balances read zero and joins go to
// the wrong place. Say so plainly and point at the fix. The app never adopts the relay's contract:
// the phone attests and holds its keys for the build's contract, which is what vouches for the
// referee.
import { Notice } from "./kit";

export function ContractMismatch({ relay }: { relay: string }) {
  return (
    <Notice
      icon="zone"
      title="This relay plays on another contract"
      detail={`It uses ${relay}. Change the relay in Settings, under Advanced.`}
    />
  );
}
