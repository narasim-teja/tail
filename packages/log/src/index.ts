// Structured logging for every TS service. JSON in production, pretty in a terminal.
// Secrets never reach a log line: known secret fields are redacted at the logger, so a
// careless `log.info({ req })` cannot leak a payment key or a private key.
import pino, { type DestinationStream, type Logger } from "pino";

export type { Logger };

/**
 * Field names that hold a secret anywhere in the code base: config fields (config.ts), the keys
 * ghosts and phones hold, request headers, and the environment variables themselves.
 */
const SECRET_KEYS = [
  "privateKey",
  "private_key",
  "secretKey",
  "secret_key",
  "paymentKey",
  "payment_key",
  "apiKey",
  "api_key",
  "authorization",
  "password",
  "relayPrivateKey",
  "refereePaymentKey",
  "outlayerPaymentKey",
  "nearSeed",
  "near_seed",
  "seed",
  "boxSk",
  "box_sk",
  "attestSk",
  "attest_sk",
  "NEAR_RELAY_PRIVATE_KEY",
  "REFEREE_PAYMENT_KEY",
  "OUTLAYER_PAYMENT_KEY",
  "x-payment-key",
];

/**
 * pino's paths match one level per `*`, so each name is covered at the top, one and two levels
 * down (`{config}`, `{req: {headers}}`); deeper objects should not carry secrets into a log call.
 */
export const REDACT = SECRET_KEYS.flatMap((k) => {
  const key = /^[A-Za-z_$][\w$]*$/.test(k) ? k : `["${k}"]`;
  const dot = key.startsWith("[") ? "" : ".";
  return [key, `*${dot}${key}`, `*.*${dot}${key}`];
});

/** `dest` is for tests that read what was written; services log to stdout. */
export function createLogger(service: string, dest?: DestinationStream): Logger {
  const pretty = !dest && process.stdout.isTTY && process.env["NODE_ENV"] !== "production";
  const opts = {
    name: service,
    level: process.env["LOG_LEVEL"] ?? "info",
    redact: { paths: REDACT, censor: "[redacted]" },
    ...(pretty ? { transport: { target: "pino-pretty", options: { colorize: true } } } : {}),
  };
  return dest ? pino(opts, dest) : pino(opts);
}
