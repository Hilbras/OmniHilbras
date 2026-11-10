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
    androidScheme: 'https',
  },
};

export default config;
