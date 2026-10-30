"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Card, Button, Input, Modal, Toggle, ConfirmModal } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { getCurrentLocale, onLocaleChange } from "@/i18n/runtime";
import {
  WENYAN_LOCALES,
  CAVEMAN_LEVELS,
  PONYTAIL_LEVELS,
} from "../endpoint/endpointConstants";

export default function TokenSaverClient() {
  const [rtkEnabled, setRtkEnabledState] = useState(true);
  const [headroomEnabled, setHeadroomEnabled] = useState(false);
  const [headroomUrl, setHeadroomUrl] = useState("http://localhost:8787");
  const [headroomTimeoutMs, setHeadroomTimeoutMs] = useState(3000);
  const [headroomStatus, setHeadroomStatus] = useState({
    installed: false,
    running: false,
    python: null,
    loading: true,
  });
  const [showHeadroomInstallModal, setShowHeadroomInstallModal] =
    useState(false);
  const [headroomActionLoading, setHeadroomActionLoading] = useState(false);
  const [headroomActionError, setHeadroomActionError] = useState("");
  const [headroomExtras, setHeadroomExtras] = useState({
    version: null,
    extras: { code: false, ml: false },
    available: ["code", "ml"],
    loading: false,
  });
  const [pendingExtras, setPendingExtras] = useState([]);
  const [extrasActionLoading, setExtrasActionLoading] = useState(false);
  const [extrasActionError, setExtrasActionError] = useState("");
  const [removingExtra, setRemovingExtra] = useState(null);
  const [installLog, setInstallLog] = useState("");
  const [extrasConfirm, setExtrasConfirm] = useState(null);
  const [codeAware, setCodeAware] = useState(false);
  const [kompress, setKompress] = useState(true);
  const [restartingProxy, setRestartingProxy] = useState(false);
  const logPollRef = useRef(null);
  const [cavemanEnabled, setCavemanEnabled] = useState(false);
  const [cavemanLevel, setCavemanLevel] = useState("full");
  const [ponytailEnabled, setPonytailEnabled] = useState(false);
  const [ponytailLevel, setPonytailLevel] = useState("full");
  const [pxpipeEnabled, setPxpipeEnabled] = useState(false);
  const [pxpipeMinChars, setPxpipeMinChars] = useState(25000);
  const [headroomCompressUserMessages, setHeadroomCompressUserMessages] =
    useState(false);
  const [historyTrimEnabled, setHistoryTrimEnabled] = useState(false);
  const [historyTrimThresholdTokens, setHistoryTrimThresholdTokens] =
    useState(60000);
  const [historyTrimKeepTurns, setHistoryTrimKeepTurns] = useState(8);
  const [maxOutputTokensCap, setMaxOutputTokensCap] = useState(0);
  const [thinkingBudgetCap, setThinkingBudgetCap] = useState(0);
  const [saverStats, setSaverStats] = useState(null);
  const [saverStatsPeriod, setSaverStatsPeriod] = useState("7d");
  const [settingsError, setSettingsError] = useState("");
  const [pxpipeStatus, setPxpipeStatus] = useState({
    installed: false,
    installing: false,
    running: false,
    version: null,
    loading: true,
  });
  const [pxpipeHealth, setPxpipeHealth] = useState(null);
  const [showPxpipeModal, setShowPxpipeModal] = useState(false);
  const [pxpipeActionLoading, setPxpipeActionLoading] = useState(false);
  const [pxpipeActionError, setPxpipeActionError] = useState("");
  const [locale, setLocale] = useState("en");

  const { copied, copy } = useCopyToClipboard();

  useEffect(() => {
    setLocale(getCurrentLocale());
    return onLocaleChange(() => setLocale(getCurrentLocale()));
  }, []);

  const isWenyanLocale = WENYAN_LOCALES.includes(locale);
  const visibleCavemanLevels = isWenyanLocale
    ? CAVEMAN_LEVELS
    : CAVEMAN_LEVELS.filter((lvl) => !lvl.wenyan);

  useEffect(() => {
    const current = CAVEMAN_LEVELS.find((lvl) => lvl.id === cavemanLevel);
    if (current?.wenyan && !isWenyanLocale) {
      setCavemanLevel("ultra");
      patchSetting({ cavemanLevel: "ultra" });
    }
  }, [isWenyanLocale, cavemanLevel]);

  /**
   * Persist settings and report whether the server took them.
   *
   * The old version fired and forgot: it never looked at res.ok, so a 401 or a
   * 500 left the toggle showing a value the server never stored — and the page
   * then disagreed with itself after a reload. Callers must now only commit
   * their local state when this resolves true.
   */
  const patchSetting = async (patch) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        setSettingsError(
          `Could not save ${Object.keys(patch).join(", ")} (HTTP ${res.status}).`,
        );
        return false;
      }
      setSettingsError("");
      return true;
    } catch (error) {
      setSettingsError(
        `Could not save ${Object.keys(patch).join(", ")}: ${error.message}`,
      );
      return false;
    }
  };

  const handleRtkEnabled = async (value) => {
    if (await patchSetting({ rtkEnabled: value })) setRtkEnabledState(value);
  };

  const handleCavemanEnabled = async (value) => {
    if (await patchSetting({ cavemanEnabled: value })) setCavemanEnabled(value);
  };

  const handleHeadroomEnabled = async (value) => {
    const nextUrl = headroomUrl.trim() || "http://localhost:8787";
    if (await patchSetting({ headroomEnabled: value, headroomUrl: nextUrl })) {
      setHeadroomUrl(nextUrl);
      setHeadroomEnabled(value);
    }
  };

  const handleHeadroomUrlBlur = async () => {
    const next = headroomUrl.trim() || "http://localhost:8787";
    setHeadroomUrl(next);
    await patchSetting({ headroomUrl: next });
    refreshHeadroomStatus();
  };

  const refreshHeadroomStatus = useCallback(async () => {
    setHeadroomStatus((s) => ({ ...s, loading: true }));
    try {
      const res = await fetch("/api/headroom/status", {
        headers: { "Cache-Control": "no-store" },
      });
      const data = await res.json();
      setHeadroomStatus({ ...data, loading: false });
      if (!data?.installed) {
        setHeadroomExtras({
          version: null,
          extras: { code: false, ml: false },
          available: ["code", "ml"],
          loading: false,
        });
        setPendingExtras([]);
        return;
      }
      try {
        const er = await fetch("/api/headroom/extras", {
          headers: { "Cache-Control": "no-store" },
        });
        if (!er.ok) throw new Error("extras status failed");
        const ed = await er.json();
        setHeadroomExtras((s) => ({
          ...s,
          version: ed.version ?? null,
          extras: ed.extras || { code: false, ml: false },
          available: ed.available || ["code", "ml"],
          loading: false,
        }));
        setPendingExtras([]);
      } catch {
        setHeadroomExtras({
          version: null,
          extras: { code: false, ml: false },
          available: ["code", "ml"],
          loading: false,
        });
        setPendingExtras([]);
      }
    } catch {
      setHeadroomStatus({
        installed: false,
        running: false,
        python: null,
        loading: false,
      });
      setHeadroomExtras({
        version: null,
        extras: { code: false, ml: false },
        available: ["code", "ml"],
        loading: false,
      });
      setPendingExtras([]);
    }
  }, []);

  const handleHeadroomStart = useCallback(async () => {
    setHeadroomActionError("");
    setHeadroomActionLoading(true);
    try {
      const res = await fetch("/api/headroom/start", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to start proxy");
      await refreshHeadroomStatus();
    } catch (e) {
      setHeadroomActionError(e.message);
    } finally {
      setHeadroomActionLoading(false);
    }
  }, [refreshHeadroomStatus]);

  const handleHeadroomStop = useCallback(async () => {
    setHeadroomActionError("");
    setHeadroomActionLoading(true);
    try {
      const res = await fetch("/api/headroom/stop", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to stop proxy");
      await refreshHeadroomStatus();
    } catch (e) {
      setHeadroomActionError(e.message);
    } finally {
      setHeadroomActionLoading(false);
    }
  }, [refreshHeadroomStatus]);

  const togglePendingExtra = (extra) => {
    setPendingExtras((cur) =>
      cur.includes(extra) ? cur.filter((e) => e !== extra) : [...cur, extra]
    );
  };

  // Poll the install log tail while a pip install/uninstall is running.
  const startLogPolling = useCallback(() => {
    setInstallLog("");
    if (logPollRef.current) clearInterval(logPollRef.current);
    const tick = async () => {
      try {
        const r = await fetch("/api/headroom/extras?log=1", {
          headers: { "Cache-Control": "no-store" },
        });
        const d = await r.json().catch(() => ({}));
        if (typeof d.log === "string") setInstallLog(d.log);
      } catch { /* ignore transient poll errors */ }
    };
    tick();
    logPollRef.current = setInterval(tick, 1500);
  }, []);

  const stopLogPolling = useCallback(() => {
    if (logPollRef.current) {
      clearInterval(logPollRef.current);
      logPollRef.current = null;
    }
  }, []);

  useEffect(() => () => stopLogPolling(), [stopLogPolling]);

  const installExtrasConfirmed = useCallback(async () => {
    if (pendingExtras.length === 0) return;
    setExtrasActionLoading(true);
    setExtrasActionError("");
    startLogPolling();
    try {
      const res = await fetch("/api/headroom/extras", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extras: pendingExtras }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Install failed");
      setHeadroomExtras((s) => ({
        ...s,
        version: data.version ?? s.version,
        extras: data.extras || s.extras,
      }));
      setPendingExtras([]);
    } catch (e) {
      setExtrasActionError(e.message);
    } finally {
      stopLogPolling();
      setExtrasActionLoading(false);
    }
  }, [pendingExtras, startLogPolling, stopLogPolling]);

  const removeExtraConfirmed = useCallback(async (extra) => {
    setRemovingExtra(extra);
    setExtrasActionError("");
    startLogPolling();
    try {
      const res = await fetch("/api/headroom/extras", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extras: [extra] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Remove failed");
      setHeadroomExtras((s) => ({
        ...s,
        version: data.version ?? s.version,
        extras: data.extras || s.extras,
      }));
    } catch (e) {
      setExtrasActionError(e.message);
    } finally {
      stopLogPolling();
      setRemovingExtra(null);
    }
  }, [startLogPolling, stopLogPolling]);

  const handleInstallExtras = useCallback(() => {
    if (pendingExtras.length === 0) return;
    // Warn about the heavy ~1GB torch download before installing [ml].
    if (pendingExtras.includes("ml")) {
      setExtrasConfirm({
        title: "Install [ml]",
        message: "[ml] downloads ~1 GB (torch + huggingface-hub). Continue?",
        confirmText: "Install",
        variant: "primary",
        onConfirm: installExtrasConfirmed,
      });
      return;
    }
    installExtrasConfirmed();
  }, [pendingExtras, installExtrasConfirmed]);

  const handleRemoveExtra = useCallback((extra) => {
    setExtrasConfirm({
      title: `Remove [${extra}]`,
      message: `Remove [${extra}] and its packages?`,
      confirmText: "Remove",
      variant: "danger",
      onConfirm: () => removeExtraConfirmed(extra),
    });
  }, [removeExtraConfirmed]);

  // Toggle an extra's active state (persist setting), then restart the proxy so
  // the new --code-aware / --disable-kompress flags take effect.
  const toggleExtraActive = useCallback(async (extra, value) => {
    setExtrasActionError("");
    if (extra === "code") setCodeAware(value);
    if (extra === "ml") setKompress(value);
    const key = extra === "code" ? "headroomCodeAware" : "headroomKompress";
    await patchSetting({ [key]: value });
    if (!headroomStatus.running) return;
    setRestartingProxy(true);
    try {
      const res = await fetch("/api/headroom/restart", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Restart failed");
      await refreshHeadroomStatus();
    } catch (e) {
      setExtrasActionError(e.message);
    } finally {
      setRestartingProxy(false);
    }
  }, [headroomStatus.running, refreshHeadroomStatus]);

  const handleCavemanLevel = async (level) => {
    if (await patchSetting({ cavemanLevel: level })) setCavemanLevel(level);
  };

  const handlePonytailEnabled = async (value) => {
    if (await patchSetting({ ponytailEnabled: value })) setPonytailEnabled(value);
  };

  const handlePonytailLevel = async (level) => {
    if (await patchSetting({ ponytailLevel: level })) setPonytailLevel(level);
  };

  const handleHeadroomCompressUserMessages = async (value) => {
    if (await patchSetting({ headroomCompressUserMessages: value })) {
      setHeadroomCompressUserMessages(value);
    }
  };

  const handleHistoryTrimEnabled = async (value) => {
    if (await patchSetting({ historyTrimEnabled: value })) {
      setHistoryTrimEnabled(value);
    }
  };

  const handleHistoryTrimThresholdBlur = async () => {
    const next = Math.max(1000, Number(historyTrimThresholdTokens) || 60000);
    setHistoryTrimThresholdTokens(next);
    await patchSetting({ historyTrimThresholdTokens: next });
  };

  const handleHistoryTrimKeepTurnsBlur = async () => {
    const next = Math.max(0, Number(historyTrimKeepTurns) || 8);
    setHistoryTrimKeepTurns(next);
    await patchSetting({ historyTrimKeepTurns: next });
  };

  const handleMaxOutputCapBlur = async () => {
    const next = Math.max(0, Number(maxOutputTokensCap) || 0);
    setMaxOutputTokensCap(next);
    await patchSetting({ maxOutputTokensCap: next });
  };

  const handleThinkingBudgetCapBlur = async () => {
    const next = Math.max(0, Number(thinkingBudgetCap) || 0);
    setThinkingBudgetCap(next);
    await patchSetting({ thinkingBudgetCap: next });
  };

  const refreshPxpipeStatus = useCallback(async () => {
    setPxpipeStatus((s) => ({ ...s, loading: true }));
    try {
      const res = await fetch("/api/pxpipe/status", {
        headers: { "Cache-Control": "no-store" },
      });
      const data = await res.json();
      setPxpipeStatus({ ...data, loading: false });
      if (typeof data.minChars === "number") setPxpipeMinChars(data.minChars);
    } catch {
      setPxpipeStatus({ installed: false, installing: false, running: false, version: null, loading: false });
    }
  }, []);

  const runPxpipeHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/pxpipe/health", { method: "POST" });
      setPxpipeHealth(await res.json());
    } catch (e) {
      setPxpipeHealth({ healthy: false, checks: [], error: e.message });
    }
  }, []);

  const pxpipeAction = useCallback(
    async (endpoint) => {
      setPxpipeActionError("");
      setPxpipeActionLoading(true);
      try {
        const res = await fetch(`/api/pxpipe/${endpoint}`, { method: "POST" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `PXPIPE ${endpoint} failed`);
        await refreshPxpipeStatus();
        await runPxpipeHealth();
      } catch (e) {
        setPxpipeActionError(e.message);
      } finally {
        setPxpipeActionLoading(false);
      }
    },
    [refreshPxpipeStatus, runPxpipeHealth]
  );

  const handlePxpipeEnabled = async (value) => {
    if (await patchSetting({ pxpipeEnabled: value })) setPxpipeEnabled(value);
  };

  const handlePxpipeMinCharsBlur = () => {
    const next = Math.max(0, Number(pxpipeMinChars) || 25000);
    setPxpipeMinChars(next);
    patchSetting({ pxpipeMinChars: next });
  };

  const handleHeadroomTimeoutBlur = () => {
    const raw = Math.round(Number(headroomTimeoutMs));
    const next = Number.isFinite(raw) && raw > 0 ? raw : 3000;
    setHeadroomTimeoutMs(next);
    patchSetting({ headroomTimeoutMs: next });
  };

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const res = await fetch("/api/settings");
        if (res.ok) {
          const data = await res.json();
          setRtkEnabledState(data.rtkEnabled !== false);
          setHeadroomEnabled(!!data.headroomEnabled);
          setHeadroomUrl(data.headroomUrl || "http://localhost:8787");
          if (typeof data.headroomTimeoutMs === "number") setHeadroomTimeoutMs(data.headroomTimeoutMs);
          setCodeAware(data.headroomCodeAware === true);
          setKompress(data.headroomKompress !== false);
          setCavemanEnabled(!!data.cavemanEnabled);
          setCavemanLevel(data.cavemanLevel || "full");
          setPonytailEnabled(!!data.ponytailEnabled);
          setPonytailLevel(data.ponytailLevel || "full");
          setPxpipeEnabled(!!data.pxpipeEnabled);
          if (typeof data.pxpipeMinChars === "number") setPxpipeMinChars(data.pxpipeMinChars);
          setHeadroomCompressUserMessages(!!data.headroomCompressUserMessages);
          setHistoryTrimEnabled(!!data.historyTrimEnabled);
          if (typeof data.historyTrimThresholdTokens === "number") {
            setHistoryTrimThresholdTokens(data.historyTrimThresholdTokens);
          }
          if (typeof data.historyTrimKeepTurns === "number") {
            setHistoryTrimKeepTurns(data.historyTrimKeepTurns);
          }
          if (typeof data.maxOutputTokensCap === "number") setMaxOutputTokensCap(data.maxOutputTokensCap);
          if (typeof data.thinkingBudgetCap === "number") setThinkingBudgetCap(data.thinkingBudgetCap);
          refreshHeadroomStatus();
          // PRD: run the PXPIPE health check automatically when the page opens
          refreshPxpipeStatus().then(runPxpipeHealth);
        }
      } catch {}
    };
    loadSettings();
  }, [refreshHeadroomStatus, refreshPxpipeStatus, runPxpipeHealth]);

  const refreshSaverStats = useCallback(async (period) => {
    try {
      const res = await fetch(`/api/token-saver/stats?period=${period}`, {
        headers: { "Cache-Control": "no-store" },
      });
      if (res.ok) setSaverStats(await res.json());
    } catch {
      // Stats are informational — a failure must not break the page.
    }
  }, []);

  useEffect(() => {
    // Deferred one tick so the fetch's setState lands outside the effect body.
    const id = setTimeout(() => refreshSaverStats(saverStatsPeriod), 0);
    return () => clearTimeout(id);
  }, [refreshSaverStats, saverStatsPeriod]);

  const formatBytes = (n) => {
    const v = Number(n) || 0;
    if (v >= 1048576) return `${(v / 1048576).toFixed(1)} MB`;
    if (v >= 1024) return `${(v / 1024).toFixed(1)} KB`;
    return `${v} B`;
  };

  const formatTokens = (n) => {
    const v = Number(n) || 0;
    if (v >= 1000000) return `${(v / 1000000).toFixed(2)}M`;
    if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
    return String(v);
  };

  const statsEmpty = !saverStats || (saverStats.requestsWithTelemetry || 0) === 0;

  const headroomRunning = !!headroomStatus.running;
  const headroomStatusLabel = headroomStatus.loading
    ? "Checking…"
    : headroomRunning
      ? "Running"
      : headroomStatus.localUrl !== false && !headroomStatus.installed
        ? "Not installed"
        : headroomStatus.localUrl !== false
          ? "Stopped"
          : "External";
  const headroomLocalUrl = headroomStatus.localUrl !== false;
  const headroomCanStart = !!headroomStatus.canStart;
  const headroomManaged =
    headroomLocalUrl && !!headroomStatus.managedPid;

  const pxpipeHealthy = pxpipeHealth?.healthy === true;
  const pxpipeStatusLabel = pxpipeStatus.loading
    ? "Checking…"
    : pxpipeStatus.installing
      ? "Installing…"
      : !pxpipeStatus.installed
        ? "Not installed"
        : pxpipeHealthy
          ? "Healthy"
          : pxpipeStatus.running
            ? "Running"
            : "Stopped";
  const pxpipeChipClass =
    pxpipeHealthy || pxpipeStatus.running
      ? "bg-success/15 text-success"
      : "bg-warning/15 text-warning";

  return (
    <div className="space-y-6 p-6">
      {settingsError && (
        <div className="rounded border border-warning/40 bg-warning/10 px-4 py-2 text-sm text-warning">
          {settingsError}
        </div>
      )}

      <Card id="savings">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-3">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">
              savings
            </span>
            Savings
          </h2>
          <div className="flex items-center gap-1.5">
            {["today", "7d", "30d", "all"].map((p) => (
              <button
                key={p}
                onClick={() => setSaverStatsPeriod(p)}
                className={`px-3 py-1.5 rounded text-xs font-medium border transition-colors ${
                  saverStatsPeriod === p
                    ? "bg-primary text-white border-primary"
                    : "bg-transparent border-border text-text-muted hover:bg-surface-2"
                }`}
              >
                {p === "all" ? "All" : p === "today" ? "Today" : p}
              </button>
            ))}
            <button
              onClick={() => refreshSaverStats(saverStatsPeriod)}
              className="ml-1 text-xs text-primary underline hover:opacity-80"
            >
              Refresh
            </button>
          </div>
        </div>

        {statsEmpty ? (
          <p className="text-sm text-text-muted py-2">
            No measurements yet. Savings are recorded per request — send a
            request through the gateway and they appear here.
            {saverStats?.requests > 0 && (
              <>
                {" "}
                ({saverStats.requests} request
                {saverStats.requests === 1 ? "" : "s"} in this period predate
                measurement.)
              </>
            )}
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 py-2">
              <div>
                <p className="text-xs text-text-muted">Saved</p>
                <p className="text-2xl font-semibold">
                  {formatBytes(saverStats.totalBytesSaved)}
                </p>
                <p className="text-xs text-text-muted">
                  ≈ {formatTokens(saverStats.totalTokensSaved)} tokens
                </p>
              </div>
              <div>
                <p className="text-xs text-text-muted">Est. cost avoided</p>
                <p className="text-2xl font-semibold">
                  ${(saverStats.estimatedCostAvoided || 0).toFixed(4)}
                </p>
                <p className="text-xs text-text-muted">at this period&apos;s mix</p>
              </div>
              <div>
                <p className="text-xs text-text-muted">Requests saving</p>
                <p className="text-2xl font-semibold">
                  {saverStats.requestsWithSavings}
                  <span className="text-sm text-text-muted font-normal">
                    {" "}
                    / {saverStats.requestsWithTelemetry}
                  </span>
                </p>
                <p className="text-xs text-text-muted">measured requests</p>
              </div>
              <div>
                <p className="text-xs text-text-muted">Cache hit rate</p>
                <p className="text-2xl font-semibold">
                  {saverStats.cacheHitRate == null
                    ? "—"
                    : `${(saverStats.cacheHitRate * 100).toFixed(0)}%`}
                </p>
                <p className="text-xs text-text-muted">
                  {formatTokens(saverStats.cache?.read)} read ·{" "}
                  {formatTokens(saverStats.cache?.create)} written
                </p>
              </div>
            </div>

            {saverStats.savers?.length > 0 && (
              <div className="mt-4 pt-4 border-t border-border space-y-2">
                {saverStats.savers.map((s) => {
                  const max = saverStats.savers[0].bytesSaved || 1;
                  const pct = Math.max(2, Math.round((s.bytesSaved / max) * 100));
                  return (
                    <div key={s.id}>
                      <div className="flex items-center justify-between text-sm">
                        <span className="font-medium capitalize">
                          {s.id === "historyTrim" ? "History trim" : s.id}
                        </span>
                        <span className="text-text-muted">
                          {formatBytes(s.bytesSaved)} · {s.requests} req
                          {s.requestsWithSavings === 0 && (
                            <span className="text-warning"> · ran, no match</span>
                          )}
                        </span>
                      </div>
                      <div className="h-1.5 rounded bg-surface-2 mt-1 overflow-hidden">
                        <div
                          className="h-full bg-primary"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      {Object.keys(s.details || {}).length > 0 && (
                        <p className="text-xs text-text-muted mt-0.5">
                          {Object.entries(s.details)
                            .sort((a, b) => b[1] - a[1])
                            .slice(0, 5)
                            .map(([k, v]) => `${k}×${v}`)
                            .join(" · ")}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {saverStats.byProvider?.length > 0 && (
              <div className="mt-4 pt-4 border-t border-border">
                <p className="text-xs text-text-muted mb-2">By provider</p>
                <div className="space-y-1">
                  {saverStats.byProvider.slice(0, 8).map((p) => (
                    <div
                      key={p.provider}
                      className="flex items-center justify-between text-sm"
                    >
                      <span>{p.provider}</span>
                      <span className="text-text-muted">
                        {formatBytes(p.bytesSaved)} · {p.requests} req
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </Card>

      <Card id="rtk">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">
              bolt
            </span>
            Token Saver
          </h2>
        </div>
        <div className="flex items-center justify-between pt-2 pb-4 border-b border-border gap-4">
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              Compress tool output{" "}
              <a
                href="https://github.com/rtk-ai/rtk"
                target="_blank"
                rel="noreferrer"
                className="text-xs font-normal text-primary underline hover:opacity-80"
              >
                (RTK)
              </a>
            </p>
            <p className="text-sm text-text-muted">
              git/grep/ls/tree/logs → 60-90% fewer input tokens
            </p>
          </div>
          <Toggle
            checked={rtkEnabled}
            onChange={() => handleRtkEnabled(!rtkEnabled)}
          />
        </div>
        <div className="flex items-center justify-between py-4 gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <p className="font-medium">
                Compress context{" "}
                <a
                  href="https://github.com/chopratejas/headroom"
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-normal text-primary underline hover:opacity-80"
                >
                  (Headroom)
                </a>
              </p>
              <span
                className={`text-xs px-2 py-0.5 rounded ${headroomRunning ? "bg-success/15 text-success" : "bg-warning/15 text-warning"}`}
              >
                {headroomStatusLabel}
              </span>
              <button
                type="button"
                onClick={() => setShowHeadroomInstallModal(true)}
                className="text-xs text-primary underline hover:opacity-80"
              >
                {headroomRunning ? "Manage" : "Setup"}
              </button>
            </div>
            <p className="text-sm text-text-muted mt-1">
              Compress prompts via /v1/compress before routing to the model
            </p>
          </div>
          <Toggle
            checked={headroomEnabled}
            onChange={() => handleHeadroomEnabled(!headroomEnabled)}
          />
        </div>
        {headroomStatus.installed && (
          <div className="mb-3 ml-1 pl-3 pb-4 border-l-2 border-border">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-text-muted">
                Compression extras
                {headroomExtras.version ? ` · v${headroomExtras.version}` : ""}:
              </span>
              {headroomExtras.available.map((extra) => {
                const installed = !!headroomExtras.extras[extra];
                const pending = pendingExtras.includes(extra);
                const extraTitle =
                  extra === "code"
                    ? "tree-sitter AST compression for code responses"
                    : "Kompress-v2 HF model for prose/agentic traces (~+1GB)";

                if (installed) {
                  const active = extra === "code" ? codeAware : kompress;
                  return (
                    <div
                      key={extra}
                      className="flex items-center gap-1.5 text-xs px-2 py-1 rounded border border-success/40 bg-success/5 text-text"
                      title={extraTitle}
                    >
                      <Toggle
                        size="sm"
                        checked={active}
                        disabled={restartingProxy}
                        onChange={() => toggleExtraActive(extra, !active)}
                      />
                      <span className="font-medium">[{extra}]</span>
                      <button
                        type="button"
                        onClick={() => handleRemoveExtra(extra)}
                        disabled={removingExtra === extra}
                        className="ml-1 text-error underline hover:opacity-80 disabled:opacity-50"
                        title={`Uninstall [${extra}]`}
                      >
                        {removingExtra === extra ? "Uninstalling…" : "Uninstall"}
                      </button>
                    </div>
                  );
                }

                return (
                  <label
                    key={extra}
                    className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded border cursor-pointer transition-colors ${
                      pending
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-text-muted hover:bg-surface-2"
                    }`}
                    title={extraTitle}
                  >
                    <input
                      type="checkbox"
                      className="w-3 h-3"
                      checked={pending}
                      onChange={() => togglePendingExtra(extra)}
                    />
                    <span className="font-medium">[{extra}]</span>
                    <span className="opacity-70">not installed</span>
                  </label>
                );
              })}
              {pendingExtras.length > 0 && (
                <button
                  onClick={handleInstallExtras}
                  disabled={extrasActionLoading}
                  className="text-xs px-2.5 py-1 rounded bg-primary text-white hover:opacity-90 disabled:opacity-50"
                >
                  {extrasActionLoading
                    ? "Installing…"
                    : `Install [proxy,${pendingExtras.join(",")}]`}
                </button>
              )}
            </div>
            {extrasActionError && (
              <p className="text-xs text-error mt-1">{extrasActionError}</p>
            )}
            {restartingProxy && (
              <p className="text-xs text-text-muted mt-1">Restarting proxy…</p>
            )}
            {(extrasActionLoading || removingExtra) && installLog && (
              <pre className="mt-2 max-h-32 overflow-auto rounded bg-surface-2 p-2 text-[10px] leading-tight text-text-muted whitespace-pre-wrap">
                {installLog}
              </pre>
            )}
            <p className="text-xs text-text-muted mt-1">
              Installing adds the package; use <code>on</code>/<code>off</code>{" "}
              to activate it (restarts the proxy). Default install is{" "}
              <code>[proxy]</code> only (SmartCrusher for JSON). Adding{" "}
              <code>[code]</code> enables AST compression
              (Python/JS/TS/Go/Rust/Java/C/C++/Perl). Adding <code>[ml]</code>{" "}
              enables the Kompress-v2 HF model for prose/agentic traces but
              adds ~1 GB (torch + huggingface-hub).
            </p>
            <div className="flex items-center justify-between mt-3 pt-3 border-t border-border gap-4">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">Compress user messages</p>
                <p className="text-xs text-text-muted">
                  Also compress the prompts you send, not just tool output.
                  Off by default — rewriting your own instructions is riskier
                  than compressing tool output.
                </p>
              </div>
              <Toggle
                size="sm"
                checked={headroomCompressUserMessages}
                onChange={() =>
                  handleHeadroomCompressUserMessages(!headroomCompressUserMessages)
                }
              />
            </div>
          </div>
        )}
        <div className="flex items-center justify-between pt-4 border-t border-border gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              Compress LLM output{" "}
              <a
                href="https://github.com/JuliusBrussee/caveman"
                target="_blank"
                rel="noreferrer"
                className="text-xs font-normal text-primary underline hover:opacity-80"
              >
                (Caveman)
              </a>
            </p>
            <p className="text-sm text-text-muted">
              Terse-style system prompt → ~65% fewer output tokens (up to 87%)
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {cavemanEnabled && (
              <div className="flex flex-col items-end gap-1">
                <div className="flex items-center gap-1.5">
                  {visibleCavemanLevels.map((lvl) => (
                    <button
                      key={lvl.id}
                      onClick={() => handleCavemanLevel(lvl.id)}
                      className={`px-3 py-1.5 rounded text-xs font-medium border transition-colors ${
                        cavemanLevel === lvl.id
                          ? "bg-primary text-white border-primary"
                          : "bg-transparent border-border text-text-muted hover:bg-surface-2"
                      }`}
                      title={lvl.desc}
                    >
                      {lvl.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-primary">
                  {
                    CAVEMAN_LEVELS.find((lvl) => lvl.id === cavemanLevel)
                      ?.desc
                  }
                </p>
              </div>
            )}
            <Toggle
              checked={cavemanEnabled}
              onChange={() => handleCavemanEnabled(!cavemanEnabled)}
            />
          </div>
        </div>
        <div className="flex items-center justify-between pt-4 mt-4 border-t border-border gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              Lazy senior dev{" "}
              <a
                href="https://github.com/DietrichGebert/ponytail"
                target="_blank"
                rel="noreferrer"
                className="text-xs font-normal text-primary underline hover:opacity-80"
              >
                (Ponytail)
              </a>
            </p>
            <p className="text-sm text-text-muted">
              Bias the model toward minimal code: YAGNI, reuse stdlib,
              deletion over addition
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {ponytailEnabled && (
              <div className="flex flex-col items-end gap-1">
                <div className="flex items-center gap-1.5">
                  {PONYTAIL_LEVELS.map((lvl) => (
                    <button
                      key={lvl.id}
                      onClick={() => handlePonytailLevel(lvl.id)}
                      className={`px-3 py-1.5 rounded text-xs font-medium border transition-colors ${
                        ponytailLevel === lvl.id
                          ? "bg-primary text-white border-primary"
                          : "bg-transparent border-border text-text-muted hover:bg-surface-2"
                      }`}
                      title={lvl.desc}
                    >
                      {lvl.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-primary">
                  {
                    PONYTAIL_LEVELS.find((lvl) => lvl.id === ponytailLevel)
                      ?.desc
                  }
                </p>
              </div>
            )}
            <Toggle
              checked={ponytailEnabled}
              onChange={() => handlePonytailEnabled(!ponytailEnabled)}
            />
          </div>
        </div>
        <div className="flex items-center justify-between pt-4 mt-4 border-t border-border gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <p className="font-medium">
                Compress prompts as images{" "}
                <a
                  href="https://github.com/teamchong/pxpipe"
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-normal text-primary underline hover:opacity-80"
                >
                  (PXPIPE)
                </a>
              </p>
              <span className={`text-xs px-2 py-0.5 rounded ${pxpipeChipClass}`}>
                {pxpipeStatusLabel}
              </span>
              <button
                type="button"
                onClick={() => setShowPxpipeModal(true)}
                className="text-xs text-primary underline hover:opacity-80"
              >
                {pxpipeStatus.installed ? "Manage" : "Setup"}
              </button>
              <a
                href="/dashboard/pxpipe"
                className="text-xs text-primary underline hover:opacity-80"
              >
                Dashboard
              </a>
            </div>
            <p className="text-sm text-text-muted mt-1">
              Transforms large textual context into optimized images before
              sending to the LLM. Ideal for huge prompts, tool outputs and long
              conversations.
            </p>
          </div>
          <Toggle
            checked={pxpipeEnabled}
            disabled={!pxpipeStatus.installed}
            onChange={() => handlePxpipeEnabled(!pxpipeEnabled)}
          />
        </div>
      </Card>

      <Card id="history-trim">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">
              history
            </span>
            History trimming
          </h2>
        </div>
        <div className="flex items-center justify-between pt-2 gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <p className="font-medium">Trim old turns</p>
            <p className="text-sm text-text-muted">
              Once a conversation crosses the threshold, the content of old
              turns is replaced with a short stub. The turn structure, tool
              pairing, system prompt and the first user message are preserved —
              only the bulk goes. This is the only saver that changes what the
              model can still read, so it is off by default.
            </p>
          </div>
          <Toggle
            checked={historyTrimEnabled}
            onChange={() => handleHistoryTrimEnabled(!historyTrimEnabled)}
          />
        </div>
        {historyTrimEnabled && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4 pt-4 border-t border-border">
            <div>
              <label className="text-sm font-medium block mb-1">
                Threshold (est. tokens)
              </label>
              <Input
                type="number"
                min={1000}
                value={historyTrimThresholdTokens}
                onChange={(e) => setHistoryTrimThresholdTokens(e.target.value)}
                onBlur={handleHistoryTrimThresholdBlur}
              />
              <p className="text-xs text-text-muted mt-1">
                Trim only when the prompt estimate exceeds this. Lower = more
                aggressive.
              </p>
            </div>
            <div>
              <label className="text-sm font-medium block mb-1">
                Keep last N turns
              </label>
              <Input
                type="number"
                min={0}
                value={historyTrimKeepTurns}
                onChange={(e) => setHistoryTrimKeepTurns(e.target.value)}
                onBlur={handleHistoryTrimKeepTurnsBlur}
              />
              <p className="text-xs text-text-muted mt-1">
                The working context the model needs most. 8 is a safe default
                for agent loops.
              </p>
            </div>
          </div>
        )}
      </Card>

      <Card id="budget">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">
              speed
            </span>
            Budget guard
          </h2>
        </div>
        <p className="text-sm text-text-muted mb-4">
          Hard ceilings applied to every request at dispatch. 0 means off — the
          model&apos;s own limit applies. These are ceilings, not targets: a request
          asking for less keeps its own value.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="text-sm font-medium block mb-1">
              Max output tokens per request
            </label>
            <Input
              type="number"
              min={0}
              value={maxOutputTokensCap}
              onChange={(e) => setMaxOutputTokensCap(e.target.value)}
              onBlur={handleMaxOutputCapBlur}
            />
            <p className="text-xs text-text-muted mt-1">
              Currently 0 (off). Default behaviour clamps to the model&apos;s
              published output limit, up to 64000.
            </p>
          </div>
          <div>
            <label className="text-sm font-medium block mb-1">
              Max thinking budget per request
            </label>
            <Input
              type="number"
              min={0}
              value={thinkingBudgetCap}
              onChange={(e) => setThinkingBudgetCap(e.target.value)}
              onBlur={handleThinkingBudgetCapBlur}
            />
            <p className="text-xs text-text-muted mt-1">
              Caps <code>thinking.budget_tokens</code> on reasoning models.
              0 = off.
            </p>
          </div>
        </div>
      </Card>

      <Modal
        isOpen={showHeadroomInstallModal}
        title={headroomRunning ? "Headroom" : "Setup Headroom"}
        onClose={() => setShowHeadroomInstallModal(false)}
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between text-sm">
            <span>Status</span>
            <span
              className={headroomRunning ? "text-success" : "text-warning"}
            >
              {headroomStatusLabel}
            </span>
          </div>
          {headroomRunning && (
            <a
              href="/api/headroom/proxy/dashboard"
              target="_blank"
              rel="noreferrer"
              className="w-full rounded border border-border px-4 py-2 text-center text-sm hover:bg-surface-2"
            >
              Open Headroom Dashboard
            </a>
          )}
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">Proxy URL</p>
            <Input
              value={headroomUrl}
              onChange={(e) => setHeadroomUrl(e.target.value)}
              onBlur={handleHeadroomUrlBlur}
              placeholder="http://localhost:8787"
              className="font-mono text-sm"
            />
            <p className="text-xs text-text-muted">
              Use a local proxy for Start/Stop, or an external Docker sidecar
              like http://headroom:8787.
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">Timeout (ms)</p>
            <Input
              value={String(headroomTimeoutMs)}
              onChange={(e) => setHeadroomTimeoutMs(e.target.value)}
              onBlur={handleHeadroomTimeoutBlur}
              placeholder="3000"
              className="font-mono text-sm"
            />
            <p className="text-xs text-text-muted">
              Request timeout in milliseconds. Defaults to 3000 ms.
            </p>
          </div>
          {headroomManaged ? (
            <Button
              onClick={handleHeadroomStop}
              variant="ghost"
              fullWidth
              disabled={headroomActionLoading}
            >
              {headroomActionLoading ? "Stopping…" : "Stop Headroom"}
            </Button>
          ) : headroomRunning ? (
            <p className="text-sm text-success">
              Headroom proxy is reachable. You can enable the token saver.
            </p>
          ) : headroomCanStart ? (
            <Button
              onClick={handleHeadroomStart}
              fullWidth
              disabled={headroomActionLoading}
            >
              {headroomActionLoading ? "Starting…" : "Start Headroom"}
            </Button>
          ) : !headroomLocalUrl ? (
            <p className="text-sm text-warning">
              Start Headroom separately at the configured URL, then recheck.
            </p>
          ) : !headroomStatus.python ? (
            <p className="text-sm text-warning">
              Python ≥ 3.10 required for local managed mode. Install Python
              first, or use an external proxy URL.
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">Install then click Start:</p>
              <div className="flex items-center gap-2">
                <pre className="flex-1 rounded bg-black/5 dark:bg-white/5 p-2 text-xs font-mono overflow-x-auto">
                  {`pip install "headroom-ai[proxy]"`}
                </pre>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    copy(`pip install "headroom-ai[proxy]"`)
                  }
                >
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
            </div>
          )}
          {headroomActionError && (
            <p className="text-sm text-warning">{headroomActionError}</p>
          )}
          <div className="flex gap-2">
            <Button
              onClick={() => refreshHeadroomStatus()}
              variant="ghost"
              fullWidth
            >
              Recheck
            </Button>
            <Button
              onClick={() => setShowHeadroomInstallModal(false)}
              fullWidth
            >
              Done
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={showPxpipeModal}
        title={pxpipeStatus.installed ? "PXPIPE" : "Setup PXPIPE"}
        onClose={() => setShowPxpipeModal(false)}
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-muted">
            Compress prompts using multimodal encoding. Runs in-process — no
            extra server or environment variables required.
          </p>
          <div className="flex items-center justify-between text-sm">
            <span>Status</span>
            <span className={pxpipeHealthy || pxpipeStatus.running ? "text-success" : "text-warning"}>
              {pxpipeStatusLabel}
              {pxpipeStatus.version ? ` · v${pxpipeStatus.version}` : ""}
            </span>
          </div>
          {pxpipeHealth?.checks?.length > 0 && (
            <div className="flex flex-col gap-1 rounded border border-border p-3">
              <p className="text-sm font-medium mb-1">Health check</p>
              {pxpipeHealth.checks.map((check) => (
                <div key={check.id} className="flex items-center justify-between text-xs">
                  <span className={check.ok ? "text-success" : "text-warning"}>
                    {check.ok ? "●" : "○"} {check.label}
                  </span>
                  {check.detail && (
                    <span className="text-text-muted font-mono truncate max-w-[50%]">{check.detail}</span>
                  )}
                </div>
              ))}
              {pxpipeHealth.error && (
                <p className="text-xs text-warning mt-1">{pxpipeHealth.error}</p>
              )}
            </div>
          )}
          {!pxpipeStatus.installed ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-warning">PXPIPE is not installed.</p>
              <Button
                onClick={() => pxpipeAction("install")}
                fullWidth
                disabled={pxpipeActionLoading || pxpipeStatus.installing}
              >
                {pxpipeActionLoading || pxpipeStatus.installing ? "Installing…" : "Install"}
              </Button>
              <p className="text-xs text-text-muted">
                Installs the npm package <code className="font-mono">pxpipe-proxy</code> into
                the OmniHilbras data directory. May take a few minutes.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {pxpipeStatus.running ? (
                <>
                  <Button onClick={() => pxpipeAction("restart")} variant="ghost" disabled={pxpipeActionLoading}>
                    Restart
                  </Button>
                  <Button onClick={() => pxpipeAction("stop")} variant="ghost" disabled={pxpipeActionLoading}>
                    Stop
                  </Button>
                </>
              ) : (
                <Button onClick={() => pxpipeAction("start")} disabled={pxpipeActionLoading}>
                  {pxpipeActionLoading ? "Starting…" : "Start"}
                </Button>
              )}
              <Button onClick={() => pxpipeAction("install")} variant="ghost" disabled={pxpipeActionLoading}>
                Repair
              </Button>
              <a
                href="/dashboard/pxpipe#logs"
                className="col-span-2 rounded border border-border px-4 py-2 text-center text-sm hover:bg-surface-2"
              >
                Open Logs
              </a>
            </div>
          )}
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">Minimum prompt size (chars)</p>
            <Input
              value={String(pxpipeMinChars)}
              onChange={(e) => setPxpipeMinChars(e.target.value)}
              onBlur={handlePxpipeMinCharsBlur}
              placeholder="25000"
              className="font-mono text-sm"
            />
            <p className="text-xs text-text-muted">
              Requests smaller than this bypass PXPIPE and are sent as-is.
            </p>
          </div>
          {pxpipeActionError && (
            <p className="text-sm text-warning">{pxpipeActionError}</p>
          )}
          <div className="flex gap-2">
            <Button
              onClick={() => refreshPxpipeStatus().then(runPxpipeHealth)}
              variant="ghost"
              fullWidth
            >
              Recheck
            </Button>
            <Button onClick={() => setShowPxpipeModal(false)} fullWidth>
              Done
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmModal
        isOpen={!!extrasConfirm}
        onClose={() => setExtrasConfirm(null)}
        onConfirm={() => {
          const fn = extrasConfirm?.onConfirm;
          setExtrasConfirm(null);
          fn?.();
        }}
        title={extrasConfirm?.title}
        message={extrasConfirm?.message}
        confirmText={extrasConfirm?.confirmText}
        variant={extrasConfirm?.variant}
      />
    </div>
  );
}
