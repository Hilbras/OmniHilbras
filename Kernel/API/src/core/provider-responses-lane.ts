/**
 * The endpoints that serve part of their catalog through the OpenAI **Responses** API.
 *
 * ## The measurement
 *
 * AgentRouter (`https://agentrouter.org/v1`) answers a model it does not serve on `/v1/chat/completions` by
 * naming the other endpoint — a real turn, 2026-11-16. The turn was reported as
 * `HTTP 502 provider=agentrouter`, which is **this gateway's** status for a provider failure rather than the
 * relay's, and the relay's own body was:
 *
 * ```
 * {"error":{"message":"模型 gpt-6-astra 不支持 /v1/chat/completions 接口,请改用 /v1/responses(OpenAI
 *  Responses API). Model gpt-6-astra does not support /v1/chat/completions, please use /v1/responses
 *  instead. (request id: ...)"}}
 * ```
 *
 * Which status the relay itself sent is **not known** and not recoverable here: a deliberately bogus key is
 * judged before any model routing, so `/v1/chat/completions` answers `401 无效的令牌` for every model
 * including one that does not exist (measured 2026-11-16). The lane is therefore selected by the relay's
 * **sentence** and only excluded on four statuses (401, 403, 408, 429) — an exclusion list rather than a list
 * of accepted statuses, so an envelope nobody has seen yet is retried instead of ignored. See
 * `laneRefusalExcludedStatuses` in the SDK's `lib/responses-lane.ts`.
 *
 * The credential was accepted — that gate was the client identity, and it is
 * `provider-client-identity.ts` — so this is the **model** refusing one interface rather than the
 * connection being wrong. Other models on the same connection (`glm`, `deepseek`) answer
 * `/v1/chat/completions` happily, which is why this is a lane and not a provider-wide switch.
 *
 * ## Why the path is named here rather than derived
 *
 * A third party's URL layout is not something this gateway infers, and the SDK refuses the same inference
 * for `embeddings`: an OpenAI-shaped base URL is no evidence that `/responses` exists on it. A provider
 * absent from the table gets no `responsesPath`, so it has no second lane and keeps its existing behaviour
 * — including its refusals, which is the difference between "this endpoint has another lane" and "this
 * gateway retries things".
 */
const RESPONSES_LANES: Readonly<Record<string, string>> = {
  agentrouter: '/responses',
};

/**
 * The Responses path this provider serves, or `undefined` when it serves none.
 *
 * `undefined` rather than a default: the caller passes the result into an adapter only when there is one,
 * so "this provider has no Responses lane" is a state the type carries rather than an empty string the
 * adapter would have to interpret.
 */
export function providerResponsesPath(providerId: string): string | undefined {
  return RESPONSES_LANES[providerId];
}
