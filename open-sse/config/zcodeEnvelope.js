// ZCode upstream response envelope constants.
//
// The gateway reports business failures (quota, rate limits, auth) with a bare
// JSON envelope that can ride on HTTP 200. The envelope is detected in the
// leading bytes of the response so the turn fails with the real reason
// instead of returning an empty, successful-looking answer.
export const ZCODE_ENVELOPE = {
  // Upper bound of bytes buffered while looking for the envelope. A healthy
  // SSE turn yields its first JSON object in the first chunk, so the stream
  // is only held back until one object can be parsed.
  peekLimitBytes: 8192,
};
