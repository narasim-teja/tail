// When the relay plays on another contract than this app is set to, balances read zero and joins
// go to the wrong place. Say so plainly and let the person switch with one tap: the app never
// adopts the relay's contract on its own, because the contract is what vouches for the referee.
import { StyleSheet, View } from "react-native";
import { Button, Notice } from "./kit";
import { space } from "./theme";

export function ContractMismatch({ relay, onUse }: { relay: string; onUse: () => void }) {
  return (
    <View style={styles.wrap}>
      <Notice icon="zone" title="The relay plays on another contract" detail={`Relay: ${relay}`} />
      <Button
        kind="secondary"
        symbol="arrow.triangle.2.circlepath"
        title="Use the relay's contract"
        onPress={onUse}
      />
    </View>
  );
}

const styles = StyleSheet.create({ wrap: { gap: space.s } });
