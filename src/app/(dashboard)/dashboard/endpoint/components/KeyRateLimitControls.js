"use client";

// Per-API-key rate limit override on the Endpoint page.
//
// The gateway's limiter gives every key the global ceiling
// (settings.rateLimit.requestsPerMinute / tokensPerMinute). This control
// raises — or lowers — that ceiling for exactly one key; every other key keeps
// the global value. The override lives in the settings
// (rateLimit.keyOverrides, keyed by API key id) so the dashboard and the
// gateway read the same number.
import { useState } from "react";
import PropTypes from "prop-types";
import { Input, Button } from "@/shared/components";
import useSettingsStore from "@/store/settingsStore";

export default function KeyRateLimitControls({ apiKey }) {
  const settings = useSettingsStore((state) => state.settings);
  const rateLimit = settings?.rateLimit || {};
  const override = rateLimit.keyOverrides?.[apiKey.id] || null;

  const [open, setOpen] = useState(false);

  const label = override
    ? `Rate limit: ${override.requestsPerMinute}/min, ${override.tokensPerMinute} tokens/min`
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
    </div>
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

  const writeOverrides = async (nextOverrides) => {
    setSaving(true);
    try {
      await patchSettings({ rateLimit: { ...rateLimit, keyOverrides: nextOverrides } });
    } finally {
      setSaving(false);
    }
  };

  const save = () => {
    const nextOverrides = { ...(rateLimit.keyOverrides || {}) };
    nextOverrides[apiKey.id] = {
      requestsPerMinute: Number(requestsPerMinute) || 0,
      tokensPerMinute: Number(tokensPerMinute) || 0,
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
