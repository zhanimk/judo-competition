'use client';
import { useEffect, useState } from 'react';
import { acquireTabDevice } from './tab-device';
let initialized: Promise<{ id: string; duplicated: boolean }> | undefined;
export function useTabDevice(enabled = true) {
  const [device, setDevice] = useState<{ id: string; duplicated: boolean } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    if (!initialized) {
      try {
        initialized = navigator.locks
          ? acquireTabDevice(sessionStorage, navigator.locks, () => crypto.randomUUID())
          : Promise.reject(new Error('DEVICE_BROWSER_UNSUPPORTED'));
      } catch {
        initialized = Promise.reject(new Error('DEVICE_STORAGE_INVALID'));
      }
    }
    void initialized
      .then((value) => {
        if (active) setDevice(value);
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [enabled]);
  return { deviceId: device?.id ?? null, duplicated: device?.duplicated ?? false, error };
}
