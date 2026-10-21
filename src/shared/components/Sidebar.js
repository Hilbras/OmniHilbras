"use client";

import { useState, useEffect, useRef } from "react";
import PropTypes from "prop-types";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/shared/utils/cn";
import { APP_CONFIG, UPDATER_CONFIG } from "@/shared/constants/config";
import { MEDIA_PROVIDER_KINDS } from "@/shared/constants/providers";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { useGatewayStatus } from "@/shared/hooks/useGatewayStatus";
import useSettingsStore from "@/store/settingsStore";
import Button from "./Button";
import { ConfirmModal } from "./Modal";

// const VISIBLE_MEDIA_KINDS = ["embedding", "image", "imageToText", "tts", "stt", "webSearch", "webFetch", "video", "music"];
const VISIBLE_MEDIA_KINDS = ["embedding", "image", "video", "tts", "stt", "systemone"];
// Combined entry: webSearch + webFetch share one page at /dashboard/media-providers/web
const COMBINED_WEB_ITEM = { id: "web", label: "Web Fetch & Search", icon: "travel_explore", href: "/dashboard/media-providers/web" };

// The rail is grouped the way the workspace is used: what you set up, what you
// watch, and the tools around it.
const workspaceItems = [
  { href: "/dashboard/endpoint", label: "Endpoint and Keys", icon: "api" },
  { href: "/dashboard/providers", label: "Providers", icon: "dns" },
  { href: "/dashboard/combos", label: "Routing", icon: "layers" },
];

const insightItems = [
  { href: "/dashboard/usage", label: "Usage", icon: "bar_chart" },
  { href: "/dashboard/quota", label: "Quota Tracker", icon: "data_usage" },
  { href: "/dashboard/token-saver", label: "Token Saver", icon: "savings" },
  { href: "/dashboard/console-log", label: "Logs", icon: "terminal" },
  // The request log is a tab of the usage page, not a page of its own.
  { href: "/dashboard/usage?tab=logs", label: "Request log", icon: "scroll_text" },
  { href: "/dashboard/profile", label: "Settings", icon: "settings" },
];

const toolItems = [
  { href: "/dashboard/cli-tools", label: "CLI Tools", icon: "terminal" },
  { href: "/dashboard/translator", label: "Translator", icon: "translate", needsTranslator: true },
  { href: "/dashboard/proxy-pools", label: "Proxy Pools", icon: "lan" },
  { href: "/dashboard/skills", label: "Skills", icon: "extension" },
];

export default function Sidebar({ onClose, collapsed = false, onToggleCollapse }) {
  const pathname = usePathname();
  const [mediaOpen, setMediaOpen] = useState(false);
  const [isDisconnected, setIsDisconnected] = useState(false);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [shutdownCountdown, setShutdownCountdown] = useState(0);
  const [enableTranslator, setEnableTranslator] = useState(false);
  const { copied, copy } = useCopyToClipboard(2000);
  const shutdownTimerRef = useRef(null);

  const INSTALL_CMD = UPDATER_CONFIG.installCmdLatest;

  // The badge asks the gateway rather than asserting it: a page whose only
  // request already failed makes no further requests, so nothing would ever
  // notice the gateway coming back.
  const { reachable, problem, buildVersion } = useGatewayStatus();
  const gatewayUp = reachable !== false;
  // A refusal is not an outage, and the wording has to say which one it is.
  const gatewayLabel =
    reachable === undefined
      ? "Checking gateway"
      : reachable
        ? "Gateway online"
        : problem === "refused"
          ? "Gateway refused this page"
          : problem === "unauthorized"
            ? "Gateway needs sign-in"
            : "Gateway offline";
  const gatewayHint =
    reachable === false
      ? problem === "refused"
        ? "this page's origin is not allowed"
        : problem === "unauthorized"
          ? "gateway is up · dashboard token not accepted, reload the dashboard"
          : "not answering · is the gateway running?"
      : `${hostLabel()} · build ${buildVersion ?? "unknown"}`;

  // The countdown must not outlive the page: a gateway that shuts itself down
  // after the user navigated away takes the whole app with it.
  useEffect(() => () => {
    if (shutdownTimerRef.current) clearInterval(shutdownTimerRef.current);
  }, []);

  useEffect(() => {
    useSettingsStore.getState().fetchSettings().then((data) => {
      if (data?.enableTranslator) setEnableTranslator(true);
    });
  }, []);

  // Lazy check for new npm version in background after initial render
  useEffect(() => {
    const timer = setTimeout(() => {
      fetch("/api/version")
        .then(res => res.json())
        .then(data => { if (data.hasUpdate) setUpdateInfo(data); })
        .catch(() => {});
    }, 2500);
    return () => clearTimeout(timer);
  }, []);

  // Which entry of the rail is the one on screen.
  //
  // The rail highlights the page, not the tab: the request log is a tab of the
  // usage page, so "Usage" stays lit while "Request log" is open. The sidebar
  // lives in the layout, and reading the search params there would force every
  // dashboard page to be rendered dynamically.
  const isActive = (item) => {
    const href = item.href.split("?")[0];
    if (href === "/dashboard/endpoint") {
      return pathname === "/dashboard" || pathname.startsWith("/dashboard/endpoint");
    }
    return pathname.startsWith(href);
  };

  // Open manual update panel (no countdown yet — user must click Copy to trigger shutdown)
  const handleUpdate = () => {
    setShowUpdateModal(false);
    setIsUpdating(true);
  };

  // Triggered by Copy button inside ManualUpdatePanel: copy + countdown + shutdown
  const handleCopyAndShutdown = async () => {
    try { await navigator.clipboard.writeText(INSTALL_CMD); } catch { /* clipboard blocked */ }
    copy(INSTALL_CMD);
    let remaining = UPDATER_CONFIG.shutdownCountdownSec;
    setShutdownCountdown(remaining);
    if (shutdownTimerRef.current) clearInterval(shutdownTimerRef.current);
    shutdownTimerRef.current = setInterval(() => {
      remaining -= 1;
      setShutdownCountdown(remaining);
      if (remaining <= 0) {
        clearInterval(shutdownTimerRef.current);
        shutdownTimerRef.current = null;
        fetch("/api/version/shutdown", { method: "POST" }).catch(() => {});
        setIsDisconnected(true);
      }
    }, 1000);
  };

  const handleCancelUpdate = () => {
    if (shutdownTimerRef.current) {
      clearInterval(shutdownTimerRef.current);
      shutdownTimerRef.current = null;
    }
    setIsUpdating(false);
    setShutdownCountdown(0);
  };

  return (
    <>
      <aside
        className={`dashboard-sidebar flex h-full w-[252px] shrink-0 flex-col border-r border-line bg-bg-soft transition-[width] duration-200 ${collapsed ? "lg:w-[76px]" : "lg:w-[252px]"}`}
      >
        {/* Brand + collapse toggle */}
        <div className={`flex items-center gap-1 pb-4 pt-5 ${collapsed ? "justify-center px-2" : "justify-between px-5"}`}>
          <button
            type="button"
            onClick={() => {
              onClose?.();
              onToggleCollapse?.();
            }}
            className={`group flex items-center gap-2.5 rounded-lg p-1 text-[15px] font-semibold tracking-tight ${collapsed ? "justify-center" : "flex-1 justify-between"}`}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <span className="relative grid h-8 w-8 shrink-0 place-items-center rounded-[10px] border border-gold/25 bg-gold-soft text-lg text-gold-text" aria-hidden="true">
              <span className={collapsed ? "transition-opacity group-hover:opacity-0" : ""}>◈</span>
              {collapsed && (
                <span className="material-symbols-outlined absolute h-4 w-4 text-[16px] opacity-0 transition-opacity group-hover:opacity-100">
                  left_panel_open
                </span>
              )}
            </span>
            {!collapsed && (
              <span className="flex min-w-0 flex-1 flex-col items-start">
                <span className="text-[15px] font-semibold tracking-tight">
                  Omni<span className="muted font-normal">Hilbras</span>
                </span>
                <span className="mono-label">v{APP_CONFIG.version}</span>
              </span>
            )}
            {!collapsed && (
              <span className="material-symbols-outlined ml-auto h-4 w-4 shrink-0 text-[16px] text-muted" aria-hidden="true">
                left_panel_close
              </span>
            )}
          </button>
          {!collapsed && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close navigation"
              className="muted grid h-8 w-8 place-items-center rounded-lg hover:bg-surface hover:text-gold-text lg:hidden"
            >
              <span className="material-symbols-outlined text-[18px]">close</span>
            </button>
          )}
        </div>

        {/* The badge asks the gateway rather than asserting it. */}
        <div
          className={`mx-4 mb-5 rounded-xl border ${gatewayUp ? "border-success/20 bg-success/10" : "border-danger/30 bg-danger/10"} ${collapsed ? "flex justify-center p-2.5" : "p-3"}`}
          title={collapsed ? `${gatewayLabel} · ${hostLabel()}` : undefined}
          aria-label={gatewayLabel}
        >
          <div className={`flex items-center ${collapsed ? "justify-center" : "gap-2"}`}>
            <span className="relative flex h-2 w-2">
              {gatewayUp && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />}
              <span className={`relative inline-flex h-2 w-2 rounded-full ${gatewayUp ? "bg-success" : "bg-danger"}`} />
            </span>
            {!collapsed && <span className={`text-xs font-semibold ${gatewayUp ? "text-success" : "text-danger"}`}>{gatewayLabel}</span>}
          </div>
          {!collapsed && (
            <p className="mt-1.5 pl-4 font-mono text-[10px] text-muted" title={gatewayHint}>
              {gatewayHint}
            </p>
          )}
        </div>

        {/* Update badge — hidden when collapsed (no room for the copy affordance) */}
        {!collapsed && updateInfo && (
          <div className="px-4 pb-5">
            <div className="flex flex-col gap-1.5 rounded-lg border border-gold/25 bg-gold-soft/60 p-2.5">
              <span className="text-xs font-semibold text-gold-text">
                ↑ New version available: v{updateInfo.latestVersion}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowUpdateModal(true)}
                  className="btn-gold !px-2.5 !py-1.5 !text-[11px]"
                >
                  Update now
                </button>
                <button
                  onClick={() => copy(INSTALL_CMD)}
                  title="Copy install command"
                  className="flex-1 text-left hover:opacity-80 transition-opacity cursor-pointer min-w-0"
                >
                  <code className="block text-[10px] text-gold-text/70 font-mono truncate">
                    {copied ? "✓ copied!" : INSTALL_CMD}
                  </code>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Navigation */}
        <nav className={`dashboard-scroll flex-1 overflow-y-auto ${collapsed ? "px-2" : "px-3"}`} aria-label="Dashboard navigation">
          {!collapsed && <p className="mono-label px-3 pb-2">Workspace</p>}
          {collapsed && <div className="h-5" aria-hidden="true" />}
          <div className="space-y-1">
            {workspaceItems.map((item) => (
              <NavItem key={item.href} item={item} active={isActive(item)} collapsed={collapsed} onNavigate={onClose} />
            ))}
          </div>

          {!collapsed && <p className="mono-label px-3 pb-2 pt-7">Insights</p>}
          {collapsed && <div className="h-6" aria-hidden="true" />}
          <div className="space-y-1">
            {insightItems.map((item) => (
              <NavItem key={item.href} item={item} active={isActive(item)} collapsed={collapsed} onNavigate={onClose} />
            ))}
          </div>

          {!collapsed && <p className="mono-label px-3 pb-2 pt-7">Tools</p>}
          {collapsed && <div className="h-6" aria-hidden="true" />}
          <div className="space-y-1">
            {toolItems
              .filter((item) => !item.needsTranslator || enableTranslator)
              .map((item) => (
                <NavItem key={item.href} item={item} active={isActive(item)} collapsed={collapsed} onNavigate={onClose} />
              ))}

            {/* Media Providers accordion */}
            <button
              onClick={() => setMediaOpen((v) => !v)}
              title={collapsed ? "Media Providers" : undefined}
              aria-label={collapsed ? "Media Providers" : undefined}
              aria-expanded={mediaOpen}
              className={cn(
                "group flex w-full items-center rounded-lg transition-colors",
                collapsed ? "justify-center px-2 py-2.5" : "gap-3 px-3 py-2",
                pathname.startsWith("/dashboard/media-providers")
                  ? "bg-gold-soft text-gold-text"
                  : "text-text-muted hover:bg-surface hover:text-text-main"
              )}
            >
              <span className="material-symbols-outlined shrink-0 text-[17px]">perm_media</span>
              {!collapsed && (
                <>
                  <span className="text-[13px] font-medium flex-1 text-left">Media Providers</span>
                  <span className="material-symbols-outlined text-[14px] transition-transform" style={{ transform: mediaOpen ? "rotate(180deg)" : "rotate(0deg)" }}>
                    expand_more
                  </span>
                </>
              )}
            </button>
            {mediaOpen && !collapsed && (
              <div className="pl-4">
                {MEDIA_PROVIDER_KINDS.filter((k) => VISIBLE_MEDIA_KINDS.includes(k.id)).map((kind) => (
                  <Link
                    key={kind.id}
                    href={`/dashboard/media-providers/${kind.id}`}
                    onClick={onClose}
                    className={cn(
                      "flex items-center gap-3 px-4 py-1 rounded-lg transition-all group",
                      pathname.startsWith(`/dashboard/media-providers/${kind.id}`)
                        ? "bg-gold-soft text-gold-text"
                        : "text-text-muted hover:bg-surface hover:text-text-main"
                    )}
                  >
                    <span className="material-symbols-outlined text-[16px]">{kind.icon}</span>
                    <span className="text-sm">{kind.label}</span>
                  </Link>
                ))}
                <Link
                  key={COMBINED_WEB_ITEM.id}
                  href={COMBINED_WEB_ITEM.href}
                  onClick={onClose}
                  className={cn(
                    "flex items-center gap-3 px-4 py-1 rounded-lg transition-all group",
                    pathname.startsWith(COMBINED_WEB_ITEM.href)
                      ? "bg-gold-soft text-gold-text"
                      : "text-text-muted hover:bg-surface hover:text-text-main"
                  )}
                >
                  <span className="material-symbols-outlined text-[16px]">{COMBINED_WEB_ITEM.icon}</span>
                  <span className="text-sm">{COMBINED_WEB_ITEM.label}</span>
                </Link>
              </div>
            )}

            {/* Remote */}
            <a
              href="https://9remote.cc"
              target="_blank"
              rel="noreferrer"
              onClick={onClose}
              title={collapsed ? "9Remote" : undefined}
              aria-label={collapsed ? "9Remote" : undefined}
              className={cn(
                "group flex w-full items-center rounded-lg transition-colors",
                collapsed ? "justify-center px-2 py-2.5" : "gap-3 px-3 py-2",
                "text-text-muted hover:bg-surface hover:text-text-main"
              )}
            >
              <span className="material-symbols-outlined shrink-0 text-[17px] group-hover:text-gold-text transition-colors">
                computer
              </span>
              {!collapsed && (
                <>
                  <span className="text-[13px] font-medium">9Remote</span>
                  <span className="ml-auto text-[10px] font-semibold px-1.5 py-0.5 rounded-[3px] bg-gold-soft text-gold-text">
                    HOT
                  </span>
                </>
              )}
            </a>

            {/* 9English */}
            <a
              href="https://9english.net/"
              target="_blank"
              rel="noreferrer"
              onClick={onClose}
              title={collapsed ? "9English" : undefined}
              aria-label={collapsed ? "9English" : undefined}
              className={cn(
                "group flex w-full items-center rounded-lg transition-colors",
                collapsed ? "justify-center px-2 py-2.5" : "gap-3 px-3 py-2",
                "text-text-muted hover:bg-surface hover:text-text-main"
              )}
            >
              <span className="material-symbols-outlined shrink-0 text-[17px] group-hover:text-gold-text transition-colors">
                translate
              </span>
              {!collapsed && <span className="text-[13px] font-medium">9English</span>}
            </a>
          </div>

          {/* The way in: a provider is what everything else routes through. */}
          <div className={`mt-8 border-t border-line/70 pt-5 ${collapsed ? "px-1" : ""}`}>
            <Link
              href="/dashboard/providers"
              onClick={onClose}
              className={cn(
                "group block rounded-xl border border-gold/25 bg-gold-soft/60 transition-colors hover:border-gold/50",
                collapsed ? "flex justify-center p-3" : "p-3.5"
              )}
              title={collapsed ? "Connect a provider" : undefined}
              aria-label={collapsed ? "Connect a provider" : undefined}
            >
              <div className={cn("items-center gap-2 text-xs font-semibold text-gold-text", collapsed ? "flex justify-center" : "flex")}>
                <span className="material-symbols-outlined text-[14px]" aria-hidden="true">deployed_code</span>
                {!collapsed && "Connect a provider"}
              </div>
              {!collapsed && (
                <>
                  <p className="muted mt-1.5 text-[11px] leading-relaxed">
                    Bring your first route online in under a minute.
                  </p>
                  <span className="mt-2 inline-flex items-center gap-1 text-[10px] font-semibold text-gold-text">
                    Quick setup
                    <span className="material-symbols-outlined text-[12px] transition-transform group-hover:translate-x-0.5" aria-hidden="true">chevron_right</span>
                  </span>
                </>
              )}
            </Link>
          </div>
        </nav>

        {/* Who you are working with: the gateway runs on this machine. */}
        <div className={`border-t border-line/70 ${collapsed ? "p-3" : "p-4"}`}>
          <div className={`flex items-center ${collapsed ? "justify-center" : "gap-2.5"}`} title={collapsed ? "Local workspace · no account required" : undefined}>
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-gold/30 bg-gold-soft text-[10px] font-bold text-gold-text">OH</span>
            {!collapsed && (
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold">Local workspace</p>
                <p className="muted truncate text-[10px]">No account required</p>
              </div>
            )}
            {!collapsed && (
              <span className="material-symbols-outlined ml-auto h-4 w-4 shrink-0 text-muted" aria-label="Local mode help">
                help
              </span>
            )}
          </div>
        </div>
      </aside>

      {/* Update Confirmation Modal */}
      <ConfirmModal
        isOpen={showUpdateModal}
        onClose={() => setShowUpdateModal(false)}
        onConfirm={handleUpdate}
        title="Update OmniHilbras"
        message={`Show install command for v${updateInfo?.latestVersion || ""}? You can copy it and shutdown to install manually.`}
        confirmText="Show Command"
        cancelText="Cancel"
        variant="primary"
      />

      {/* Disconnected / Updating Overlay */}
      {(isDisconnected || isUpdating) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6">
          {isUpdating ? (
            <ManualUpdatePanel
              latestVersion={updateInfo?.latestVersion}
              installCmd={INSTALL_CMD}
              copied={copied}
              onCopyAndShutdown={handleCopyAndShutdown}
              onCancel={handleCancelUpdate}
              countdown={shutdownCountdown}
              isDisconnected={isDisconnected}
            />
          ) : (
            <div className="text-center p-8">
              <div className="flex items-center justify-center size-16 rounded-full bg-red-500/20 text-red-500 mx-auto mb-4">
                <span className="material-symbols-outlined text-[32px]">power_off</span>
              </div>
              <h2 className="text-xl font-semibold text-white mb-2">Server Disconnected</h2>
              <p className="text-text-muted mb-6">The proxy server has been stopped.</p>
              <Button variant="secondary" onClick={() => globalThis.location.reload()}>
                Reload Page
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

/**
 * One entry of the rail.
 *
 * The label is hidden when the rail is collapsed, and the icon carries the
 * name then — as a title and as the accessible name, so the entry is never an
 * unlabelled button. The active entry keeps the chevron the old project had.
 */
function NavItem({ item, active, collapsed, onNavigate }) {
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      title={collapsed ? item.label : undefined}
      aria-label={collapsed ? item.label : undefined}
      className={cn(
        "group flex w-full items-center rounded-lg transition-colors",
        collapsed ? "justify-center px-2 py-2.5" : "gap-3 px-3 py-2",
        active
          ? "bg-gold-soft text-gold-text"
          : "text-text-muted hover:bg-surface hover:text-text-main"
      )}
      aria-current={active ? "page" : undefined}
    >
      <span
        className={cn(
          "material-symbols-outlined shrink-0 text-[17px]",
          active ? "fill-1" : "group-hover:text-gold-text transition-colors"
        )}
      >
        {item.icon}
      </span>
      {!collapsed && <span className="text-[13px] font-medium flex-1 text-left">{item.label}</span>}
      {!collapsed && active && (
        <span className="material-symbols-outlined h-3.5 w-3.5 opacity-60" aria-hidden="true">
          chevron_right
        </span>
      )}
    </Link>
  );
}

NavItem.propTypes = {
  item: PropTypes.shape({
    href: PropTypes.string.isRequired,
    label: PropTypes.string.isRequired,
    icon: PropTypes.string.isRequired,
  }).isRequired,
  active: PropTypes.bool,
  collapsed: PropTypes.bool,
  onNavigate: PropTypes.func,
};

// The host the dashboard is talking to, for the badge's hint line.
function hostLabel() {
  if (typeof window === "undefined") return "localhost";
  return window.location.host;
}

Sidebar.propTypes = {
  onClose: PropTypes.func,
  collapsed: PropTypes.bool,
  onToggleCollapse: PropTypes.func,
};

function ManualUpdatePanel({ latestVersion, installCmd, copied, onCopyAndShutdown, onCancel, countdown, isDisconnected }) {
  const isCountingDown = countdown > 0;
  return (
    <div className="w-full max-w-lg rounded-xl bg-neutral-900/95 border border-white/10 p-6 text-white">
      <div className="flex items-center gap-3 mb-4">
        <div className="flex items-center justify-center size-11 rounded-full bg-amber-500/20 text-amber-400">
          <span className="material-symbols-outlined text-[24px]">content_copy</span>
        </div>
        <div>
          <h2 className="text-lg font-semibold">Update OmniHilbras{latestVersion ? ` to v${latestVersion}` : ""}</h2>
          <p className="text-xs text-white/60">
            {isDisconnected
              ? "Server stopped. Paste the command into a terminal to install."
              : isCountingDown
                ? `Command copied. Server will stop in ${countdown}s...`
                : "Click the button below to copy the install command and shutdown."}
          </p>
        </div>
      </div>

      <p className="text-sm text-white/80 mb-2">Install command:</p>
      <div className="w-full px-3 py-2 rounded bg-white/5 mb-4">
        <code className="text-xs font-mono text-amber-400 break-all">{installCmd}</code>
      </div>

      <ol className="text-xs text-white/70 space-y-1 list-decimal list-inside mb-4">
        <li>Click <strong>Copy &amp; Shutdown</strong> below.</li>
        <li>Paste the command into your terminal and press Enter.</li>
        <li>Run <code className="px-1 rounded bg-white/10 text-green-400">omnihilbras</code> again after install.</li>
      </ol>

      {isDisconnected ? (
        <Button variant="secondary" fullWidth onClick={() => globalThis.location.reload()}>
          Reload Page
        </Button>
      ) : (
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={isCountingDown}>
            Cancel
          </Button>
          <Button variant="primary" fullWidth onClick={onCopyAndShutdown} disabled={isCountingDown}>
            {copied ? "✓ Copied — shutting down..." : isCountingDown ? `Shutting down in ${countdown}s` : "Copy & Shutdown"}
          </Button>
        </div>
      )}
    </div>
  );
}

ManualUpdatePanel.propTypes = {
  latestVersion: PropTypes.string,
  installCmd: PropTypes.string.isRequired,
  copied: PropTypes.bool,
  onCopyAndShutdown: PropTypes.func.isRequired,
  onCancel: PropTypes.func.isRequired,
  countdown: PropTypes.number,
  isDisconnected: PropTypes.bool,
};
