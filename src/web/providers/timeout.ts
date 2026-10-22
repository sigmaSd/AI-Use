/**
 * Every provider request gets a deadline covering the whole response, body
 * included. A connection that dies mid-response (the peer forgot it during a
 * system suspend) otherwise leaves the read pending forever, and the poll
 * loop, which waits on it before scheduling the next poll, stops for good.
 */
const REQUEST_TIMEOUT_MS = 30_000;

export function requestSignal(): AbortSignal {
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}
