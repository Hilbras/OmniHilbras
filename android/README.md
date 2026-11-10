# OmniHilbras Android companion

This is the **companion shell**, not a phone-local gateway. The gateway and provider credentials stay on the
desktop; Android loads the dashboard in a Capacitor WebView.

## Build

Requirements:

- JDK 21
- Android SDK with platform 35 and build-tools 35
- `ANDROID_HOME` pointing at the SDK

```bash
pnpm install
pnpm build:android          # dashboard-only web build → dist-android
pnpm android:apk            # sync + Gradle assembleDebug
```

Debug APK:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

## Pairing

The app opens a setup screen when no device credential is stored. Enter:

- **Gateway URL** — `https://…` through a private tunnel, or `http://127.0.0.1:8787` with `adb reverse`.
- **Device API key** — create one in the desktop dashboard under **API keys**, and turn on key enforcement.

The key is encrypted with Android Keystore through the `SecureStore` plugin. The provider vault is never
copied to Android.

QR pairing is not implemented yet; manual entry is the current pairing path.

## Run against this computer

For a USB-connected debug device, reverse the gateway port so the app's loopback URL reaches the desktop:

```bash
pnpm dev:gateway
adb reverse tcp:8787 tcp:8787
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

For a remote device, put the gateway behind a private HTTPS path (for example Tailscale Serve) and enter that
URL. The default CORS list includes the Capacitor origin `https://localhost`; add any other origin explicitly.

## Current limits

- QR pairing is deferred.
- Release signing is deferred; the APK is a debug build.
- Runtime verification on a physical device is still required.
- The dashboard pages are the existing dashboard, so providers, models, routing, usage and logs are wired to
  the same gateway API; mobile layout needs device verification.

Do not bind the gateway to `0.0.0.0` as a shortcut.
