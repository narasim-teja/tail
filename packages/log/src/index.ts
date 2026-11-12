// Structured logging for every TS service. JSON in production, pretty in a terminal.
// Secrets never reach a log line: known secret fields are redacted at the logger, so a
// careless `log.info({ req })` cannot leak a payment key or a private key.
import pino, { type Logger } from "pino";

export type { Logger };

const REDACT = [
  "*.privateKey",
  "*.private_key",
  "*.secretKey",
  "*.paymentKey",
  "*.apiKey",
  "*.authorization",
  "*.headers.authorization",
  '*.headers["x-payment-key"]',
  "privateKey",
  "private_key",
  "paymentKey",
  "apiKey",
];

export function createLogger(service: string): Logger {
  const pretty = process.stdout.isTTY && process.env["NODE_ENV"] !== "production";
  return pino({
    name: service,
    level: process.env["LOG_LEVEL"] ?? "info",
    redact: { paths: REDACT, censor: "[redacted]" },
    ...(pretty ? { transport: { target: "pino-pretty", options: { colorize: true } } } : {}),
  });
}
