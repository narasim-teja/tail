// Profile, from your name on Home: who you are on NEAR and what you hold. The account id can be
// selected (long-press to copy), shared, or opened in the explorer. Under it, the player's
// Dossier, their soulbound record on NEAR. The balance tops up on testnet and withdraws. Facts
// close it: this iPhone, where withdrawals go, the network. The contract is in Settings >
// Advanced: a player never needs it here.
//
// The relay creates each account with only this phone's game key, so its payout starts as the
// account itself, where tokens could never leave. The first withdraw then asks for a wallet the
// player owns, and says before the field, not after it, that the choice is permanent.
import { type ReactNode, useEffect, useState } from "react";
import { Alert, Linking, Share, StyleSheet, Text, View } from "react-native";
import { CONTRACT_ID, NEAR_NETWORK, TOP_UP, useApp } from "../state/app";
import { handleOf, money } from "../tail/huntModel";
import { Icon } from "../ui/brand";
import { ContractMismatch } from "../ui/contract";
import { DossierCard } from "../ui/dossier";
import { RollingMoney } from "../ui/game";
import { Avatar, Button, Display, Eyebrow, Field, Label, Notice, Num, Row, Rule, Screen } from "../ui/kit";
import { useReduceMotion } from "../ui/motion";
import { color, HIT, maxScale, space, text } from "../ui/theme";

export interface ProfileModel {
  accountId: string;
  balance: bigint | null;
  network: string;
  contractId: string;
  busy: string | null;
  error: string | null;
  /** The relay's contract when it differs from this app's (ui/contract.tsx). */
  contractMismatch: string | null;
  /** A test relay: offers starting over with a new handle. */
  testRelay: boolean;
  /** Where withdrawals go; equal to accountId until a wallet is named; null while unknown. */
  payout: string | null;
  /** Where the Dossier card reads from and links to; without it there is no card. */
  dossier?: { rpcUrl: string; replayUrl: string | null };
}

export interface ProfileActions {
  onTopUp: () => void;
  /** `to`: the wallet that becomes the payout, while the payout is still this account. */
  onWithdraw: (to?: string) => void;
  /** Why a typed wallet cannot be the payout, or null when it can. */
  checkPayout: (to: string) => string | null;
  onStartOver: () => void;
  onRefresh?: () => Promise<unknown>;
  onBack: () => void;
}

export const explorerUrl = (network: string, accountId: string) =>
  `https://${network === "mainnet" ? "" : "testnet."}nearblocks.io/address/${accountId}`;

export function ProfileView({ m, actions }: { m: ProfileModel; actions: ProfileActions }) {
  const reduceMotion = useReduceMotion();
  const testnet = m.network === "testnet";
  const needsPayout = m.payout !== null && m.payout === m.accountId;
  const [to, setTo] = useState("");
  const typed = to.trim();
  const problem = needsPayout && typed ? actions.checkPayout(typed) : null;
  const withdraw = () => {
    if (!needsPayout) {
      actions.onWithdraw();
      return;
    }
    Alert.alert(
      "Make this your wallet for good?",
      `Everything ${handleOf(m.accountId)} withdraws goes to ${typed}, now and later. You can't change it.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Withdraw", onPress: () => actions.onWithdraw(typed) },
      ],
    );
  };
  return (
    <Screen
      onRefresh={actions.onRefresh}
      footer={<Button kind="quiet" symbol="chevron.left" title="Back" onPress={actions.onBack} />}
    >
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

      {m.dossier ? (
        <DossierCard
          accountId={m.accountId}
          contractId={m.contractId}
          rpcUrl={m.dossier.rpcUrl}
          replayUrl={m.dossier.replayUrl}
        />
      ) : null}

      <Rule />
      <View
        accessible
        accessibilityLabel={
          m.balance === null
            ? "Balance loading"
            : `${testnet ? "Test balance" : "Balance"} ${money(m.balance)}`
        }
      >
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
            hint="Adds 10 test USDC"
            onPress={actions.onTopUp}
            style={styles.grow}
          />
        ) : null}
        <Button
          kind="secondary"
          symbol="arrow.down.circle"
          title={m.busy === "Withdrawing" ? "Withdrawing" : "Withdraw"}
          busy={m.busy === "Withdrawing"}
          disabled={!m.balance || (needsPayout && (!typed || problem !== null))}
          hint={
            needsPayout
              ? "Sends your balance to the wallet below"
              : `Sends your balance to ${m.payout ?? "your wallet"}`
          }
          onPress={withdraw}
          style={styles.grow}
        />
      </Row>
      {needsPayout && m.balance ? (
        <View style={styles.payout}>
          <Notice
            title="Your first withdrawal picks your wallet for good"
            detail="Every withdrawal after it goes there too. Use a NEAR wallet you own: this game account can only play."
          />
          <Field
            label="Withdraw to"
            value={to}
            onChangeText={setTo}
            placeholder={testnet ? "your-wallet.testnet" : "your-wallet.near"}
            error={problem}
          />
        </View>
      ) : null}
      {m.contractMismatch ? <ContractMismatch relay={m.contractMismatch} /> : null}
      {m.error ? <Notice title="That didn't go through" detail={m.error} /> : null}

      <Rule />
      <Fact label="This iPhone">
        <Row gap="xs">
          <Icon name="verified" size={18} />
          <Label>Verified</Label>
        </Row>
      </Fact>
      {m.payout && !needsPayout ? (
        <Fact label="Withdrawals go to">
          <Text selectable numberOfLines={1} maxFontSizeMultiplier={maxScale.text} style={styles.value}>
            {m.payout}
          </Text>
        </Fact>
      ) : null}
      <Fact label="Network">
        <Label>{testnet ? "Testnet" : m.network}</Label>
      </Fact>
      {m.testRelay ? (
        <Button
          kind="quiet"
          symbol="arrow.counterclockwise"
          title="Start over with a new handle"
          hint="Test relay only. This account and its balance stay on NEAR."
          onPress={() =>
            Alert.alert(
              "Start over?",
              `You'll pick a new handle. ${handleOf(m.accountId)} keeps its balance on NEAR.`,
              [
                { text: "Cancel", style: "cancel" },
                { text: "Start over", style: "destructive", onPress: actions.onStartOver },
              ],
            )
          }
        />
      ) : null}
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
  useEffect(() => {
    void app.refreshAccount();
  }, [app]);
  return (
    <ProfileView
      m={{
        accountId: app.me ?? "",
        balance: app.wallet?.balance ?? null,
        network: NEAR_NETWORK,
        contractId: CONTRACT_ID,
        busy: app.busy,
        error: app.error,
        contractMismatch: app.contractMismatch,
        testRelay: app.testPlayers,
        payout: app.wallet?.payout ?? null,
        dossier: { rpcUrl: app.settings.rpcUrl, replayUrl: app.replaySite },
      }}
      actions={{
        onTopUp: () => void app.topUp(TOP_UP),
        onWithdraw: (to) => void app.withdraw(to),
        checkPayout: (to) => app.payoutProblem(to),
        onStartOver: () => void app.startOver(),
        onRefresh: () => app.refreshAccount(),
        onBack: () => app.openPage(null),
      }}
    />
  );
}

const styles = StyleSheet.create({
  who: { alignItems: "flex-start", gap: space.s, paddingTop: space.l, paddingBottom: space.s },
  account: { ...text.caption, color: color.mute },
  actions: { flexWrap: "nowrap" },
  payout: { gap: space.s },
  grow: { flex: 1 },
  fact: { minHeight: HIT, flexDirection: "row", alignItems: "center", gap: space.l },
  factValue: { flex: 1, alignItems: "flex-end" },
  value: { ...text.label, color: color.ink },
});
