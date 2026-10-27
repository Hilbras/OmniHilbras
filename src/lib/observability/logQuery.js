// Shared by the /api/observability routes.

// The stored details include full request bodies (user prompts, tool calls)
// and provider responses. Same rule as /api/usage/request-details: keep the
// metadata (model, tokens, latency, status) but never hand out message content.
const PAYLOAD_KEYS = ["request", "providerRequest", "providerResponse", "response"];

export function redactPayloads(detail) {
  if (!detail) return detail;
  const redacted = { ...detail };
  for (const key of PAYLOAD_KEYS) {
    if (redacted[key] !== undefined) redacted[key] = { redacted: true };
  }
  return redacted;
}

const FILTER_KEYS = ["provider", "model", "connectionId", "status", "startDate", "endDate"];

function isValidDate(value) {
  return !Number.isNaN(new Date(value).getTime());
}

// Reads the filter fields from URLSearchParams or a plain object.
// Returns { filter } or { error } for a 400 response.
export function parseLogFilter(source) {
  const get = (k) => (typeof source.get === "function" ? source.get(k) : source[k]);
  const filter = {};
  for (const key of FILTER_KEYS) {
    const value = get(key);
    if (value === null || value === undefined || value === "") continue;
    if ((key === "startDate" || key === "endDate") && !isValidDate(value)) {
      return { error: `${key} is not a valid date` };
    }
    filter[key] = String(value);
  }
  return { filter };
}

const CSV_COLUMNS = [
  ["timestamp", (d) => d.timestamp],
  ["id", (d) => d.id],
  ["provider", (d) => d.provider],
  ["model", (d) => d.model],
  ["connectionId", (d) => d.connectionId],
  ["status", (d) => d.status],
  ["latencyTotalMs", (d) => d.latency?.total],
  ["latencyTtftMs", (d) => d.latency?.ttft],
  ["promptTokens", (d) => d.tokens?.prompt_tokens ?? d.tokens?.input_tokens],
  ["completionTokens", (d) => d.tokens?.completion_tokens ?? d.tokens?.output_tokens],
];

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

export function toCsv(details) {
  const header = CSV_COLUMNS.map(([name]) => name).join(",");
  const rows = details.map((d) => CSV_COLUMNS.map(([, pick]) => csvCell(pick(d))).join(","));
  return [header, ...rows].join("\n") + "\n";
}

export function toJsonl(details) {
  return details.map((d) => JSON.stringify(d)).join("\n") + (details.length ? "\n" : "");
}
