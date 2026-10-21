import { describe, expect, it } from "vitest";
import {
  buildLoadingState,
  selectQuotaRefreshTargets,
} from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

// Claude's usage endpoint rate-limits, so the quota tracker polls it only
// every Nth tick. The connections left out of a refresh must not be marked as
// loading either — their card used to spin forever and keep its buttons
// disabled.

describe("quota refresh targets", () => {
  const connections = [
    { id: "codex-1", provider: "codex" },
    { id: "claude-1", provider: "claude" },
    { id: "kiro-1", provider: "kiro" },
  ];

  it("polls every provider but Claude on a normal tick", () => {
    const targets = selectQuotaRefreshTargets(connections, {
      tick: 1,
      claudeEvery: 10,
    });
    expect(targets.map((c) => c.id)).toEqual(["codex-1", "kiro-1"]);
  });

  it("polls Claude on every Nth tick", () => {
    const targets = selectQuotaRefreshTargets(connections, {
      tick: 10,
      claudeEvery: 10,
    });
    expect(targets.map((c) => c.id)).toEqual([
      "codex-1",
      "claude-1",
      "kiro-1",
    ]);
  });

  it("polls every provider when the refresh is forced", () => {
    const targets = selectQuotaRefreshTargets(connections, {
      force: true,
      tick: 1,
      claudeEvery: 10,
    });
    expect(targets).toHaveLength(connections.length);
  });

  it("leaves a throttled connection out of the loading state", () => {
    const targets = selectQuotaRefreshTargets(connections, {
      tick: 1,
      claudeEvery: 10,
    });
    const loading = buildLoadingState(targets);
    expect(loading["claude-1"]).toBeUndefined();
    expect(loading["codex-1"]).toBe(true);
    expect(loading["kiro-1"]).toBe(true);
  });
});
