"use client";

import { useState, useEffect, useRef } from "react";
import PropTypes from "prop-types";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  Cable,
  ChevronDown,
  ChevronRight,
  Cpu,
  Copy,
  Database,
  FileText,
  Gauge,
  Globe,
  Languages,
  Layers,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  PiggyBank,
  Plus,
  Power,
  Puzzle,
  Search,
  Settings,
  SquareTerminal,
  Video,
  X,
  Zap,
} from "lucide-react";
import { cn } from "@/shared/utils/cn";
import { APP_CONFIG, UPDATER_CONFIG } from "@/shared/constants/config";
import { MEDIA_PROVIDER_KINDS } from "@/shared/constants/providers";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import useSettingsStore from "@/store/settingsStore";
import { useWorkspaceStore } from "@/store/workspaceStore";
import Button from "./Button";
import { ConfirmModal } from "./Modal";

const DEFAULT_WORKSPACE_ID = "default";

// const VISIBLE_MEDIA_KINDS = ["embedding", "image", "imageToText", "tts", "stt", "webSearch", "webFetch", "video", "music"];
const VISIBLE_MEDIA_KINDS = ["embedding", "image", "video", "tts", "stt", "systemone"];
// Maps the legacy material-icon strings used by MEDIA_PROVIDER_KINDS to lucide components
const MEDIA_ICON_MAP = {
  data_array: Database,
  brush: Cpu,
  image_search: Search,
  record_voice_over: Zap,
  mic: Cpu,
  travel_explore: Globe,
  language: Languages,
  movie: Video,
  music_note: FileText,
  psychology: Puzzle,
};
// Combined entry: webSearch + webFetch share one page at /dashboard/media-providers/web
const COMBINED_WEB_ITEM = { id: "web", label: "Web Fetch & Search", icon: Globe, href: "/dashboard/media-providers/web" };

const navItems = [
  { href: "/dashboard/endpoint", label: "Endpoint & Key", icon: Cpu },
  { href: "/dashboard/providers", label: "Providers", icon: Network },
  // { href: "/dashboard/basic-chat", label: "Basic Chat", icon: chat }, // Hidden
  { href: "/dashboard/combos", label: "Combo & Vision Adapter", icon: Layers },
  { href: "/dashboard/usage", label: "Usage", icon: Gauge },
  { href: "/dashboard/observability", label: "Observability", icon: Activity },
  { href: "/dashboard/quota", label: "Quota Tracker", icon: PiggyBank },
  { href: "/dashboard/token-saver", label: "Token Saver", icon: PiggyBank },
  // { href: "/dashboard/pxpipe", label: "PXPIPE", icon: image },
  { href: "/dashboard/cli-tools", label: "CLI Tools", icon: SquareTerminal },
];

const systemItems = [
  { href: "/dashboard/proxy-pools", label: "Proxy Pools", icon: Cable },
  { href: "/dashboard/skills", label: "Skills", icon: Puzzle },
  { href: "/dashboard/settings/workspaces", label: "Workspaces", icon: Database },
];

const debugItems = [
  { href: "/dashboard/console-log", label: "Console Log", icon: FileText },
  { href: "/dashboard/translator", label: "Translator", icon: Languages },
];

function useGatewayStatus() {
  // Polls the health endpoint so the badge reports what the server is actually
  // doing — a hardcoded "online" string would have said the one thing that was
  // false for exactly as long as the outage lasted.
  const [status, setStatus] = useState({ reachable: undefined, hint: "Checking gateway" });
  useEffect(() => {
    let alive = true;
    const probe = async () => {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        if (!alive) return;
        setStatus({ reachable: true, hint: `gateway online · build ${APP_CONFIG.version}` });
      } catch {
        if (!alive) return;
        setStatus({ reachable: false, hint: "gateway not answering · restart the server" });
      }
    };
    probe();
    const timer = setInterval(probe, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  return status;
}

function NavRow({
  icon: Icon,
  label,
  active = false,
  collapsed = false,
  pending = false,
  badge,
  title,
}) {
  const iconEl = Icon ? <Icon className="h-[17px] w-[17px] shrink-0" aria-hidden="true" /> : null;

  const content = (
    <>
      {iconEl && (
        <span className={cn("shrink-0", active ? "text-gold-text" : "text-text-muted")}>
          {iconEl}
        </span>
      )}
      {!collapsed && <span className="flex-1 text-left truncate">{label}</span>}
      {badge && !collapsed && (
        <span className="rounded-full border border-line-strong px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-text-muted">
          {badge}
        </span>
      )}
    </>
  );

  const baseClass = collapsed
    ? "group flex w-full items-center justify-center rounded-lg px-2 py-2.5 transition-colors"
    : "group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[13px] font-medium transition-colors";

  if (pending) {
    return (
      <button
        type="button"
        disabled
        className={`${baseClass} cursor-not-allowed text-text-subtle`}
        title={collapsed ? `${label} · coming soon` : "Coming soon"}
        aria-label={`${label}, coming soon`}
      >
        {content}
      </button>
    );
  }

  // External links (https://…) open in a new tab
  if (typeof title === "object" && title.href && /^https?:\/\//.test(title.href)) {
    return (
      <a
        href={title.href}
        target="_blank"
        rel="noreferrer"
        onClick={title.onClick}
        className={cn(baseClass, "text-text-muted hover:bg-surface hover:text-text-main")}
        aria-label={collapsed ? label : undefined}
        title={collapsed ? label : undefined}
      >
        {content}
      </a>
    );
  }

  // Internal links use next/link so they navigate within the SPA
  return (
    <Link
      href={title?.href ?? "#"}
      onClick={title?.onClick}
      className={cn(
        baseClass,
        active ? "bg-gold-soft text-gold-text" : "text-text-muted hover:bg-surface hover:text-text-main"
      )}
      aria-current={active ? "page" : undefined}
      aria-label={collapsed ? label : undefined}
      title={collapsed ? label : undefined}
    >
      {content}
    </Link>
  );
}

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
  const { reachable, hint } = useGatewayStatus();

  const INSTALL_CMD = UPDATER_CONFIG.installCmdLatest;

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

  const isActive = (href) => {
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

  // Note: legacy updater poll removed. New flow: copy install cmd + shutdown server,
  // user runs the command manually in another terminal.

  const linkProps = (item) => ({ href: item.href, onClick: onClose });

  return (
    <>
      <aside
        className={cn(
          "dashboard-sidebar flex h-full flex-col border-r border-line bg-bg-soft transition-[width] duration-200",
          collapsed ? "w-[76px] lg:w-[76px]" : "w-[252px] lg:w-[252px]"
        )}
      >
        {/* Logo + collapse toggle */}
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
                <PanelLeftOpen className="absolute h-4 w-4 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
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
              <PanelLeftClose className="ml-auto h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
            )}
          </button>
          {!collapsed && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close navigation"
              className="muted grid h-8 w-8 place-items-center rounded-lg hover:bg-surface hover:text-gold-text lg:hidden"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>

        {/* Gateway status badge — polls /api/health rather than asserting a static string */}
        <div
          className={cn(
            "mx-4 mb-5 rounded-xl border",
            reachable !== false ? "border-success/20 bg-success/10" : "border-danger/30 bg-danger/10",
            collapsed ? "flex justify-center p-2.5" : "p-3"
          )}
          title={collapsed ? hint : undefined}
          aria-label={hint}
        >
          <div className={cn("flex items-center", collapsed ? "justify-center" : "gap-2")}>
            <span className="relative flex h-2 w-2">
              {reachable === true && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />}
              <span className={`relative inline-flex h-2 w-2 rounded-full ${reachable !== false ? "bg-success" : "bg-danger"}`} />
            </span>
            {!collapsed && <span className={`text-xs font-semibold ${reachable !== false ? "text-success" : "text-danger"}`}>
              {reachable === undefined ? "Checking gateway" : reachable ? "Gateway online" : "Gateway offline"}
            </span>}
          </div>
          {!collapsed && (
            <p className="mt-1.5 pl-4 font-mono text-[10px] text-text-muted" title={hint}>
              {hint}
            </p>
          )}
        </div>

        {/* Update badge — same pill style as the gateway badge, compact enough to stay visible when collapsed */}
        {updateInfo && (
          <div
            className={cn(
              "mx-4 mb-4 rounded-xl border border-warning/30 bg-warning/10",
              collapsed ? "flex justify-center p-2.5" : "p-3"
            )}
            title={collapsed ? `New version v${updateInfo.latestVersion}` : undefined}
            aria-label={`New version available: ${updateInfo.latestVersion}`}
          >
            <div className={cn("flex items-center", collapsed ? "justify-center" : "gap-2")}>
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-warning opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-warning" />
              </span>
              {!collapsed && <span className="text-xs font-semibold text-warning">New version: v{updateInfo.latestVersion}</span>}
            </div>
            {!collapsed && (
              <p className="mt-1.5 pl-4 font-mono text-[10px] text-text-muted">
                {copied ? "✓ copied" : INSTALL_CMD}
              </p>
            )}
            {!collapsed && (
              <div className="mt-2 pl-4">
                <button
                  onClick={() => setShowUpdateModal(true)}
                  className="btn-gold !px-2.5 !py-1.5 !text-[11px]"
                >
                  Update now
                </button>
              </div>
            )}
          </div>
        )}

        {/* Navigation */}
        <nav className={cn("dashboard-scroll flex-1 overflow-y-auto", collapsed ? "px-2" : "px-3")} aria-label="Dashboard navigation">
          {!collapsed && <p className="mono-label px-3 pb-2">Workspace</p>}
          {collapsed && <div className="h-4" aria-hidden="true" />}
          <div className="space-y-0.5">
            {navItems.map((item) => (
              <NavRow
                key={item.href}
                icon={item.icon}
                label={item.label}
                active={isActive(item.href)}
                collapsed={collapsed}
                title={linkProps(item)}
              />
            ))}
          </div>

          {/* System section */}
          {!collapsed && <p className="mono-label px-3 pb-2 pt-7">System</p>}
          {collapsed && <div className="mx-2 my-2 border-t border-line/70" aria-hidden="true" />}
          <div className="space-y-0.5">
            {/* Media Providers accordion */}
            <button
              onClick={() => setMediaOpen((v) => !v)}
              title={collapsed ? "Media Providers" : undefined}
              aria-label={collapsed ? "Media Providers" : undefined}
              aria-expanded={mediaOpen}
              className={cn(
                "group flex w-full items-center rounded-lg transition-colors",
                collapsed ? "justify-center px-2 py-2.5" : "gap-3 px-3 py-2 text-left text-[13px] font-medium",
                pathname.startsWith("/dashboard/media-providers")
                  ? "bg-gold-soft text-gold-text"
                  : "text-text-muted hover:bg-surface hover:text-text-main"
              )}
            >
              <span className="shrink-0 text-text-muted" aria-hidden="true"><Cpu className="h-[17px] w-[17px]" /></span>
              {!collapsed && (
                <>
                  <span className="flex-1">Media Providers</span>
                  <ChevronDown
                    className="h-4 w-4 transition-transform"
                    style={{ transform: mediaOpen ? "rotate(180deg)" : "rotate(0deg)" }}
                    aria-hidden="true"
                  />
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
                    {(() => {
                      const MIcon = MEDIA_ICON_MAP[kind.icon] || Cpu;
                      return <MIcon className="h-4 w-4 shrink-0" aria-hidden="true" />;
                    })()}
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
                  {(() => {
                    const WIcon = COMBINED_WEB_ITEM.icon;
                    return <WIcon className="h-4 w-4 shrink-0" aria-hidden="true" />;
                  })()}
                  <span className="text-sm">{COMBINED_WEB_ITEM.label}</span>
                </Link>
              </div>
            )}

            {systemItems.map((item) => (
              <NavRow
                key={item.href}
                icon={item.icon}
                label={item.label}
                active={isActive(item.href)}
                collapsed={collapsed}
                title={linkProps(item)}
              />
            ))}

            {/* Debug items */}
            {debugItems.map((item) => {
              const show = item.href !== "/dashboard/translator" || enableTranslator;
              return show ? (
                <NavRow
                  key={item.href}
                  icon={item.icon}
                  label={item.label}
                  active={isActive(item.href)}
                  collapsed={collapsed}
                  title={linkProps(item)}
                />
              ) : null;
            })}

            {/* 9Remote */}
            <NavRow
              icon={Cpu}
              label="9Remote"
              collapsed={collapsed}
              badge="HOT"
              title={{ href: "https://9remote.cc", onClick: onClose }}
            />

            {/* 9English */}
            <NavRow
              icon={Languages}
              label="9English"
              collapsed={collapsed}
              title={{ href: "https://9english.net/", onClick: onClose }}
            />

            {/* Settings */}
            <NavRow
              icon={Settings}
              label="Settings"
              active={isActive("/dashboard/profile")}
              collapsed={collapsed}
              title={linkProps({ href: "/dashboard/profile" })}
            />
          </div>

          <div className={cn("mt-8 border-t border-line/70 pt-5", collapsed ? "px-1" : "")}>
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
                <Network className="h-4 w-4 shrink-0" aria-hidden="true" />
                {!collapsed && "Connect a provider"}
              </div>
              {!collapsed && <p className="muted mt-1.5 text-[11px] leading-relaxed">Bring your first route online in under a minute.</p>}
              {!collapsed && (
                <span className="mt-2 inline-flex items-center gap-1 text-[10px] font-semibold text-gold-text">
                  Quick setup
                  <ChevronRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
                </span>
              )}
            </Link>
          </div>
        </nav>

        {/* Workspace picker */}
        {!collapsed && (
          <div className="border-t border-line/70 p-4">
            <WorkspacePicker />
          </div>
        )}
        {collapsed && (
          <div className="border-t border-line/70 p-3 flex justify-center">
            <button
              type="button"
              title="Switch workspace"
              onClick={() => {
                const ws = useWorkspaceStore.getState();
                const current = ws.workspaces.find((w) => w.id === ws.currentWorkspace);
                if (current) {
                  // Brief tooltip via alert for collapsed state
                  alert(`Current: ${current.name}`);
                }
              }}
              className="grid h-8 w-8 place-items-center rounded-lg border border-gold/30 bg-gold-soft text-xs font-bold text-gold-text hover:border-gold/50"
            >
              OH
            </button>
          </div>
        )}
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
                <Power className="h-8 w-8" />
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

Sidebar.propTypes = {
  onClose: PropTypes.func,
  collapsed: PropTypes.bool,
  onToggleCollapse: PropTypes.func,
};

function WorkspacePicker() {
  const { currentWorkspace, workspaces, fetchWorkspaces, switchWorkspace, createWorkspace, deleteWorkspace } = useWorkspaceStore();
  const [showMenu, setShowMenu] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [actionLoading, setActionLoading] = useState(null);

  useEffect(() => {
    if (workspaces.length === 0) fetchWorkspaces();
  }, [workspaces.length, fetchWorkspaces]);

  const current = workspaces.find((w) => w.id === currentWorkspace) || { id: currentWorkspace, name: "default", slug: "default" };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setActionLoading("create");
    try {
      const ws = await createWorkspace({ name: newName.trim() });
      switchWorkspace(ws.id);
      setShowCreate(false);
      setNewName("");
      await fetchWorkspaces();
    } catch (err) {
      console.error("Create workspace error:", err);
      alert(err.message);
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async (id, name) => {
    if (!confirm(`Delete workspace "${name}"? This cannot be undone.`)) return;
    setActionLoading(id);
    try {
      await deleteWorkspace(id);
      if (currentWorkspace === id) switchWorkspace("default");
      await fetchWorkspaces();
    } catch (err) {
      console.error("Delete workspace error:", err);
      alert(err.message);
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <>
      <div className="relative">
        <button
          type="button"
          onClick={() => setShowMenu(!showMenu)}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-medium transition-colors",
            "text-text-muted hover:bg-surface hover:text-text-main"
          )}
        >
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-gold/30 bg-gold-soft text-[9px] font-bold text-gold-text">{current.name?.[0]?.toUpperCase() || "D"}</span>
          <span className="min-w-0 flex-1 truncate">{current.name}</span>
          <ChevronDown className="h-4 w-4 shrink-0 transition-transform" />
        </button>

        {showMenu && (
          <>
            <div
              className="fixed inset-0 z-10"
              onClick={() => setShowMenu(false)}
            />
            <div className="absolute bottom-full left-0 mb-2 w-56 rounded-xl border border-line bg-bg-soft shadow-lg shadow-black/30 z-20">
              <div className="p-2">
                {workspaces.map((ws) => (
                  <button
                    key={ws.id}
                    onClick={async () => {
                      if (ws.id === DEFAULT_WORKSPACE_ID) {
                        switchWorkspace(ws.id);
                        setShowMenu(false);
                        return;
                      }
                      if (ws.id === DEFAULT_WORKSPACE_ID) return; // can't delete default
                      await handleDelete(ws.id, ws.name);
                    }}
                    className={cn(
                      "flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs",
                      "transition-colors",
                      currentWorkspace === ws.id
                        ? "bg-gold-soft/20 text-gold-text"
                        : "text-text-muted hover:bg-surface hover:text-text-main"
                    )}
                  >
                    <span>{ws.name}</span>
                    {ws.id !== DEFAULT_WORKSPACE_ID && actionLoading === ws.id && (
                      <span className="text-xs">…</span>
                    )}
                  </button>
                ))}
                <div className="border-t border-line/50 my-1"></div>
                {showCreate ? (
                  <form onSubmit={handleCreate} className="p-3">
                    <input
                      type="text"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder="Workspace name"
                      className="w-full rounded-lg border border-line bg-bg-soft px-2 py-1.5 text-sm text-text-main outline-none focus:border-gold/50"
                      autoFocus
                    />
                    <div className="mt-2 flex gap-1">
                      <button
                        type="submit"
                        disabled={!newName.trim() || !!actionLoading}
                        className="btn-gold !px-2 !py-1 !text-xs flex-1"
                      >
                        {actionLoading === "create" ? "…" : "Create"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowCreate(false)}
                        className="btn-secondary !px-2 !py-1 !text-xs flex-1"
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : (
                  <button
                    type="button"
                    onClick={() => setShowCreate(true)}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-text-muted hover:bg-surface hover:text-text-main"
                  >
                    <Plus className="h-3 w-3" />
                    Create workspace
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
      <p className="mono-label mt-1 px-1 text-[10px] text-text-muted">
        Switch workspace • data stays isolated per workspace
      </p>
    </>
  );
}

function ManualUpdatePanel({ latestVersion, installCmd, copied, onCopyAndShutdown, onCancel, countdown, isDisconnected }) {
  const isCountingDown = countdown > 0;
  return (
    <div className="w-full max-w-lg rounded-xl bg-neutral-900/95 border border-white/10 p-6 text-white">
      <div className="flex items-center gap-3 mb-4">
        <div className="flex items-center justify-center size-11 rounded-full bg-amber-500/20 text-amber-400">
          <Copy className="h-6 w-6" />
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
        <li>Click <strong>Copy & Shutdown</strong> below.</li>
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
