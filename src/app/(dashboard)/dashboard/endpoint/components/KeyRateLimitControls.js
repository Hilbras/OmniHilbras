"use client";

// Per-API-key rate limit override on the Endpoint page.
//
// The gateway's limiter gives every key the global ceiling
// (settings.rateLimit.requestsPerMinute / tokensPerMinute). This control
// raises — or lowers — that ceiling for exactly one key; every other key keeps
// the global value. The override lives in the settings
// (rateLimit.keyOverrides, keyed by API key id) so the dashboard and the
// gateway read the same number.
import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { Input, Button } from "@/shared/components";
import useSettingsStore from "@/store/settingsStore";

// The gateway reads an empty override as "inherit the global ceiling" and a 0
// as "no limit for this key" — the two must not be confused, so the number
// that is really in force is resolved the same way here.
function effectiveLimit(value, globalValue) {
  if (value === "" || value === null || value === undefined) return globalValue ?? 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export default function KeyRateLimitControls({ apiKey }) {
  const settings = useSettingsStore((state) => state.settings);
  const rateLimit = settings?.rateLimit || {};
  const override = rateLimit.keyOverrides?.[apiKey.id] || null;

  const [open, setOpen] = useState(false);

  const label = override
    ? `Rate limit: ${effectiveLimit(override.requestsPerMinute, rateLimit.requestsPerMinute)}/min, ${effectiveLimit(override.tokensPerMinute, rateLimit.tokensPerMinute)} tokens/min`
    : "Rate limit: global";

  return (
    <div className="mt-2" data-testid="key-rate-limit">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-xs font-medium text-primary hover:underline"
      >
        {label}
      </button>
      {open && (
        // Remounted whenever the effective values change, so the inputs always
        // start from the values that are actually in force.
        <KeyRateLimitForm
          key={`${apiKey.id}:${override?.requestsPerMinute}:${override?.tokensPerMinute}:${rateLimit.requestsPerMinute}:${rateLimit.tokensPerMinute}`}
          apiKey={apiKey}
        />
      )}
      {open && <KeyRateLimitUsage apiKeyId={apiKey.id} />}
    </div>
  );
}

/**
 * What this key spent in the last minute, and how often it was refused.
 *
 * Only fetched while the control is open: the Endpoint page lists every key,
 * and a poll per key would be a request per key every few seconds.
 */
function KeyRateLimitUsage({ apiKeyId }) {
  const [usage, setUsage] = useState(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      // A hidden tab must not keep hitting the server every 15 seconds.
      if (document.hidden) return;
      try {
        const res = await fetch("/api/usage/rate-limit", { cache: "no-store" });
        if (!res.ok) return;
        const json = await res.json();
        if (cancelled) return;
        const identity = (json.identities || []).find((i) => i.keyId === apiKeyId);
        setUsage(identity || null);
      } catch {
        // The read-out is a convenience: a failure leaves it empty.
      }
    };

    // The read-out catches up as soon as the tab is looked at again.
    const onVisible = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", onVisible);

    load();
    const timer = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [apiKeyId]);

  if (!usage) return null;

  const refused = Object.values(usage.rejections || {}).reduce(
    (sum, n) => sum + (Number(n) || 0),
    0,
  );

  return (
    <p className="mt-1 text-xs text-text-muted" data-testid="key-rate-limit-usage">
      Last minute: {usage.requestsPerMinute} requests, {usage.tokensPerMinute} tokens
      {refused > 0 ? `, ${refused} refused` : ""}
    </p>
  );
}

function KeyRateLimitForm({ apiKey }) {
  const settings = useSettingsStore((state) => state.settings);
  const patchSettings = useSettingsStore((state) => state.patchSettings);
  const rateLimit = settings?.rateLimit || {};
  const override = rateLimit.keyOverrides?.[apiKey.id] || null;

  const [requestsPerMinute, setRequestsPerMinute] = useState(
    String(override?.requestsPerMinute ?? rateLimit.requestsPerMinute ?? ""),
  );
  const [tokensPerMinute, setTokensPerMinute] = useState(
    String(override?.tokensPerMinute ?? rateLimit.tokensPerMinute ?? ""),
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  const writeOverrides = async (nextOverrides) => {
    setSaving(true);
    setSaveError("");
    try {
      // The store returns null when the server refused the change: the
      // override would then not be in force, and the input would still show the
      // new number. Say so instead of letting the change disappear.
      const saved = await patchSettings({ rateLimit: { ...rateLimit, keyOverrides: nextOverrides } });
      if (!saved) {
        setSaveError(
          useSettingsStore.getState().error || "The limit was not saved — the server refused the change.",
        );
      }
    } finally {
      setSaving(false);
    }
  };

  const save = () => {
    const nextOverrides = { ...(rateLimit.keyOverrides || {}) };
    nextOverrides[apiKey.id] = {
      // An empty field means "inherit the global ceiling", which is what the
      // gateway does with an empty override. 0 stays "unlimited for this key".
      requestsPerMinute: requestsPerMinute.trim() === "" ? "" : (Number(requestsPerMinute) || 0),
      tokensPerMinute: tokensPerMinute.trim() === "" ? "" : (Number(tokensPerMinute) || 0),
    };
    writeOverrides(nextOverrides);
  };

  const clear = () => {
    const nextOverrides = { ...(rateLimit.keyOverrides || {}) };
    delete nextOverrides[apiKey.id];
    writeOverrides(nextOverrides);
  };

  return (
    <div className="mt-2 flex flex-col gap-2 rounded-xl border border-black/[0.05] dark:border-white/[0.06] p-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          type="number"
          min="0"
          label="Requests / minute"
          value={requestsPerMinute}
          onChange={(e) => setRequestsPerMinute(e.target.value)}
          className="flex-1"
        />
        <Input
          type="number"
          min="0"
          label="Tokens / minute"
          value={tokensPerMinute}
          onChange={(e) => setTokensPerMinute(e.target.value)}
          className="flex-1"
        />
      </div>
      <p className="text-xs text-text-muted">
        0 means unlimited for this key. Leave empty to use the global ceiling.
      </p>
      {saveError && (
        <p className="text-xs text-red-500" data-testid="key-rate-limit-error">
          {saveError}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={save} disabled={saving}>
          Save
        </Button>
        {override && (
          <Button size="sm" variant="ghost" onClick={clear} disabled={saving}>
            Use global
          </Button>
        )}
      </div>
    </div>
  );
}

KeyRateLimitControls.propTypes = {
  apiKey: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string,
  }).isRequired,
};

KeyRateLimitForm.propTypes = {
  apiKey: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string,
  }).isRequired,
};
