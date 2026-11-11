import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Android companion shell.
 *
 * The gateway stays on the desktop. The app bundles the dashboard and talks to it over HTTPS or a
 * loopback tunnel; it never stores a provider credential and never binds a gateway on the phone.
 */
const config: CapacitorConfig = {
  appId: 'com.hilbras.omnihilbras',
  appName: 'OmniHilbras',
  webDir: 'dist-android',
  android: {
    allowMixedContent: false,
  },
  server: {
    // The local bundle is served over http://localhost so a loopback gateway (adb reverse) is not
    // blocked as mixed content. A remote gateway URL must still be HTTPS.
    androidScheme: 'http',
  },
};

export default config;
