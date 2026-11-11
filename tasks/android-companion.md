# Plan: Android companion app

**Status:** complete for the debug companion — APK, Keystore pairing and emulator verification pass; QR pairing, release signing and read-only device scopes are explicitly deferred

## Decision

Build **Option A**: Android controls the gateway running on the user's computer. Do not port Electron or run a
Node gateway on the phone. The desktop remains the credential and provider host.

## Security contract

- Gateway stays loopback-bound. Remote access is through a private tunnel or trusted HTTPS reverse proxy, never
  a direct public bind.
- Each Android device gets its own API key, revocable from the desktop.
- Pairing uses a one-time token, exchanged for a device credential; no provider key ever reaches Android.
- Android stores the device credential in the Android Keystore, not localStorage or a WebView cookie.
- CORS and origin checks remain; a remote origin is explicit, not a wildcard.
- Mutations require the device key. First release is read-only where possible.

## Phase 1 — remote gateway profile

- Add an explicit remote profile to the gateway configuration: allowed public origin, required API key, and a
  documented proxy/tunnel setup.
- Do not relax the loopback bind by default. The supported topology is `gateway 127.0.0.1 → tailscale serve /
  reverse proxy → Android`.
- Add a runtime gateway URL for the dashboard/Android shell, validated as HTTPS or loopback, never
  `http://` to a public host.
- Add tests for remote-origin refusal, key enforcement and loopback default.

## Phase 2 — Android shell

- Add a Capacitor Android project under `android/` using a dashboard-only web build.
- `vite.android.config.ts` emits the dashboard as the app entry, not the marketing page.
- Build script and Gradle wrapper; JDK 21 and user-local Android SDK.
- The shell has no Electron preload; gateway access is HTTP/SSE with the device key.
- Debug APK first, release signing later.

## Phase 3 — pairing and storage

- Desktop shows a QR code containing the gateway base URL and a one-time pairing token.
- Android scans it, exchanges the token for a device key, and stores the key in Keystore.
- Settings screen: gateway URL, paired device name, revoke.
- Reject HTTP public URLs; allow HTTPS and loopback/adb reverse.

## Phase 4 — mobile dashboard

- Providers, Models, Routing, Usage and Logs read-only.
- Live logs over SSE with reconnect.
- No provider credential creation or export from Android in the first release.
- Responsive navigation already exists; verify touch targets and no horizontal overflow.

## Phase 5 — build and release

- Android SDK licenses accepted in CI, Gradle build on a runner with JDK 21.
- Attach `OmniHilbras-android-debug.apk` to the GitHub release; signed release APK only after a keystore exists.
- Update README, `docs/SPEC-SDK.md`, architecture and release notes.
- `pnpm verify` and an Android smoke/install test.

## Non-goals

- Running Kernel/API on the phone.
- Publicly exposing the gateway.
- Copying the provider vault to Android.
- Rooting, bypassing provider limits or fingerprint spoofing.
