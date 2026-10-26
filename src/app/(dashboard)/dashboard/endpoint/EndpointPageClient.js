"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Card, Button, Input, Modal, CardSkeleton, Toggle, ConfirmModal } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import {
  CircleAlert,
  Cloud,
  Check,
  Copy,
  Globe,
  KeyRound,
  LoaderCircle,
  Plus,
  RefreshCw,
  ShieldCheck,
  Terminal,
  Trash2,
} from "lucide-react";
import { cn } from "@/shared/utils/cn";
import {
  TUNNEL_BENEFITS,
  TUNNEL_PING_INTERVAL_MS,
  TUNNEL_PING_MAX_MS,
  STATUS_POLL_FAST_MS,
  STATUS_POLL_SLOW_MS,
  REACHABLE_MISS_THRESHOLD,
  CLIENT_PING_FAST_MS,
  CLIENT_PING_SLOW_MS,
} from "./endpointConstants";
import { clientPingUrl, clientPingAny } from "./endpointPing";
import useSettingsStore from "@/store/settingsStore";
import StatusAlert from "./components/StatusAlert";
import Tooltip from "./components/Tooltip";
import SecurityWarning from "./components/SecurityWarning";
import KeyAccessControls from "./components/KeyAccessControls";
import KeyRateLimitControls from "./components/KeyRateLimitControls";

function CopyButton({ value, label }) {
  const { copied, copy } = useCopyToClipboard();
  return (
    <button
      type="button"
      onClick={() => copy(value, label)}
      aria-label={copied === label ? `${label} copied` : `Copy ${label}`}
      className="muted grid h-7 w-7 shrink-0 place-items-center rounded-lg hover:bg-surface-2 hover:text-gold-text"
    >
      {copied === label ? <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
    </button>
  );
}

function CodeRow({ label, value, copyId, copied, onCopy }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line bg-bg-soft/60 px-3 py-2">
      <span className="mono-label shrink-0">{label}</span>
      <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-main">{value}</code>
      <CopyButton value={value} label={copyId} />
    </div>
  );
}

export default function APIPageClient() {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [keysError, setKeysError] = useState("");
  const [keyError, setKeyError] = useState("");
  const [createKeyError, setCreateKeyError] = useState("");
  const [showAddModal, setShowAddModal] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [createdKey, setCreatedKey] = useState(null);
  const [confirmState, setConfirmState] = useState(null);

  const [requireApiKey, setRequireApiKey] = useState(false);
  const [requireLogin, setRequireLogin] = useState(true);
  const [hasPassword, setHasPassword] = useState(true);
 const [tunnelDashboardAccess, setTunnelDashboardAccess] = useState(false);

 // Cloudflare Tunnel state
  const [tunnelChecking, setTunnelChecking] = useState(true);
  const [tunnelEnabled, setTunnelEnabled] = useState(false);
  const [tunnelReachable, setTunnelReachable] = useState(false);
  const [tunnelUrl, setTunnelUrl] = useState("");
  const [tunnelPublicUrl, setTunnelPublicUrl] = useState("");
  const [tunnelLoading, setTunnelLoading] = useState(false);
  const [tunnelProgress, setTunnelProgress] = useState("");
  const [tunnelStatus, setTunnelStatus] = useState(null);
  const [showEnableTunnelModal, setShowEnableTunnelModal] = useState(false);
  const [showDisableTunnelModal, setShowDisableTunnelModal] = useState(false);

  // Tailscale state
  const [tsEnabled, setTsEnabled] = useState(false);
  const [tsReachable, setTsReachable] = useState(false);
  const [tsUrl, setTsUrl] = useState("");
  const [tsLoading, setTsLoading] = useState(false);
  const [tsProgress, setTsProgress] = useState("");
  const [tsStatus, setTsStatus] = useState(null);
  const [tsAuthUrl, setTsAuthUrl] = useState("");
  const [tsAuthLabel, setTsAuthLabel] = useState("");
  const [tsInstalled, setTsInstalled] = useState(null); // null=checking, true/false
  const [tsInstalling, setTsInstalling] = useState(false);
  const [tsInstallLog, setTsInstallLog] = useState([]);
  const [tsSudoPassword, setTsSudoPassword] = useState("");
  const [tsConnecting, setTsConnecting] = useState(false);
  const [showTsModal, setShowTsModal] = useState(false);
  const [showDisableTsModal, setShowDisableTsModal] = useState(false);
  const tsLogRef = useRef(null);
  // Unmount flag + abort controller for background poll/health loops: the enable
  // fetch can hang indefinitely, so without these the loops would keep fetching
  // (and setState) forever after the page is gone.
  const mountedRef = useRef(true);
  const pollControllerRef = useRef(null);

  useEffect(() => {
    // Re-armed here too because StrictMode's simulated unmount+remount runs
    // this cleanup once without truly discarding the component.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pollControllerRef.current?.abort();
    };
  }, []);

  // Debounce reachable=false: server may briefly return false during background refresh.
  // Only flip UI to "reconnecting" after N consecutive misses to avoid spinner flicker.
  const tunnelMissRef = useRef(0);
  const tsMissRef = useRef(0);
  // Browser-side reachable cache (independent of backend DNS quirks)
  const tunnelClientReachableRef = useRef(false);
  const tsClientReachableRef = useRef(false);
  // Track whether reachable=true was ever observed in this session.
  // Distinguishes "Checking..." (initial cold cache) from "Reconnecting..." (lost connection).
  const tunnelEverReachableRef = useRef(false);
  const tsEverReachableRef = useRef(false);
  const [tunnelEverReachable, setTunnelEverReachable] = useState(false);
  const [tsEverReachable, setTsEverReachable] = useState(false);

  // Client-side local/remote detection (UI hint only, not a security gate)
  const [isRemoteHost, setIsRemoteHost] = useState(false);
  useEffect(() => {
    if (typeof window !== "undefined")
      setIsRemoteHost(!["localhost", "127.0.0.1", "::1"].includes(window.location.hostname));
  }, []);

  const { copied, copy } = useCopyToClipboard();

  // Security gate: block remote exposure while dashboard uses default password or login is off.
  const isLoginUnsafe = !requireLogin || !hasPassword;
  const unsafeReason = !requireLogin
    ? "Enable \"Require login\" and set a custom password before activating the tunnel."
    : "Change the default dashboard password before activating the tunnel.";

  // Auto-scroll install log
  useEffect(() => {
    if (tsLogRef.current) tsLogRef.current.scrollTop = tsLogRef.current.scrollHeight;
  }, [tsInstallLog]);

  useEffect(() => {
    fetchData();
    loadSettings();
  }, []);

  // Status poll: fast while degraded, slow while healthy — a healthy tunnel can
  // still die, and the dashboard has to notice that without a reload.
  // Visibility re-check: refresh once when tab becomes visible.
  useEffect(() => {
    const anyEnabled = tunnelEnabled || tsEnabled;
    if (!anyEnabled) return;
    const tunnelHealthy = !tunnelEnabled || tunnelReachable;
    const tsHealthy = !tsEnabled || tsReachable;
    const allHealthy = tunnelHealthy && tsHealthy;
    const onVisible = () => { if (!document.hidden) syncTunnelStatus(); };
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(
      () => { if (!document.hidden) syncTunnelStatus(); },
      allHealthy ? STATUS_POLL_SLOW_MS : STATUS_POLL_FAST_MS,
    );
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [tunnelEnabled, tsEnabled, tunnelReachable, tsReachable]);

  // Browser-side periodic ping: probes tunnel/tailscale URLs directly so UI stays
  // "reachable" even when backend DNS (1.1.1.1) hiccups on *.ts.net or *.trycloudflare.com.
  // Adaptive: slow when healthy, fast when degraded; pause when tab hidden.
  useEffect(() => {
    const probeBoth = async () => {
      if (document.hidden) return;
      if (tunnelEnabled && (tunnelUrl || tunnelPublicUrl)) {
        const ok = await clientPingAny(tunnelPublicUrl, tunnelUrl);
        tunnelClientReachableRef.current = ok;
        if (ok) { tunnelMissRef.current = 0; setTunnelReachable(true); if (!tunnelEverReachableRef.current) { tunnelEverReachableRef.current = true; setTunnelEverReachable(true); } }
        else { tunnelMissRef.current += 1; if (tunnelMissRef.current >= REACHABLE_MISS_THRESHOLD) setTunnelReachable(false); }
      } else {
        tunnelClientReachableRef.current = false;
      }
      if (tsEnabled && tsUrl) {
        const ok = await clientPingUrl(tsUrl);
        tsClientReachableRef.current = ok;
        if (ok) { tsMissRef.current = 0; setTsReachable(true); if (!tsEverReachableRef.current) { tsEverReachableRef.current = true; setTsEverReachable(true); } }
        else { tsMissRef.current += 1; if (tsMissRef.current >= REACHABLE_MISS_THRESHOLD) setTsReachable(false); }
      } else {
        tsClientReachableRef.current = false;
      }
    };
    const anyEnabled = (tunnelEnabled && (tunnelUrl || tunnelPublicUrl)) || (tsEnabled && tsUrl);
    if (!anyEnabled) return;
    probeBoth();
    const tunnelHealthy = !tunnelEnabled || tunnelReachable;
    const tsHealthy = !tsEnabled || tsReachable;
    const allHealthy = tunnelHealthy && tsHealthy;
    // A healthy endpoint is still probed, only less often: a tunnel that dies
    // must not keep showing as reachable until the page is reloaded.
    const id = setInterval(probeBoth, allHealthy ? CLIENT_PING_SLOW_MS : CLIENT_PING_FAST_MS);
    return () => clearInterval(id);
  }, [tunnelEnabled, tunnelUrl, tunnelPublicUrl, tsEnabled, tsUrl, tunnelReachable, tsReachable]);

  // Client-side reachable only (server no longer probes; watchdog handles backend health).
  // Miss-debounce: only flip to false after N consecutive misses.
  const updateReachable = useCallback((_unused, clientRef, missRef, setter, everRef, everSetter) => {
    const reachable = clientRef.current;
    if (reachable) {
      missRef.current = 0;
      setter(true);
      if (!everRef.current) {
        everRef.current = true;
        everSetter(true);
      }
    } else {
      missRef.current += 1;
      if (missRef.current >= REACHABLE_MISS_THRESHOLD) setter(false);
    }
  }, []);

  // Trust user intent (settingsEnabled): UI stays "enabled" while watchdog restarts process
  const syncTunnelStatus = async () => {
    try {
      const statusRes = await fetch("/api/tunnel/status", { cache: "no-store" });
      if (!statusRes.ok) return;
      const data = await statusRes.json();
      const tEnabled = data.tunnel?.settingsEnabled ?? data.tunnel?.enabled ?? false;
      const tUrl = data.tunnel?.tunnelUrl || "";
      setTunnelUrl(tUrl);
      setTunnelPublicUrl(data.tunnel?.publicUrl || "");
      setTunnelEnabled(tEnabled);
      updateReachable(null, tunnelClientReachableRef, tunnelMissRef, setTunnelReachable, tunnelEverReachableRef, setTunnelEverReachable);

      const tsEn = data.tailscale?.settingsEnabled ?? data.tailscale?.enabled ?? false;
      const tsUrlVal = data.tailscale?.tunnelUrl || "";
      setTsUrl(tsUrlVal);
      setTsEnabled(tsEn);
      updateReachable(null, tsClientReachableRef, tsMissRef, setTsReachable, tsEverReachableRef, setTsEverReachable);
    } catch { /* ignore poll errors */ }
  };

  const loadSettings = async () => {
    setTunnelChecking(true);
    try {
      const [settingsData, statusRes] = await Promise.all([
        useSettingsStore.getState().fetchSettings(),
        fetch("/api/tunnel/status", { cache: "no-store" })
      ]);
      if (settingsData) {
        setRequireApiKey(settingsData.requireApiKey || false);
        setRequireLogin(settingsData.requireLogin !== false);
        setHasPassword(settingsData.hasPassword || false);
        setTunnelDashboardAccess(settingsData.tunnelDashboardAccess || false);
      }
      if (statusRes.ok) {
        const data = await statusRes.json();
        const tEnabled = data.tunnel?.settingsEnabled ?? data.tunnel?.enabled ?? false;
        const tUrl = data.tunnel?.tunnelUrl || "";
        setTunnelUrl(tUrl);
        setTunnelPublicUrl(data.tunnel?.publicUrl || "");
        setTunnelEnabled(tEnabled);
        updateReachable(null, tunnelClientReachableRef, tunnelMissRef, setTunnelReachable, tunnelEverReachableRef, setTunnelEverReachable);

        const tsEn = data.tailscale?.settingsEnabled ?? data.tailscale?.enabled ?? false;
        const tsUrlVal = data.tailscale?.tunnelUrl || "";
        setTsUrl(tsUrlVal);
        setTsEnabled(tsEn);
        updateReachable(null, tsClientReachableRef, tsMissRef, setTsReachable, tsEverReachableRef, setTsEverReachable);
      }
    } catch (error) {
      console.log("Error loading settings:", error);
    } finally {
      setTunnelChecking(false);
    }
  };

  const handleTunnelDashboardAccess = async (value) => {
    try {
      const updated = await useSettingsStore.getState().patchSettings({ tunnelDashboardAccess: value });
      if (updated) setTunnelDashboardAccess(value);
    } catch (error) {
      console.log("Error updating tunnelDashboardAccess:", error);
    }
  };

  const handleRequireApiKey = async (value) => {
    try {
      const updated = await useSettingsStore.getState().patchSettings({ requireApiKey: value });
      if (updated) setRequireApiKey(value);
    } catch (error) {
      console.log("Error updating requireApiKey:", error);
    }
  };

  const fetchData = async () => {
    try {
      const fetchKeys = async () => {
        const res = await fetch("/api/keys");
        if (!res.ok) throw new Error(`Failed to load the API keys (HTTP ${res.status})`);
        const data = await res.json();
        return data.keys || [];
      };

      let existing = await fetchKeys();
      // Auto-provision a default key for first-time users so the endpoint works out of the box.
      if (existing.length === 0) {
        let created = false;
        try {
          const createRes = await fetch("/api/keys", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "Default Key" }),
          });
          created = createRes.ok;
        } catch { /* fall through to empty render */ }
        if (created) existing = await fetchKeys();
      }
      setKeys(existing);
      setKeysError("");
    } catch (error) {
      console.log("Error fetching data:", error);
      // Without this the page would render "No API keys yet" for a server failure.
      setKeysError(error.message || "Failed to load the API keys.");
    } finally {
      setLoading(false);
    }
  };

  // u2500u2500u2500 Cloudflare Tunnel handlers
  // Ping tunnel health until reachable. Race multiple URLs (shortlink + direct) — 1 OK is enough.
  const pingTunnelHealth = async (...urls) => {
    if (!mountedRef.current) return false;
    setTunnelLoading(true);
    setTunnelProgress("Waiting for tunnel ready...");
    const targets = urls.filter(Boolean).map((u) => `${u}/api/health`);
    const controller = new AbortController();
    const { signal } = controller;
    const start = Date.now();
    while (Date.now() - start < TUNNEL_PING_MAX_MS && mountedRef.current) {
      await new Promise((r) => setTimeout(r, TUNNEL_PING_INTERVAL_MS));
      if (!mountedRef.current) break;
      const ok = await Promise.any(targets.map(async (h) => {
        const p = await fetch(h, { mode: "cors", cache: "no-store", signal });
        if (p.ok) return true;
        throw new Error("not ready");
      })).catch(() => false);
      if (ok) {
        setTunnelEnabled(true);
        setTunnelLoading(false);
        setTunnelProgress("");
        return true;
      }
      // Every 5 pings (~10s), check if backend process still alive
      if ((Date.now() - start) % 10000 < TUNNEL_PING_INTERVAL_MS) {
        try {
          const statusRes = await fetch("/api/tunnel/status", { signal });
          if (statusRes.ok) {
            const status = await statusRes.json();
            if (!status.tunnel?.enabled) {
              setTunnelStatus({ type: "error", message: "Tunnel process stopped unexpectedly." });
              setTunnelLoading(false);
              setTunnelProgress("");
              return false;
            }
          }
        } catch { /* ignore */ }
      }
    }
    controller.abort();
    if (!mountedRef.current) return false;
    setTunnelStatus({ type: "error", message: "Tunnel created but not reachable. Please try again." });
    setTunnelLoading(false);
    setTunnelProgress("");
    return false;
  };

  const handleEnableTunnel = async () => {
    setShowEnableTunnelModal(false);
    setTunnelLoading(true);
    setTunnelStatus(null);
    setTunnelProgress("Creating tunnel...");

    // Poll download progress while enable request is pending
    let polling = true;
    const pollProgress = async () => {
      const controller = new AbortController();
      pollControllerRef.current = controller;
      while (polling) {
        if (!mountedRef.current) { polling = false; break; }
        try {
          const r = await fetch("/api/tunnel/status", { signal: controller.signal });
          if (r.ok) {
            const s = await r.json();
            if (s.download?.downloading) {
              setTunnelProgress(`Downloading cloudflared... ${s.download.progress}%`);
            } else if (polling) {
              setTunnelProgress("Creating tunnel...");
            }
          }
        } catch { /* ignore */ }
        if (!polling || !mountedRef.current) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (pollControllerRef.current === controller) pollControllerRef.current = null;
    };
    pollProgress();

    try {
      const res = await fetch("/api/tunnel/enable", { method: "POST" });
      polling = false;
      const data = await res.json();
      if (!res.ok) {
        setTunnelStatus({ type: "error", message: data.error || "Failed to enable tunnel" });
        return;
      }

      const url = data.tunnelUrl;
      if (!url) {
        setTunnelStatus({ type: "error", message: "No tunnel URL returned" });
        return;
      }

      setTunnelUrl(url);
      setTunnelPublicUrl(data.publicUrl || "");
      await pingTunnelHealth(data.publicUrl, url);
    } catch (error) {
      setTunnelStatus({ type: "error", message: error.message });
    } finally {
      polling = false;
      setTunnelLoading(false);
      setTunnelProgress("");
    }
  };

  const handleDisableTunnel = async () => {
    setTunnelLoading(true);
    setTunnelStatus(null);
    try {
      const res = await fetch("/api/tunnel/disable", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setTunnelEnabled(false);
        setTunnelUrl("");
        setShowDisableTunnelModal(false);
        setTunnelStatus({ type: "success", message: "Tunnel disabled" });
      } else {
        setTunnelStatus({ type: "error", message: data.error || "Failed to disable tunnel" });
      }
    } catch (error) {
      setTunnelStatus({ type: "error", message: error.message });
    } finally {
      setTunnelLoading(false);
    }
  };

  // u2500u2500u2500 Tailscale handlers
  const checkTailscaleInstalled = async () => {
    setTsInstalled(null);
    try {
      const res = await fetch("/api/tunnel/tailscale-check");
      if (res.ok) {
        const data = await res.json();
        setTsInstalled(data.installed);
        return data;
      }
    } catch { /* ignore */ }
    setTsInstalled(false);
    return { installed: false };
  };

  const handleInstallTailscale = async () => {
    setTsInstalling(true);
    setTsStatus(null);
    setTsInstallLog([]);
    try {
      const res = await fetch("/api/tunnel/tailscale-install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sudoPassword: tsSudoPassword }),
      });
      setTsSudoPassword("");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";
        for (const part of parts) {
          const lines = part.split("\n");
          let event = "progress";
          let data = null;
          for (const line of lines) {
            if (line.startsWith("event: ")) event = line.slice(7).trim();
            if (line.startsWith("data: ")) {
              try { data = JSON.parse(line.slice(6)); } catch { /* skip */ }
            }
          }
          if (!data) continue;
          if (event === "progress") {
            setTsInstallLog((prev) => [...prev.slice(-50), data.message]);
          } else if (event === "done") {
            setTsInstalled(true);
            setTsInstalling(false);
            setShowTsModal(false);
            handleConnectTailscale();
            return;
          } else if (event === "error") {
            setTsStatus({ type: "error", message: data.error || "Install failed" });
          }
        }
      }
    } catch (e) {
      setTsStatus({ type: "error", message: e.message });
    } finally {
      setTsInstalling(false);
    }
  };

  // Ping Tailscale health until reachable
  const pingTsHealth = async (url) => {
    if (!mountedRef.current) return false;
    setTsProgress("Waiting for Tailscale ready...");
    const healthUrl = `${url}/api/health`;
    const controller = new AbortController();
    const { signal } = controller;
    const start = Date.now();
    while (Date.now() - start < TUNNEL_PING_MAX_MS && mountedRef.current) {
      await new Promise((r) => setTimeout(r, TUNNEL_PING_INTERVAL_MS));
      if (!mountedRef.current) break;
      try {
        const ping = await fetch(healthUrl, { mode: "no-cors", cache: "no-store", signal });
        if (ping.ok || ping.type === "opaque") return true;
      } catch { /* not ready yet */ }
    }
    controller.abort();
    return false;
  };

  // Show inline login button instead of auto-opening popup (browsers block popups
  // opened after async work because the user gesture is lost).
  const requestUserAuth = (url, label) => {
    setTsAuthUrl(url);
    setTsAuthLabel(label);
  };

  const clearUserAuth = () => {
    setTsAuthUrl("");
    setTsAuthLabel("");
  };

  const handleConnectTailscale = async () => {
    setShowTsModal(false);
    setTsConnecting(true);
    setTsLoading(true);
    setTsStatus(null);
    setTsProgress("Connecting...");
    clearUserAuth();
    try {
      const res = await fetch("/api/tunnel/tailscale-enable", { method: "POST" });
      const data = await res.json();

      if (res.ok && data.success) {
        setTsUrl(data.tunnelUrl || "");
        const reachable = await pingTsHealth(data.tunnelUrl);
        setTsEnabled(true);
        setTsStatus(reachable ? null : { type: "warning", message: "Connected but not reachable yet." });
        return;
      }

      if (data.needsLogin && data.authUrl) {
        requestUserAuth(data.authUrl, "Open Login Page");
        setTsProgress("Login required — click \"Open Login Page\" to continue");
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          // The user left the page: stop polling instead of running for the
          // full two minutes.
          if (!mountedRef.current) return;
          try {
            const r2 = await fetch("/api/tunnel/tailscale-check");
            if (r2.ok) {
              const check = await r2.json();
              if (check.loggedIn) {
                clearUserAuth();
                setTsProgress("Starting funnel...");
                const res2 = await fetch("/api/tunnel/tailscale-enable", { method: "POST" });
                const data2 = await res2.json();
                if (res2.ok && data2.success) {
                  setTsUrl(data2.tunnelUrl || "");
                  const ok2 = await pingTsHealth(data2.tunnelUrl);
                  setTsEnabled(true);
                  setTsStatus(ok2 ? null : { type: "warning", message: "Connected but not reachable yet." });
                } else if (data2.funnelNotEnabled && data2.enableUrl) {
                  await pollFunnelEnable(data2.enableUrl);
                } else {
                  setTsStatus({ type: "error", message: data2.error || "Failed to start funnel" });
                }
                return;
              }
            }
          } catch { /* retry */ }
        }
        clearUserAuth();
        setTsStatus({ type: "error", message: "Login timed out. Please try again." });
        return;
      }

      if (data.funnelNotEnabled && data.enableUrl) {
        await pollFunnelEnable(data.enableUrl);
        return;
      }

      setTsStatus({ type: "error", message: data.error || "Failed to connect" });
    } catch (error) {
      setTsStatus({ type: "error", message: error.message });
    } finally {
      setTsLoading(false);
      setTsConnecting(false);
      setTsProgress("");
      clearUserAuth();
    }
  };

  const pollFunnelEnable = async (enableUrl) => {
    requestUserAuth(enableUrl, "Open Funnel Settings");
    setTsProgress("Click \"Open Funnel Settings\" to enable Funnel...");
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      // The user left the page: stop polling instead of running for the full
      // two minutes.
      if (!mountedRef.current) return;
      try {
        const res = await fetch("/api/tunnel/tailscale-enable", { method: "POST" });
        const data = await res.json();
        if (res.ok && data.success) {
          clearUserAuth();
          setTsUrl(data.tunnelUrl || "");
          const ok3 = await pingTsHealth(data.tunnelUrl);
          setTsEnabled(true);
          setTsStatus(ok3 ? null : { type: "warning", message: "Connected but not reachable yet." });
          return;
        }
        if (data.funnelNotEnabled) continue;
        if (data.error) {
          clearUserAuth();
          setTsStatus({ type: "error", message: data.error });
          return;
        }
      } catch { /* retry */ }
    }
    clearUserAuth();
    setTsStatus({ type: "error", message: "Timed out waiting for Funnel to be enabled." });
  };

  const handleDisableTailscale = async () => {
    setTsLoading(true);
    setTsStatus(null);
    try {
      const res = await fetch("/api/tunnel/tailscale-disable", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setTsEnabled(false);
        setTsUrl("");
        setShowDisableTsModal(false);
        setTsStatus({ type: "success", message: "Tailscale disabled" });
      } else {
        setTsStatus({ type: "error", message: data.error || "Failed to disable Tailscale" });
      }
    } catch (e) {
      setTsStatus({ type: "error", message: e.message });
    } finally {
      setTsLoading(false);
    }
  };

  const handleOpenTsModal = async () => {
    setTsStatus(null);
    setTsInstallLog([]);
    const data = await checkTailscaleInstalled();
    if (data?.installed && data?.hasCachedPassword) {
      handleConnectTailscale();
    } else {
      setShowTsModal(true);
    }
  };

  const handleCreateKey = async () => {
    if (!newKeyName.trim()) return;

    setCreateKeyError("");
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newKeyName }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setCreateKeyError(data.error || "Failed to create the key.");
        return;
      }
      setCreatedKey(data.key);
      await fetchData();
      setNewKeyName("");
      setShowAddModal(false);
    } catch (error) {
      console.log("Error creating key:", error);
      setCreateKeyError(error.message || "Failed to create the key.");
    }
  };

  const handleDeleteKey = async (id) => {
    setConfirmState({
      title: "Delete API Key",
      message: "Delete this API key?",
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(`/api/keys/${id}`, { method: "DELETE" });
          if (res.ok) {
            setKeys(keys.filter((k) => k.id !== id));
          }
        } catch (error) {
          console.log("Error deleting key:", error);
        }
      }
    });
  };

  const handleToggleKey = async (id, isActive) => {
    setKeyError("");
    try {
      const res = await fetch(`/api/keys/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      });
      if (res.ok) {
        setKeys(prev => prev.map(k => k.id === id ? { ...k, isActive } : k));
      } else {
        const data = await res.json().catch(() => ({}));
        setKeyError(data.error || "Failed to update the key.");
      }
    } catch (error) {
      console.log("Error toggling key:", error);
      setKeyError(error.message || "Failed to update the key.");
    }
  };

  // Save a key's access (restricted flag + allow list).
  const handleUpdateKeyAccess = async (id, access) => {
    setKeyError("");
    try {
      const res = await fetch(`/api/keys/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.key) {
        setKeys(prev => prev.map(k => k.id === id ? { ...k, access: data.key.access } : k));
      } else {
        setKeyError(data.error || "Failed to update the key access.");
      }
    } catch (error) {
      console.log("Error updating key access:", error);
      setKeyError(error.message || "Failed to update the key access.");
    }
  };

  const [baseUrl, setBaseUrl] = useState("/v1");

  // Hydration fix: Only access window on client side
  useEffect(() => {
    if (typeof window !== "undefined") {
      setBaseUrl(`${window.location.origin}/v1`);
    }
  }, []);

  if (loading) {
    return (
      <div className="flex flex-col gap-8">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  const currentEndpoint = baseUrl;
  const activeKeyCount = keys.filter((k) => k.isActive !== false).length;

  const enableTunnel = () => {
    if (isLoginUnsafe) {
      setTunnelStatus({ type: "error", message: `Security required: ${unsafeReason}` });
      return;
    }
    if (!requireApiKey) {
      setTunnelStatus({ type: "error", message: "Security required: Enable \"Require API key\" before activating the tunnel." });
      return;
    }
    setShowEnableTunnelModal(true);
  };

  const enableTailscale = () => {
    if (isLoginUnsafe) {
      setTsStatus({ type: "error", message: `Security required: ${unsafeReason}` });
      return;
    }
    handleOpenTsModal();
  };

  return (
    <div>
      {/* Header — eyebrow + title + Refresh / Create buttons (old layout) */}
      <div className="mb-6 flex flex-col justify-between gap-5 sm:mb-8 sm:flex-row sm:items-end">
        <div>
          <span className="eyebrow"><span className="eyebrow-dot" aria-hidden="true" />Access control</span>
          <h2 className="mt-4 text-2xl font-semibold tracking-[-0.035em] sm:text-3xl">Endpoint &amp; API keys.</h2>
          <p className="muted mt-2 max-w-xl text-sm leading-relaxed">One endpoint for every tool that talks to this gateway. Keys are shown once, then only a hash is kept on disk.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => { fetchData(); loadSettings(); }}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
            Refresh
          </Button>
          <Button variant="primary" size="sm" onClick={() => { setCreateKeyError(""); setShowAddModal(true); }}>
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Create key
          </Button>
        </div>
      </div>

      {/* Two-column grid: keys + endpoints (left) and right rail (old layout) */}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        {/* Left column */}
        <div className="flex flex-col gap-5">
          {/* API Keys card */}
          <Card id="require-api-key" className="overflow-hidden !p-0">
            <div className="flex flex-col gap-3 border-b border-line p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
              <div>
                <h2 className="flex items-center gap-2 text-sm font-semibold">
                  <KeyRound className="h-4 w-4 text-gold-text" aria-hidden="true" />
                  API keys
                </h2>
                <p className="muted mt-1 text-xs">
                  {loading ? "Loading keys…" : `${activeKeyCount} active of ${keys.length} ${keys.length === 1 ? "key" : "keys"}`}
                </p>
              </div>
              <Button variant="secondary" size="sm" onClick={() => { setCreateKeyError(""); setShowAddModal(true); }}>
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                New key
              </Button>
            </div>

            {/* Require API key toggle */}
            <div className="flex items-center justify-between border-b border-line px-4 py-3 sm:px-5">
              <div>
                <p className="text-sm font-medium">Require API key</p>
                <p className="muted text-xs">Requests without a valid key will be rejected</p>
              </div>
              <Toggle checked={requireApiKey} onChange={() => handleRequireApiKey(!requireApiKey)} />
            </div>

            {isRemoteHost && !requireApiKey && (
              <div className="px-4 pt-3 sm:px-5">
                <SecurityWarning message="Endpoint is exposed without an API key." />
              </div>
            )}

            {keysError || keyError ? (
              <div className="flex items-center gap-2 p-4 sm:p-5">
                <div className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                  <CircleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {keysError || keyError}
                </div>
              </div>
            ) : null}

            {keys.length === 0 ? (
              <div className="px-5 py-12 text-center">
                <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-gold/25 bg-gold-soft text-gold-text">
                  <KeyRound className="h-6 w-6" aria-hidden="true" />
                </span>
                <p className="mt-4 text-sm font-semibold">No API keys yet</p>
                <p className="muted mt-1 text-xs">Create your first key so CLI tools and IDE extensions can call the gateway.</p>
                <Button variant="primary" size="sm" className="mt-4" onClick={() => { setCreateKeyError(""); setShowAddModal(true); }}>
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  Create key
                </Button>
              </div>
            ) : (
              <ul className="divide-y divide-line">
                {keys.map((apiKey) => (
                  <li key={apiKey.id} className={`p-4 sm:p-5 ${apiKey.isActive === false ? "opacity-70" : ""}`}>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-semibold">{apiKey.name}</p>
                          <span className={`rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide ${apiKey.isActive !== false ? "border-success/25 bg-success/10 text-success" : "border-line-strong bg-surface-2 text-muted"}`}>
                            {apiKey.isActive !== false ? "active" : "paused"}
                          </span>
                        </div>
                        <div className="mt-1.5 flex items-center gap-1.5 min-w-0">
                          <code className="break-all font-mono text-[11px] text-muted">{apiKey.key}</code>
                          <CopyButton value={apiKey.key} label={`key_${apiKey.id}`} />
                        </div>
                        <p className="muted mt-1.5 text-[11px]">
                          Created {new Date(apiKey.createdAt).toLocaleDateString()}
                        </p>
                        {/* Our extras: restrict access + rate limits (not in old version) */}
                        <KeyAccessControls
                          apiKey={apiKey}
                          onChange={(access) => handleUpdateKeyAccess(apiKey.id, access)}
                          onRequestRestrict={() => setConfirmState({
                            title: "Restrict API Key",
                            message: `Restrict API key "${apiKey.name}"?\n\nIt will only be able to call the combos and models you add. Until you add one, it can call nothing.`,
                            onConfirm: async () => {
                              setConfirmState(null);
                              handleUpdateKeyAccess(apiKey.id, { restricted: true, allow: apiKey.access?.allow || [] });
                            }
                          })}
                        />
                        <KeyRateLimitControls apiKey={apiKey} />
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Toggle
                          size="sm"
                          checked={apiKey.isActive !== false}
                          onChange={(checked) => {
                            if (apiKey.isActive !== false && !checked) {
                              setConfirmState({
                                title: "Pause API Key",
                                message: `Pause API key "${apiKey.name}"?\n\nThis key will stop working immediately but can be resumed later.`,
                                onConfirm: async () => {
                                  setConfirmState(null);
                                  handleToggleKey(apiKey.id, checked);
                                }
                              });
                            } else {
                              handleToggleKey(apiKey.id, checked);
                            }
                          }}
                          title={apiKey.isActive !== false ? "Pause key" : "Resume key"}
                        />
                        <button
                          type="button"
                          onClick={() => handleDeleteKey(apiKey.id)}
                          aria-label={`Delete ${apiKey.name}`}
                          className="muted grid h-8 w-8 place-items-center rounded-lg hover:bg-danger/10 hover:text-danger"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Endpoint card — Local + Tunnel + Tailscale rows (our extras) */}
          <Card>
            <div className="flex items-center gap-2 mb-4">
              <Globe className="h-4 w-4 text-gold-text" aria-hidden="true" />
              <h2 className="text-sm font-semibold">Endpoints</h2>
            </div>
            <div className="flex flex-col gap-2">
              <CodeRow label="Local" value={currentEndpoint} copyId="local_url" copied={copied} onCopy={copy} />

              {/* Cloudflare Tunnel row */}
              <div className="flex items-center gap-2 rounded-lg border border-line bg-bg-soft/60 px-3 py-2">
                <span className={`mono-label shrink-0 min-w-[88px] text-center rounded px-1.5 py-0.5 ${tunnelEnabled ? "bg-gold-soft text-gold-text" : ""}`}>Tunnel</span>
                {tunnelEnabled && !tunnelLoading && tunnelReachable ? (
                  <>
                    <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-main">{`${tunnelPublicUrl || tunnelUrl}/v1`}</code>
                    <CopyButton value={`${tunnelPublicUrl || tunnelUrl}/v1`} label="tunnel_url" />
                    <button
                      type="button"
                      onClick={() => setShowDisableTunnelModal(true)}
                      className="muted grid h-7 w-7 place-items-center rounded-lg hover:bg-danger/10 hover:text-danger"
                      title="Disable Tunnel"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </>
                ) : tunnelEnabled && !tunnelLoading && !tunnelReachable ? (
                  <>
                    <span className="flex flex-1 items-center gap-2 text-xs text-warning">
                      <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      {tunnelEverReachable ? "Tunnel reconnecting…" : "Tunnel checking…"}
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowDisableTunnelModal(true)}
                      className="muted grid h-7 w-7 place-items-center rounded-lg hover:bg-danger/10 hover:text-danger"
                      title="Disable Tunnel"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </>
                ) : tunnelLoading ? (
                  <>
                    <span className="flex flex-1 items-center gap-2 text-xs text-text-muted">
                      <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      {tunnelProgress || "Creating tunnel…"}
                    </span>
                    <button
                      type="button"
                      onClick={() => { pollControllerRef.current?.abort(); pollControllerRef.current = null; setTunnelLoading(false); setTunnelProgress(""); }}
                      className="muted grid h-7 w-7 place-items-center rounded-lg hover:bg-danger/10 hover:text-danger"
                      title="Stop"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </>
                ) : tunnelStatus?.type === "error" ? (
                  <>
                    <span className="flex flex-1 items-center gap-2 text-xs text-danger">
                      <CircleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      {tunnelStatus.message}
                    </span>
                    <Button size="sm" variant="secondary" onClick={() => setShowEnableTunnelModal(true)}>
                      <Cloud className="h-3.5 w-3.5" aria-hidden="true" />
                      Enable
                    </Button>
                  </>
                ) : tunnelChecking ? (
                  <>
                    <span className="flex flex-1 items-center gap-2 text-xs text-text-muted">
                      <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      Checking…
                    </span>
                    <button
                      type="button"
                      onClick={() => setTunnelChecking(false)}
                      className="muted grid h-7 w-7 place-items-center rounded-lg hover:bg-danger/10 hover:text-danger"
                      title="Stop"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </>
                ) : (
                  <Button size="sm" variant="secondary" className="ml-auto" onClick={enableTunnel}>
                    <Cloud className="h-3.5 w-3.5" aria-hidden="true" />
                    Enable
                  </Button>
                )}
              </div>

              {/* Tailscale row */}
              <div className="flex items-center gap-2 rounded-lg border border-line bg-bg-soft/60 px-3 py-2">
                <span className={`mono-label shrink-0 min-w-[88px] text-center rounded px-1.5 py-0.5 ${tsEnabled ? "bg-gold-soft text-gold-text" : ""}`}>Tailscale</span>
                {tsEnabled && !tsLoading && tsReachable ? (
                  <>
                    <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-main">{`${tsUrl}/v1`}</code>
                    <CopyButton value={`${tsUrl}/v1`} label="ts_url" />
                    <button
                      type="button"
                      onClick={() => setShowDisableTsModal(true)}
                      className="muted grid h-7 w-7 place-items-center rounded-lg hover:bg-danger/10 hover:text-danger"
                      title="Disable Tailscale"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </>
                ) : tsEnabled && !tsLoading && !tsReachable ? (
                  <>
                    <span className="flex flex-1 items-center gap-2 text-xs text-warning">
                      <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      {tsEverReachable ? "Tailscale reconnecting…" : "Tailscale checking…"}
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowDisableTsModal(true)}
                      className="muted grid h-7 w-7 place-items-center rounded-lg hover:bg-danger/10 hover:text-danger"
                      title="Disable Tailscale"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </>
                ) : (tsLoading || tsConnecting) ? (
                  <>
                    <span className="flex flex-1 items-center gap-2 text-xs text-text-muted">
                      <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      {tsProgress || "Connecting…"}
                    </span>
                    {tsAuthUrl && (
                      <Button size="sm" variant="secondary" onClick={() => window.open(tsAuthUrl, "tailscale_auth", "width=600,height=700,noopener,noreferrer")}>
                        {tsAuthLabel || "Open"}
                      </Button>
                    )}
                    <button
                      type="button"
                      onClick={() => { setTsLoading(false); setTsConnecting(false); setTsProgress(""); clearUserAuth(); }}
                      className="muted grid h-7 w-7 place-items-center rounded-lg hover:bg-danger/10 hover:text-danger"
                      title="Stop"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </>
                ) : tsStatus?.type === "error" ? (
                  <>
                    <span className="flex flex-1 items-center gap-2 text-xs text-danger">
                      <CircleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      {tsStatus.message}
                    </span>
                    <Button size="sm" variant="secondary" onClick={enableTailscale}>
                      <Globe className="h-3.5 w-3.5" aria-hidden="true" />
                      Enable
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="secondary" className="ml-auto" onClick={enableTailscale}>
                    <Globe className="h-3.5 w-3.5" aria-hidden="true" />
                    Enable
                  </Button>
                )}
              </div>
            </div>

            {/* Security warnings (our extras) */}
            {(isLoginUnsafe && !tunnelEnabled && !tsEnabled) || (tunnelEnabled || tsEnabled) ? (
              <div className="mt-4 flex flex-col gap-2">
                {isLoginUnsafe && !tunnelEnabled && !tsEnabled && (
                  <SecurityWarning message={unsafeReason} action={{ label: "Open settings", href: "/dashboard/profile" }} />
                )}
                {(tunnelEnabled || tsEnabled) && !requireApiKey && (
                  <SecurityWarning
                    message="Require API key is disabled — your endpoint is publicly accessible without authentication."
                    action={{ label: "Enable", href: "#require-api-key" }}
                  />
                )}
                {(tunnelEnabled || tsEnabled) && (!requireLogin || !hasPassword) && (
                  <SecurityWarning
                    message={
                      !requireLogin
                        ? "Require login is disabled — anyone can access your dashboard via tunnel."
                        : "Dashboard uses the default password — change it in Profile settings."
                    }
                    action={{ label: !requireLogin ? "Enable" : "Change password", href: "/dashboard/profile" }}
                  />
                )}
              </div>
            ) : null}

            {/* Tunnel dashboard access toggle (our extra) */}
            {(tunnelEnabled || tsEnabled) && (
              <div className="mt-4 flex items-center gap-3 border-t border-line pt-4">
                <Toggle checked={tunnelDashboardAccess} onChange={() => handleTunnelDashboardAccess(!tunnelDashboardAccess)} />
                <div className="flex items-center gap-1.5">
                  <p className="text-sm font-medium">Allow dashboard access via tunnel</p>
                  <Tooltip text="When enabled, the dashboard can be accessed through your tunnel or Tailscale URL (login still required). When disabled, dashboard access via tunnel/Tailscale is completely blocked." />
                </div>
              </div>
            )}
          </Card>
        </div>

        {/* Right rail — old layout: enforcement card + client setup card + our tunnel dashboard toggle */}
        <div className="space-y-5">
          {/* Require API key card */}
          <Card>
            <h2 className="text-sm font-semibold">Require API key</h2>
            <div className="mt-3 flex items-start justify-between gap-4">
              <p className="muted text-xs leading-relaxed">When enforcement is on, clients must send a valid key. The dashboard stays exempt so it can keep testing models.</p>
              <Toggle checked={requireApiKey} onChange={() => handleRequireApiKey(!requireApiKey)} />
            </div>
            {requireApiKey && keys.length === 0 && !loading && (
              <p className="mt-3 flex items-start gap-2 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[11px] text-danger">
                <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                Enforcement is on and no keys exist, so every client is rejected.
              </p>
            )}
            {requireApiKey && keys.length > 0 && (
              <p className="mt-3 flex items-start gap-2 rounded-lg border border-gold/25 bg-gold-soft px-3 py-2 text-[11px] text-gold-text">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                {activeKeyCount === 0 ? "All keys are paused, so no client can authenticate." : "Clients authenticate with a bearer token on every request."}
              </p>
            )}
          </Card>

          {/* Client setup card — old layout */}
          <Card>
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <Terminal className="h-4 w-4 text-gold-text" aria-hidden="true" />
              Client setup
            </h2>
            <p className="muted mt-1 text-xs">Point any OpenAI-compatible client at the local gateway.</p>
            <div className="mt-3 space-y-2">
              <CodeRow label="Base URL" value={`${currentEndpoint}`} copyId="client_base" copied={copied} onCopy={copy} />
              <CodeRow label="Header" value="Authorization: Bearer &lt;key&gt;" copyId="client_header" />
              <CodeRow label="Also accepted" value="x-api-key: &lt;key&gt;" copyId="client_xkey" />
            </div>
            <p className="muted mt-3 text-[11px] leading-relaxed">
              Keys are never accepted in the query string, and a paused or deleted key stops working immediately.
            </p>
          </Card>
        </div>
      </div>

      {/* Footer — old layout: secrets notice bar */}
      <div className="mt-5 flex flex-col items-start justify-between gap-3 rounded-xl border border-gold/20 bg-gold-soft/45 px-4 py-3.5 sm:flex-row sm:items-center sm:px-5">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-gold-text" aria-hidden="true" />
          <div>
            <p className="text-xs font-semibold">Secrets are hashed, not stored.</p>
            <p className="muted mt-1 text-[11px]">OmniHilbras keeps a SHA-256 hash per key on disk and shows the secret exactly once.</p>
          </div>
        </div>
        <span className="font-mono text-[10px] text-gold-text">local mode · 0600</span>
      </div>

      {/* Add Key Modal */}
      <Modal
        isOpen={showAddModal}
        title="Create API Key"
        onClose={() => {
          setShowAddModal(false);
          setNewKeyName("");
          setCreateKeyError("");
        }}
      >
        <div className="flex flex-col gap-4">
          <Input
            label="Key Name"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            placeholder="Production Key"
          />
          {createKeyError && (
            <p className="text-sm text-red-600 dark:text-red-400">{createKeyError}</p>
          )}
          <div className="flex gap-2">
            <Button onClick={handleCreateKey} fullWidth disabled={!newKeyName.trim()}>
              Create
            </Button>
            <Button
              onClick={() => {
                setShowAddModal(false);
                setNewKeyName("");
              }}
              variant="ghost"
              fullWidth
            >
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      {/* Created Key Modal */}
      <Modal
        isOpen={!!createdKey}
        title="API Key Created"
        onClose={() => setCreatedKey(null)}
      >
        <div className="flex flex-col gap-4">
          <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
            <p className="text-sm text-yellow-800 dark:text-yellow-200 mb-2 font-medium">
              Save this key now!
            </p>
            <p className="text-sm text-yellow-700 dark:text-yellow-300">
              This is the only time you will see this key. Store it securely.
            </p>
          </div>
          <div className="flex gap-2">
            <Input
              value={createdKey || ""}
              readOnly
              className="flex-1 font-mono text-sm"
            />
            <Button
              variant="secondary"
              icon={copied === "created_key" ? "check" : "content_copy"}
              onClick={() => copy(createdKey, "created_key")}
            >
              {copied === "created_key" ? "Copied!" : "Copy"}
            </Button>
          </div>
          <Button onClick={() => setCreatedKey(null)} fullWidth>
            Done
          </Button>
        </div>
      </Modal>

      {/* Enable Tunnel Modal */}
      <Modal
        isOpen={showEnableTunnelModal}
        title="Enable Tunnel"
        onClose={() => setShowEnableTunnelModal(false)}
      >
        <div className="flex flex-col gap-4">
          <div className="bg-surface-2 border border-border-subtle rounded-lg p-4">
            <div className="flex items-start gap-3">
              <span className="material-symbols-outlined text-primary">cloud_upload</span>
              <div>
                <p className="text-sm text-text-main font-medium mb-1">
                  Cloudflare Tunnel
                </p>
                <p className="text-sm text-text-muted">
                  Expose your local OmniHilbras to the internet. No port forwarding, no static IP needed. Share endpoint URL with your team or use it in Cursor, Cline, and other AI tools from anywhere.
                </p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {TUNNEL_BENEFITS.map((benefit) => (
              <div key={benefit.title} className="flex flex-col items-center text-center p-3 rounded-lg bg-sidebar/50">
                <span className="material-symbols-outlined text-xl text-primary mb-1">{benefit.icon}</span>
                <p className="text-xs font-semibold">{benefit.title}</p>
                <p className="text-xs text-text-muted">{benefit.desc}</p>
              </div>
            ))}
          </div>

          <p className="text-xs text-text-muted">
            Requires outbound port 7844 (TCP/UDP). Connection may take 10-30s.
          </p>

          <div className="flex gap-2">
            <Button onClick={handleEnableTunnel} fullWidth>
              Start Tunnel
            </Button>
            <Button onClick={() => setShowEnableTunnelModal(false)} variant="ghost" fullWidth>Cancel</Button>
          </div>
        </div>
      </Modal>

      {/* Disable Cloudflare Tunnel Modal */}
      <Modal
        isOpen={showDisableTunnelModal}
        title="Disable Tunnel"
        onClose={() => !tunnelLoading && setShowDisableTunnelModal(false)}
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-muted">The Cloudflare tunnel will be disconnected. Remote access via tunnel URL will stop working.</p>
          <div className="flex gap-2">
            <Button onClick={handleDisableTunnel} fullWidth disabled={tunnelLoading} variant="danger">
              {tunnelLoading ? "Disabling..." : "Disable"}
            </Button>
            <Button onClick={() => setShowDisableTunnelModal(false)} variant="ghost" fullWidth disabled={tunnelLoading}>Cancel</Button>
          </div>
        </div>
      </Modal>

      {/* Tailscale Modal */}
      <Modal
        isOpen={showTsModal}
        title="Tailscale Funnel"
        onClose={() => { if (!tsInstalling) { setShowTsModal(false); setTsSudoPassword(""); setTsStatus(null); } }}
      >
        <div className="flex flex-col gap-4">
          {/* Checking state */}
          {tsInstalled === null && (
            <p className="text-sm text-text-muted flex items-center gap-2">
              <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
              Checking...
            </p>
          )}

          {/* Not installed */}
          {tsInstalled === false && !tsInstalling && (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-text-muted">Tailscale is not installed. Install it to enable Funnel.</p>
              <div className="flex gap-2">
                <Button onClick={handleInstallTailscale} fullWidth>
                  Install Tailscale
                </Button>
                <Button onClick={() => setShowTsModal(false)} variant="ghost" fullWidth>Cancel</Button>
              </div>
            </div>
          )}

          {/* Installing with progress log */}
          {tsInstalling && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-sm text-text-muted">
                <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                Installing Tailscale...
              </div>
              {tsInstallLog.length > 0 && (
                <div ref={tsLogRef} className="bg-black/5 dark:bg-white/5 rounded p-2 max-h-40 overflow-y-auto font-mono text-xs text-text-muted">
                  {tsInstallLog.map((line, i) => (
                    <div key={i}>{line}</div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Installed: show Connect button */}
          {tsInstalled === true && !tsInstalling && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
                <span className="material-symbols-outlined text-[16px]">check_circle</span>
                Tailscale installed
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={() => handleConnectTailscale()}
                  fullWidth
                >
                  Connect
                </Button>
                <Button onClick={() => setShowTsModal(false)} variant="ghost" fullWidth>Cancel</Button>
              </div>
            </div>
          )}

          {tsStatus && <StatusAlert status={tsStatus} />}
        </div>
      </Modal>

      {/* Disable Tailscale Modal */}
      <Modal
        isOpen={showDisableTsModal}
        title="Disable Tailscale"
        onClose={() => !tsLoading && setShowDisableTsModal(false)}
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-muted">Tailscale Funnel will be stopped. Remote access via Tailscale URL will stop working.</p>
          <div className="flex gap-2">
            <Button onClick={handleDisableTailscale} fullWidth disabled={tsLoading} variant="danger">
              {tsLoading ? "Disabling..." : "Disable"}
            </Button>
            <Button onClick={() => setShowDisableTsModal(false)} variant="ghost" fullWidth disabled={tsLoading}>Cancel</Button>
          </div>
        </div>
      </Modal>

      {/* Confirm Modal */}
      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || "Confirm"}
        message={confirmState?.message}
        variant="danger"
      />
    </div>
  );
}
