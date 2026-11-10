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

## Run against this computer

For a USB-connected debug device, reverse the gateway port so the app's loopback URL reaches the desktop:

```bash
pnpm dev:gateway
adb reverse tcp:8787 tcp:8787
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

The app opens the dashboard at its root. The gateway must allow the app's origin and, when API-key enforcement
is on, the dashboard needs a device token. That pairing flow is **not implemented yet**; this shell is the
debug foundation.

## Current limits

- No QR pairing.
- No Android Keystore token storage.
- No release signing.
- Remote HTTPS is accepted by the client, but the gateway still needs a trusted tunnel/reverse proxy and a
  device-key flow before a non-loopback build is usable.

Do not bind the gateway to `0.0.0.0` as a shortcut.
