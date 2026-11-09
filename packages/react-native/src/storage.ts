import { isRecord } from './types';

/** Where Tapline remembers the paired computer and this install's id. */
export interface TaplineStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

interface SecureStoreModule {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

function isSecureStore(value: unknown): value is SecureStoreModule {
  return (
    isRecord(value) &&
    typeof value.getItemAsync === 'function' &&
    typeof value.setItemAsync === 'function' &&
    typeof value.deleteItemAsync === 'function'
  );
}

/** expo-secure-store when the app has it (keychain on iOS), else null. */
export function secureStoreStorage(): TaplineStorage | null {
  let loaded: unknown;
  try {
    loaded = require('expo-secure-store');
  } catch {
    return null;
  }
  const store = isRecord(loaded) && isSecureStore(loaded.default) ? loaded.default : loaded;
  if (!isSecureStore(store)) return null;
  return {
    getItem: (key) => store.getItemAsync(key),
    setItem: (key, value) => store.setItemAsync(key, value),
    removeItem: (key) => store.deleteItemAsync(key),
  };
}

/** Kept only while the app runs. */
export function memoryStorage(): TaplineStorage {
  const items = new Map<string, string>();
  return {
    getItem: (key) => Promise.resolve(items.get(key) ?? null),
    setItem: (key, value) => {
      items.set(key, value);
      return Promise.resolve();
    },
    removeItem: (key) => {
      items.delete(key);
      return Promise.resolve();
    },
  };
}
