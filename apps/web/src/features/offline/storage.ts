const DB = 'judo-offline-v1';
async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('journals');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function readJournal<T>(key: string): Promise<T | null> {
  const db = await database();
  try {
    return await new Promise<T | null>((resolve, reject) => {
      const r = db.transaction('journals').objectStore('journals').get(key);
      r.onsuccess = () => resolve(r.result ?? null);
      r.onerror = () => reject(r.error);
    });
  } finally {
    db.close();
  }
}
export async function writeJournal(key: string, value: unknown) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('journals', 'readwrite');
      if (value === null) tx.objectStore('journals').delete(key);
      else tx.objectStore('journals').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
export async function prepareOfflineShell() {
  if (!('serviceWorker' in navigator) || !navigator.locks)
    throw new Error('OFFLINE_BROWSER_UNSUPPORTED');
  await navigator.serviceWorker.register('/judo-offline-sw.js');
  const registration = await navigator.serviceWorker.ready;
  const urls = [
    location.pathname,
    ...performance
      .getEntriesByType('resource')
      .map((r) => r.name)
      .filter(
        (url) =>
          url.startsWith(location.origin + '/_next/static/') ||
          url.startsWith(location.origin + '/flags/'),
      ),
  ];
  await new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => reject(new Error('OFFLINE_CACHE_FAILED')), 15000);
    channel.port1.onmessage = (e) => {
      clearTimeout(timer);
      e.data.ok ? resolve() : reject(new Error('OFFLINE_CACHE_FAILED'));
    };
    registration.active!.postMessage({ type: 'PREPARE', urls }, [channel.port2]);
  });
  await navigator.storage?.persist?.();
}
