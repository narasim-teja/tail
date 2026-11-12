// An error a route turns into a status code and a short, plain message for the caller.
export class HttpError extends Error {
  override name = "HttpError";
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 502 | 503,
    message: string,
  ) {
    super(message);
  }
}
