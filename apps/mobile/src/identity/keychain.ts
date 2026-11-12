// The device SecretStore: the iOS Keychain through expo-secure-store. Items are readable only
// while the phone is unlocked and never leave this device (no iCloud Keychain, no backups).
import * as SecureStore from "expo-secure-store";
import type { SecretStore } from "./identity";

const opts: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export const keychain: SecretStore = {
  get: (k) => SecureStore.getItemAsync(k, opts),
  set: (k, v) => SecureStore.setItemAsync(k, v, opts),
  delete: (k) => SecureStore.deleteItemAsync(k, opts),
};
