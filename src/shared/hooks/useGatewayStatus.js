"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Whether the gateway is answering, and a way to hear that it started again.
 *
 * The badge in the rail used to be a string in the markup, so during an
 * outage the dashboard reported the one thing that was false. And a page that
 * had already failed made no further requests, so nothing would ever notice
 * the gateway coming back — the offline message was the last thing the tab
 * ever said.
 *
 * So this polls. `/api/version` answers in a few milliseconds, so the poll
 * costs nothing, and it is the only way a page that has already failed can
 * learn it stopped failing.
 */
const POLL_MS = 4000;

/**
 * Why the gateway is not answering, when it is not.
 *
 * `refused` is the case worth separating: the gateway is **up** and declined
 * this browser. Calling that "offline" sends the user to restart a server
 * that is already running correctly.
 */
export function problemForStatus(status) {
  if (status === 403) return "refused";
  if (status === 401) return "unauthorized";
  return "unreachable";
}

export function useGatewayStatus() {
  // undefined until the first probe answers: "not known yet", not "up".
  const [reachable, setReachable] = useState(undefined);
  const [problem, setProblem] = useState(undefined);
  const [buildVersion, setBuildVersion] = useState(undefined);
  const mountedRef = useRef(true);

  const probe = useCallback(async () => {
    try {
      const res = await fetch("/api/version", { cache: "no-store" });
      if (!res.ok) {
        if (!mountedRef.current) return;
        setReachable(false);
        setProblem(problemForStatus(res.status));
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (!mountedRef.current) return;
      setReachable(true);
      setProblem(undefined);
      if (typeof data?.currentVersion === "string") setBuildVersion(data.currentVersion);
    } catch {
      if (!mountedRef.current) return;
      setReachable(false);
      setProblem("unreachable");
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    probe();
    const timer = setInterval(probe, POLL_MS);
    // A hidden tab must not keep the poll running.
    const onVisibility = () => {
      if (!document.hidden) probe();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [probe]);

  return { reachable, problem, buildVersion, refresh: probe };
}
