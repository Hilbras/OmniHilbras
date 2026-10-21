import { describe, expect, it } from "vitest";
import {
  hasRawPayload,
  resetPageForFilterChange,
} from "@/app/(dashboard)/dashboard/usage/components/requestDetails.js";

describe("request details — filter change resets the page", () => {
  it("goes back to page 1", () => {
    const pagination = { page: 3, pageSize: 20, totalItems: 95, totalPages: 5 };
    expect(resetPageForFilterChange(pagination)).toEqual({
      page: 1,
      pageSize: 20,
      totalItems: 95,
      totalPages: 5,
    });
  });

  it("keeps the other pagination fields", () => {
    const next = resetPageForFilterChange({
      page: 4,
      pageSize: 50,
      totalItems: 200,
      totalPages: 4,
    });
    expect(next.pageSize).toBe(50);
    expect(next.totalItems).toBe(200);
    expect(next.totalPages).toBe(4);
  });
});

describe("request details — redacted payloads", () => {
  it("treats the API placeholder as no payload", () => {
    expect(hasRawPayload({ redacted: true })).toBe(false);
  });

  it("treats a missing payload as no payload", () => {
    expect(hasRawPayload(undefined)).toBe(false);
    expect(hasRawPayload(null)).toBe(false);
  });

  it("keeps a payload the API did not redact", () => {
    expect(hasRawPayload({ model: "gpt-5" })).toBe(true);
    expect(hasRawPayload("raw body")).toBe(true);
  });
});
