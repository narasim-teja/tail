// The player's Dossier card on Profile: their soulbound NEP-171 token, read from the contract's
// `get_dossier` through the phone's own RPC and drawn with @tail/brand's `dossierSvg`, the same
// bytes the contract returns as the token's media. Tapping it opens the replay's dossier page.
// A contract without dossiers (deployed before them) or an account without one shows nothing.

import { type DossierView, dossierSvg } from "@tail/brand";
import { useEffect, useState } from "react";
import { Animated, Linking, Pressable, StyleSheet, View } from "react-native";
import { SvgXml } from "react-native-svg";
import { NearRpc } from "../near/rpc";
import { handleOf } from "../tail/huntModel";
import { Caption, usePress } from "./kit";
import { color, radius, space } from "./theme";

export interface DossierSource {
  accountId: string;
  contractId: string;
  rpcUrl: string;
  /** The web replay the relay names; null when it names none, and the card then opens nothing. */
  replayUrl: string | null;
}

export function DossierCard({ accountId, contractId, rpcUrl, replayUrl }: DossierSource) {
  const [view, setView] = useState<DossierView | null>(null);
  const press = usePress(0.98);

  useEffect(() => {
    if (!accountId || !contractId) return;
    let live = true;
    new NearRpc(rpcUrl)
      .view<DossierView | null>(contractId, "get_dossier", { account_id: accountId })
      // No such view (an older contract) or NEAR unreachable: the card stays away.
      .then(
        (v) => live && setView(v),
        () => live && setView(null),
      );
    return () => {
      live = false;
    };
  }, [accountId, contractId, rpcUrl]);

  if (!view) return null;
  const page = replayUrl ? `${replayUrl}/dossier/${accountId}` : null;
  const label =
    `${handleOf(accountId)}'s dossier: ${view.matches} settled matches, ` +
    `${view.survived} survived, ${view.tags} tags`;
  return (
    <View style={styles.wrap}>
      <Pressable
        accessibilityRole={page ? "link" : "image"}
        accessibilityLabel={label}
        accessibilityHint={page ? "Opens the full record and its proofs" : undefined}
        disabled={!page}
        onPress={() => page && void Linking.openURL(page)}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
      >
        <Animated.View style={[styles.card, { transform: [{ scale: press.scale }] }]}>
          <SvgXml xml={dossierSvg(view)} width="100%" height="100%" />
        </Animated.View>
      </Pressable>
      <Caption style={styles.note}>
        Your record on NEAR, bound to this account. Hosts can open a match only to players with one.
      </Caption>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.s },
  // The card is 400 × 500 and draws its own folder shape; the shadow lifts it off the paper.
  card: {
    aspectRatio: 400 / 500,
    width: "100%",
    maxWidth: 420,
    alignSelf: "center",
    borderRadius: radius.l,
    shadowColor: color.ink,
    shadowOpacity: 0.22,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
  },
  note: { color: color.mute },
});
