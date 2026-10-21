"use client";

import { useState, useEffect, useCallback } from "react";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { ALIAS_TO_ID } from "@/shared/constants/providers";

// Module cache: one /api/models fetch shared by every useModelCaps instance.
let cache = null; // { byFull, byId } | null
let inflight = null;
// Bumped by every invalidation so a request that was already on the wire
// cannot overwrite the fresher data with its stale answer.
let generation = 0;
// Mounted consumers wait for the next cache build.
const subscribers = new Set();

function buildMaps(models) {
  const byFull = {};
  const byId = {};
  for (const m of models || []) {
    if (!m.caps) continue;
    if (m.fullModel) byFull[m.fullModel] = m.caps;
    if (m.routedModel) byFull[m.routedModel] = m.caps;
    if (m.model) byId[m.model] = m.caps;
  }
  return { byFull, byId };
}

function loadModelCaps() {
  if (cache) return Promise.resolve(cache);
  if (inflight) return inflight;
  const mine = ++generation;
  const request = fetch("/api/models")
    .then(async (res) => {
      if (!res.ok) throw new Error(`models ${res.status}`);
      const data = await res.json();
      const maps = buildMaps(data.models);
      // An invalidation started a newer request: its answer is the fresh one.
      if (mine === generation) cache = maps;
      return maps;
    })
    .catch(() => {
      // Keep null so a later mount can retry
      return { byFull: {}, byId: {} };
    })
    .finally(() => {
      // Only clear our own request: an invalidation may have started a newer one.
      if (inflight === request) inflight = null;
    });
  inflight = request;
  return request;
}

// Custom models change at runtime: drop the shared cache and fetch again. The
// in-flight request is dropped as well — it carries exactly the data the
// invalidation is meant to replace.
function invalidateModelCaps() {
  cache = null;
  inflight = null;
  return loadModelCaps();
}

// Resolve caps from a "provider/model" string or a bare model id.
// The seat prefix is a UI alias (ocg, cmc, …); the capability tables are keyed
// by provider id (opencode-go, commandcode, …), so map it before the lookup —
// an unmapped alias falls through to the generic patterns and under-reports
// (e.g. any *claude*haiku* id reads as 200k regardless of the provider entry).
export function resolveCaps(byFull, byId, key) {
  if (!key) return null;
  if (byFull[key]) return byFull[key];
  const bare = key.includes("/") ? key.slice(key.indexOf("/") + 1) : key;
  if (byId[bare]) return byId[bare];
  const alias = key.includes("/") ? key.slice(0, key.indexOf("/")) : null;
  const provider = alias ? (ALIAS_TO_ID[alias] || alias) : null;
  const c = getCapabilitiesForModel(provider, bare);
  return {
    vision: c.vision,
    search: c.search,
    reasoning: c.reasoning,
    contextWindow: c.contextWindow,
    maxOutput: c.maxOutput,
  };
}

export function useModelCaps() {
  const [byFull, setByFull] = useState(() => cache?.byFull || {});
  const [byId, setById] = useState(() => cache?.byId || {});

  useEffect(() => {
    let alive = true;
    const sync = (maps) => {
      if (alive) { setByFull(maps.byFull); setById(maps.byId); }
    };
    subscribers.add(sync);
    if (cache) {
      sync(cache);
    } else {
      loadModelCaps().then(sync);
    }
    return () => {
      alive = false;
      subscribers.delete(sync);
    };
  }, []);

  const getCaps = useCallback(
    (key) => resolveCaps(byFull, byId, key),
    [byFull, byId],
  );

  return { getCaps };
}

// The cache lives as long as the session, so the invalidation listener is
// registered at module scope: a "customModelChanged" event fired while no
// panel is mounted must still drop the cached capabilities.
if (typeof window !== "undefined") {
  window.addEventListener("customModelChanged", () => {
    invalidateModelCaps().then((maps) => {
      for (const sync of subscribers) sync(maps);
    });
  });
}
