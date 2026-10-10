type DeviceStorage = Pick<Storage, 'getItem' | 'setItem'>;
type DeviceLocks = {
  request: (
    name: string,
    options: { ifAvailable: true },
    callback: (lock: unknown) => Promise<void>,
  ) => Promise<unknown>;
};
const deviceKey = 'judo.tab-device.v1';
const uuid = /^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
export async function acquireTabDevice(
  storage: DeviceStorage,
  locks: DeviceLocks,
  randomId: () => string,
): Promise<{ id: string; duplicated: boolean }> {
  let id = storage.getItem(deviceKey) ?? randomId();
  if (!uuid.test(id)) throw new Error('DEVICE_STORAGE_INVALID');
  let duplicated = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    storage.setItem(deviceKey, id);
    const acquired = await new Promise<boolean>((resolve, reject) => {
      void locks
        .request('judo-tab-device:' + id, { ifAvailable: true }, async (lock) => {
          resolve(!!lock);
          // The browser releases this lock when the document is destroyed.
          if (lock) await new Promise<void>(() => {});
        })
        .catch(reject);
    });
    if (acquired) return { id, duplicated };
    duplicated = true;
    id = randomId();
  }
  throw new Error('DEVICE_TAB_LOCKED');
}
