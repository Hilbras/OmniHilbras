"use client";

import { useRef, useState } from "react";
import PropTypes from "prop-types";
import { Modal, Button, Input } from "@/shared/components";

/**
 * Token Harbor Authentication Modal
 *
 * Two ways in:
 * - Google (PKCE) — redirects to Token Harbor's own auth page, which handles
 *   Google / GitHub / email sign-in. This is the recommended path.
 * - Email + password — a direct GoTrue password grant, for accounts that use
 *   a password rather than a social login.
 *
 * Either way the result is the same: an account session that can read the
 * prepaid wallet in the Quota Tracker. The model API key is a separate thing
 * and stays on the connection's API-key field.
 */
export default function TokenHarborAuthModal({ isOpen, providerInfo, onSuccess, onClose }) {
  const [mode, setMode] = useState(null); // null | "oauth" | "password"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [pastedUrl, setPastedUrl] = useState("");
  const [authData, setAuthData] = useState(null);
  const popupRef = useRef(null);

  const reset = () => {
    setMode(null);
    setEmail("");
    setPassword("");
    setError(null);
    setLoading(false);
    setPastedUrl("");
    setAuthData(null);
  };

  const handleClose = () => {
    try {
      popupRef.current?.close();
    } catch {
      /* the popup may already be gone */
    }
    reset();
    onClose();
  };

  // GoTrue redirects back to Token Harbor's own host (it pins the redirect
  // target), landing on a plain-text page with the code in the address bar.
  // We open that flow in a popup and ask the user to copy the URL back.
  const startGoogleLogin = async () => {
    setError(null);
    setLoading(true);
    try {
      const redirectUri = `${window.location.origin}/callback`;
      const res = await fetch(
        `/api/oauth/tokenharbor/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`,
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not start the login");
      setAuthData(data);
      popupRef.current = window.open(data.authUrl, "tokenharbor_login", "width=600,height=700");
      if (!popupRef.current) {
        setError("The login window was blocked. Allow popups for this site and try again.");
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handlePastedUrl = async () => {
    if (!pastedUrl.trim()) {
      setError("Paste the URL shown in the login window");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/oauth/tokenharbor/manual-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: pastedUrl.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not complete the login");
      onSuccess?.();
      handleClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handlePasswordSubmit = async () => {
    if (!email.trim() || !password) {
      setError("Email and password are required");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/oauth/tokenharbor/password-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Authentication failed");
      // The password is never kept around.
      setPassword("");
      onSuccess?.();
      handleClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <Modal isOpen={isOpen} title="Connect Token Harbor" onClose={handleClose} size="lg">
      <div className="flex flex-col gap-4">
        {!mode && (
          <>
            <p className="text-sm text-text-muted">
              Sign in to read your Token Harbor wallet balance in the Quota Tracker.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => setMode("oauth")}
                className="flex flex-col items-center gap-2 p-4 rounded-lg border border-border hover:border-primary hover:bg-primary/5 transition-colors text-left"
              >
                <span className="material-symbols-outlined text-2xl text-primary">lock_open</span>
                <div>
                  <p className="text-sm font-medium">Sign in with Google</p>
                  <p className="text-xs text-text-muted">Opens Token Harbor&apos;s own login page</p>
                </div>
              </button>
              <button
                onClick={() => setMode("password")}
                className="flex flex-col items-center gap-2 p-4 rounded-lg border border-border hover:border-primary hover:bg-primary/5 transition-colors text-left"
              >
                <span className="material-symbols-outlined text-2xl text-primary">key</span>
                <div>
                  <p className="text-sm font-medium">Email &amp; password</p>
                  <p className="text-xs text-text-muted">For accounts using a password</p>
                </div>
              </button>
            </div>
            <p className="text-xs text-text-muted">
              Your model API key is set separately — this login only reads your wallet.
            </p>
          </>
        )}

        {mode === "oauth" && (
          <>
            <p className="text-xs text-text-muted">
              A login window opens on Token Harbor&apos;s site. After signing in with Google,
              GitHub or email, the page shows a plain address — copy that whole URL and paste it
              below to finish connecting.
            </p>
            <div className="flex gap-2">
              <Button onClick={startGoogleLogin} fullWidth disabled={loading} loading={loading}>
                {authData ? "Open login again" : "Sign in with Google"}
              </Button>
              <Button onClick={() => { setMode(null); setError(null); }} variant="ghost" fullWidth>
                Back
              </Button>
            </div>
            <Input
              label="Paste the URL from the login window"
              value={pastedUrl}
              onChange={(e) => setPastedUrl(e.target.value)}
              placeholder="https://tokenharbor.ai/robots.txt?code=..."
              hint="The address bar of the login window — copy the whole thing, including ?code=..."
              inputClassName="font-mono text-xs"
            />
            {error && <p className="text-sm text-red-500">{error}</p>}
            <Button onClick={handlePastedUrl} fullWidth disabled={!pastedUrl.trim() || loading} loading={loading}>
              Connect
            </Button>
          </>
        )}

        {mode === "password" && (
          <>
            <p className="text-xs text-text-muted">
              Use the email and password of your Token Harbor account.
            </p>
            <Input
              label="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="username"
            />
            <Input
              label="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Your Token Harbor password"
              autoComplete="current-password"
            />
            {error && <p className="text-sm text-red-500">{error}</p>}
            <div className="flex gap-2">
              <Button onClick={handlePasswordSubmit} fullWidth disabled={!email.trim() || !password || loading} loading={loading}>
                Connect
              </Button>
              <Button onClick={() => { setMode(null); setError(null); }} variant="ghost" fullWidth>
                Back
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

TokenHarborAuthModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  providerInfo: PropTypes.shape({ name: PropTypes.string }),
  onSuccess: PropTypes.func,
  onClose: PropTypes.func.isRequired,
};
