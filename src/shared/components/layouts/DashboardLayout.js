"use client";

import { useState, useEffect, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { useNotificationStore } from "@/store/notificationStore";
import Sidebar from "../Sidebar";
import Header from "../Header";

/* Sidebar collapse — module store so useSyncExternalStore can subscribe
   without setState-in-effect (React 19 lint) and without a hydration mismatch
   (server snapshot is always "expanded"). */
const SIDEBAR_COLLAPSE_KEY = "omnihilbras-sidebar-collapsed";
const collapseListeners = new Set();

function subscribeCollapse(listener) {
  collapseListeners.add(listener);
  return () => collapseListeners.delete(listener);
}

function getCollapsedSnapshot() {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === "true";
  } catch {
    return false;
  }
}

function getCollapsedServerSnapshot() {
  return false;
}

function toggleCollapsedStore() {
  const next = !getCollapsedSnapshot();
  try {
    localStorage.setItem(SIDEBAR_COLLAPSE_KEY, String(next));
  } catch {
    // Preference still applies for this session when storage is unavailable.
  }
  for (const listener of collapseListeners) listener();
}

function getToastStyle(type) {
  if (type === "success") {
    return {
      wrapper: "border-success/30 bg-success/10 text-success",
      icon: "check_circle",
    };
  }
  if (type === "error") {
    return {
      wrapper: "border-danger/30 bg-danger/10 text-danger",
      icon: "error",
    };
  }
  if (type === "warning") {
    return {
      wrapper: "border-warning/30 bg-warning/10 text-warning",
      icon: "warning",
    };
  }
  return {
    wrapper: "border-info/30 bg-info/10 text-info",
    icon: "info",
  };
}

export default function DashboardLayout({ children }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const collapsed = useSyncExternalStore(subscribeCollapse, getCollapsedSnapshot, getCollapsedServerSnapshot);
  const pathname = usePathname();
  const notifications = useNotificationStore((state) => state.notifications);
  const removeNotification = useNotificationStore((state) => state.removeNotification);

  const toggleCollapse = toggleCollapsedStore;

  // Preload heavy usage charts in background when browser is idle
  useEffect(() => {
    const preload = () => {
      import("@/shared/components/UsageStats").catch(() => {});
      import("@/app/(dashboard)/dashboard/usage/components/UsageChart").catch(() => {});
      import("@/app/(dashboard)/dashboard/usage/components/ProviderBarChart").catch(() => {});
      import("@/app/(dashboard)/dashboard/usage/components/TopModelsChart").catch(() => {});
    };
    if (typeof window !== "undefined") {
      if ("requestIdleCallback" in window) {
        const id = window.requestIdleCallback(preload, { timeout: 4000 });
        return () => window.cancelIdleCallback(id);
      }
      const timer = setTimeout(preload, 2500);
      return () => clearTimeout(timer);
    }
  }, []);

  return (
    <div className="dashboard-shell flex h-screen w-full overflow-hidden bg-bg text-text">
      {/* Toasts — opaque, no backdrop filter */}
      <div className="fixed top-4 right-4 z-[80] flex w-[min(92vw,380px)] flex-col gap-2">
        {notifications.map((n) => {
          const style = getToastStyle(n.type);
          return (
            <div
              key={n.id}
              className={`rounded-lg border px-3 py-2 shadow-elev ${style.wrapper}`}
            >
              <div className="flex items-start gap-2">
                <span className="material-symbols-outlined text-[18px] leading-5">{style.icon}</span>
                <div className="min-w-0 flex-1">
                  {n.title ? <p className="text-xs font-semibold mb-0.5">{n.title}</p> : null}
                  <p className="text-xs whitespace-pre-wrap break-words">{n.message}</p>
                </div>
                {n.dismissible ? (
                  <button
                    type="button"
                    onClick={() => removeNotification(n.id)}
                    className="text-current/70 hover:text-current"
                    aria-label="Dismiss notification"
                  >
                    <span className="material-symbols-outlined text-[16px]">close</span>
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {/* Mobile sidebar overlay — fixed inset-0 is the one allowed overlay exception */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/45 lg:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-label="Close dashboard navigation"
        />
      )}

      {/* Sidebar - Desktop */}
      <div className="hidden lg:flex">
        <Sidebar collapsed={collapsed} onToggleCollapse={toggleCollapse} />
      </div>

      {/* Sidebar - Mobile — always full width; collapse is desktop-only */}
      <div
        className={`fixed inset-y-0 left-0 z-50 transform lg:hidden transition-transform duration-200 ease-out ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <Sidebar onClose={() => setSidebarOpen(false)} />
      </div>

      {/* Main content — header is opaque on purpose: a backdrop filter behind a
          sticky element re-samples everything scrolling under it every frame. */}
      <main className="dashboard-grid-bg flex flex-col flex-1 h-full min-w-0 relative isolate overflow-hidden">
        <div className="dashboard-content relative z-10 flex flex-col flex-1 min-h-0 mx-auto w-full max-w-[1440px]">
          {/* No key={pathname}: remounting the whole page on every navigation
              replays entrance animations and re-runs every effect. */}
          <Header onMenuClick={() => setSidebarOpen(true)} />
          <div className={`flex-1 overflow-y-auto custom-scrollbar ${pathname === "/dashboard/basic-chat" ? "" : "p-4 sm:p-6 lg:p-8"} ${pathname === "/dashboard/basic-chat" ? "flex flex-col overflow-hidden" : ""}`}>
            <div className={`${pathname === "/dashboard/basic-chat" ? "flex-1 w-full h-full flex flex-col" : "max-w-7xl mx-auto"}`}>{children}</div>
          </div>
        </div>
      </main>
    </div>
  );
}
