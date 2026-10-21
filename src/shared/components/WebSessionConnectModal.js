"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Modal, Button } from "@/shared/components";
import { WEB_SESSION_PROVIDERS } from "@/shared/constants/webSessionProviders";

/**
 * Web-session connect dialog.
 *
 * One dialog for every provider in the "Web Cookie Sessions" group: the
 * instructions, the field and the notes all come from the provider's own
 * descriptor, so the guide can never drift from what the gateway accepts.
 *
 * The flow is deliberately two steps — Check, then Save. A check asks the
 * provider whether the credential means anything; nothing is stored until it
 * does. For one provider the credential is optional (Duck.ai serves
 * signed-out visitors), and that is what `optionalCredential` says.
 */
export default function WebSessionConnectModal({ isOpen, providerId, onSuccess, onClose }) {
  const [credential, setCredential] = useState("");
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [checked, setChecked] = useState(null);

  const descriptor = providerId ? WEB_SESSION_PROVIDERS[providerId] || null : null;

  const reset = () => {
    setCredential("");
    setError(null);
    setChecked(null);
    setChecking(false);
    setSaving(false);
  };

  const handleClose = () => {
    reset();
    onClose?.();
  };

  const call = async (action) => {
    const res = await fetch(`/api/providers/web-session/${providerId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, credential: credential.trim() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Request failed");
    return data;
  };

  const handleCheck = async () => {
    setChecking(true);
    setError(null);
    try {
      const data = await call("check");
      setChecked(data);
      if (data.ok === false && data.error) setError(data.error);
    } catch (err) {
      setError(err.message);
    } finally {
      setChecking(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await call("connect");
      onSuccess?.();
      handleClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen || !descriptor) return null;

  const canCheck = descriptor.optionalCredential || credential.trim().length > 0;
  const busy = checking || saving;

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={`Connect ${descriptor.name}`} size="lg">
      <div className="flex flex-col gap-4">
        <p className="text-sm text-text-muted">
          {descriptor.name} is reached with a session your browser already holds, not with an API key.
          Sign in at{" "}
          <a
            href={descriptor.website}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            {descriptor.website}
          </a>{" "}
          first, then copy the credential below.
        </p>

        {/* Extraction steps — the provider's own instructions. */}
        <div className="bg-surface-secondary p-3 rounded-lg text-xs space-y-3">
          {descriptor.extractionSteps.map((step, index) => (
            <div key={step.label} className="space-y-1">
              <p className="font-medium text-text-primary">
                {index + 1}. {step.label}
              </p>
              <p className="text-text-muted">{step.body}</p>
              {step.snippet && (
                <code className="block bg-sidebar px-2 py-1 rounded text-[11px] text-text-primary overflow-x-auto">
                  {step.snippet}
                </code>
              )}
            </div>
          ))}
        </div>

        {/* The credential */}
        <div className="space-y-2">
          <label className="block text-sm font-medium text-text-primary">
            {descriptor.paste?.fieldLabel || descriptor.credentialName}
          </label>
          <textarea
            value={credential}
            onChange={(e) => { setCredential(e.target.value); setChecked(null); }}
            placeholder={descriptor.paste?.placeholder || descriptor.credentialName}
            className="w-full px-3 py-2 bg-surface-secondary border border-border rounded-lg text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-primary resize-none"
            rows={4}
            disabled={busy}
          />
          <p className="text-[11px] text-text-muted">
            Needs: {descriptor.credentialName}
          </p>
        </div>

        {/* What the check found */}
        {checked && (
          <div
            className={`p-3 rounded-lg border text-sm ${
              checked.ok
                ? "bg-success/10 border-success/20 text-text-primary"
                : "bg-error/10 border-error/20 text-error"
            }`}
          >
            <p>{checked.detail || (checked.ok ? "The credential works." : "The provider refused the credential.")}</p>
            {Array.isArray(checked.models) && checked.models.length > 0 && (
              <p className="mt-1 text-xs text-text-muted">
                Models available: {checked.models.slice(0, 12).join(", ")}
                {checked.models.length > 12 ? ` +${checked.models.length - 12} more` : ""}
              </p>
            )}
          </div>
        )}

        {error && (
          <div className="p-3 bg-error/10 border border-error/20 rounded-lg">
            <p className="text-sm text-error">{error}</p>
          </div>
        )}

        {descriptor.planNote && (
          <p className="text-[11px] text-text-muted">{descriptor.planNote}</p>
        )}

        <div className="flex gap-3 pt-2">
          <Button variant="secondary" onClick={handleClose} disabled={busy} fullWidth>
            Cancel
          </Button>
          <Button variant="secondary" onClick={handleCheck} disabled={!canCheck || busy} loading={checking} fullWidth>
            Check
          </Button>
          <Button onClick={handleSave} disabled={!canCheck || busy} loading={saving} fullWidth>
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}

WebSessionConnectModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  providerId: PropTypes.string,
  onSuccess: PropTypes.func,
  onClose: PropTypes.func,
};
