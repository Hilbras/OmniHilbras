// Helpers for the request-details tab.

// A filter change invalidates the current page: after narrowing the filter the
// matching rows live on page 1 of the new result set, so the table must not
// stay on the page it was on.
export function resetPageForFilterChange(pagination) {
  return { ...pagination, page: 1 };
}

// The API replaces every stored request/response body with {redacted: true},
// so a payload section is only worth rendering when the body is still there.
export function hasRawPayload(payload) {
  return Boolean(payload) && payload.redacted !== true;
}
