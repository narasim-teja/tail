// Profile, from your name on Home: who you are on NEAR and what you hold. The account id can be
// selected (long-press to copy), shared, or opened in the explorer; the balance tops up on
// testnet and withdraws. Three facts close it: this iPhone, the network, the contract.
import { type ReactNode, useEffect } from "react";
import { Linking, Share, StyleSheet, Text, View } from "react-native";
import { handleOf } from "../game/huntModel";
import { NEAR_NETWORK, TOP_UP, useApp } from "../state/app";
import { Icon } from "../ui/brand";
import { RollingMoney } from "../ui/game";
import { Avatar, Button, Display, Eyebrow, Label, Notice, Num, Row, Rule, Screen } from "../ui/kit";
import { useReduceMotion } from "../ui/motion";
import { color, HIT, maxScale, space, text } from "../ui/theme";

export interface ProfileModel {
  accountId: string;
  balance: bigint | null;
  network: string;
  contractId: string;
  busy: string | null;
  error: string | null;
}

export interface ProfileActions {
  onTopUp: () => void;
  onWithdraw: () => void;
  onBack: () => void;
}

export const explorerUrl = (network: string, accountId: string) =>
  `https://${network === "mainnet" ? "" : "testnet."}nearblocks.io/address/${accountId}`;

export function ProfileView({ m, actions }: { m: ProfileModel; actions: ProfileActions }) {
  const reduceMotion = useReduceMotion();
  const testnet = m.network === "testnet";
  return (
    <Screen footer={<Button kind="quiet" symbol="chevron.left" title="Back" onPress={actions.onBack} />}>
      <View style={styles.who}>
        <Avatar name={m.accountId} size={64} mark />
        <Display>{handleOf(m.accountId)}</Display>
        <Text selectable maxFontSizeMultiplier={maxScale.text} style={styles.account}>
          {m.accountId}
        </Text>
        <Row gap="s">
          <Button
            kind="secondary"
            symbol="square.and.arrow.up"
            title="Share"
            onPress={() => void Share.share({ message: m.accountId })}
            hint="Copy or send your account id"
          />
          <Button
            kind="secondary"
            symbol="arrow.up.right.square"
            title="View on NEAR"
            onPress={() => void Linking.openURL(explorerUrl(m.network, m.accountId))}
            hint="Opens the NEAR explorer"
          />
        </Row>
      </View>

      <Rule />
      <View accessible accessibilityLabel={m.balance === null ? "Balance loading" : "Balance"}>
        <Eyebrow muted>{testnet ? "Test balance" : "Balance"}</Eyebrow>
        {m.balance === null ? <Num>-</Num> : <RollingMoney units={m.balance} reduceMotion={reduceMotion} />}
      </View>
      <Row gap="s" style={styles.actions}>
        {testnet ? (
          <Button
            kind="secondary"
            symbol="plus.circle"
            title={m.busy === "Topping up" ? "Topping up" : "Top up 10"}
            busy={m.busy === "Topping up"}
            hint="Test USDC from the relay"
            onPress={actions.onTopUp}
            style={styles.grow}
          />
        ) : null}
        <Button
          kind="secondary"
          symbol="arrow.down.circle"
          title={m.busy === "Withdrawing" ? "Withdrawing" : "Withdraw"}
          busy={m.busy === "Withdrawing"}
          disabled={!m.balance}
          hint="Sends your balance to your NEAR account"
          onPress={actions.onWithdraw}
          style={styles.grow}
        />
      </Row>
      {m.error ? <Notice title="That didn't go through" detail={m.error} /> : null}

      <Rule />
      <Fact label="This iPhone">
        <Row gap="xs">
          <Icon name="verified" size={18} />
          <Label>Verified</Label>
        </Row>
      </Fact>
      <Fact label="Network">
        <Label>{testnet ? "Testnet" : m.network}</Label>
      </Fact>
      <Fact label="Contract">
        <Text selectable numberOfLines={1} maxFontSizeMultiplier={maxScale.text} style={styles.value}>
          {m.contractId || "Not set"}
        </Text>
      </Fact>
    </Screen>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.fact}>
      <Label muted>{label}</Label>
      <View style={styles.factValue}>{children}</View>
    </View>
  );
}

export function Profile() {
  const app = useApp();
  useEffect(() => app.refreshWallet(), [app]);
  return (
    <ProfileView
      m={{
        accountId: app.me ?? "",
        balance: app.wallet?.balance ?? null,
        network: NEAR_NETWORK,
        contractId: app.settings.contractId,
        busy: app.busy,
        error: app.error,
      }}
      actions={{
        onTopUp: () => void app.topUp(TOP_UP),
        onWithdraw: () => void app.withdraw(),
        onBack: () => app.openPage(null),
      }}
    />
  );
}

const styles = StyleSheet.create({
  who: { alignItems: "flex-start", gap: space.s, paddingTop: space.l, paddingBottom: space.s },
  account: { ...text.caption, color: color.mute },
  actions: { flexWrap: "nowrap" },
  grow: { flex: 1 },
  fact: { minHeight: HIT, flexDirection: "row", alignItems: "center", gap: space.l },
  factValue: { flex: 1, alignItems: "flex-end" },
  value: { ...text.label, color: color.ink },
});
