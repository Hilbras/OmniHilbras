import { registerPlugin } from '@capacitor/core';

/**
 * The Android Keystore-backed store for the device gateway URL and token.
 *
 * It is deliberately not Capacitor Preferences: that is SharedPreferences in clear text. The native
 * plugin encrypts with an AES key held by AndroidKeyStore and never exposes the key to JavaScript.
 */
type SecureStorePlugin = {
  set(options: { key: string; value: string }): Promise<void>;
  get(options: { key: string }): Promise<{ value: string | null }>;
  remove(options: { key: string }): Promise<void>;
};

export const SecureStore = registerPlugin<SecureStorePlugin>('SecureStore');
