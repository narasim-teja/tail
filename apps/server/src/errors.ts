// An error a route turns into a status code and a short, plain message for the caller.
export class HttpError extends Error {
  override name = "HttpError";
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 429 | 502 | 503,
    message: string,
    /** Fields sent beside `error`, for a refusal the caller can act on (e.g. which lobby is open). */
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
