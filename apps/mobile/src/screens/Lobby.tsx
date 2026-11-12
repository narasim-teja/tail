import { Share } from "react-native";
import { formatAmount } from "../game/hud";
import { useApp } from "../state/app";
import { Body, Button, ErrorLine, Figure, Gap, Label, Row, Screen, Title } from "../ui/kit";

const TOPUP = 10_000_000n; // 10 test USDC

/** Who is in, the stake, and the host's START. */
export function Lobby() {
  const app = useApp();
  const m = app.match;
  const chain = m?.chain;
  const me = app.me;
  const joined = !!chain?.players.some((p) => p.accountId === me);
  const isHost = m?.host === me;
  const open = m?.phase === "lobby" && chain?.phase === "lobby";
  const enough = !!chain && chain.players.length >= chain.minPlayers;
  const link = `tail://join/${app.matchId}`;

  return (
    <Screen>
      <Title>Lobby</Title>
      <Label>Code</Label>
      <Body>{app.matchId}</Body>
      <Row>
        <Button title="Share link" kind="plain" onPress={() => void Share.share({ message: link })} />
      </Row>
      {chain ? (
        <>
          <Row>
            <Figure label="Stake">{formatAmount(chain.stake)}</Figure>
            <Figure label="Minutes">{Math.round(chain.durationMs / 60_000)}</Figure>
            <Figure label="Balance">{app.balance === null ? "?" : formatAmount(app.balance)}</Figure>
          </Row>
          <Label>
            Players {chain.players.length} of {chain.minPlayers} needed
          </Label>
          {chain.players.map((p) => (
            <Body key={p.accountId}>
              {p.accountId}
              {p.accountId === m?.host ? "  host" : ""}
            </Body>
          ))}
        </>
      ) : (
        <Body muted>Loading the match.</Body>
      )}
      {m?.phase === "starting" ? <Body>Starting. The referee is dealing targets.</Body> : null}
      {m?.phase === "failed" ? <ErrorLine text={`Start failed: ${m.error ?? "unknown"}`} /> : null}
      <ErrorLine text={app.error} />
      <Gap />
      {open && !joined ? (
        <Button title={app.busy ?? "Join"} disabled={!!app.busy} onPress={() => void app.join()} />
      ) : null}
      {open && isHost && joined ? (
        <Button
          title={app.busy ?? "Start"}
          disabled={!!app.busy || !enough}
          hint={enough ? undefined : "Needs more players"}
          onPress={() => void app.start()}
        />
      ) : null}
      <Row>
        <Button title="Top up 10" kind="plain" disabled={!!app.busy} onPress={() => void app.topUp(TOPUP)} />
        {open && joined ? (
          <Button title="Leave" kind="plain" disabled={!!app.busy} onPress={() => void app.leave()} />
        ) : null}
        {!joined ? <Button title="Back" kind="plain" onPress={() => app.closeMatch()} /> : null}
      </Row>
    </Screen>
  );
}
