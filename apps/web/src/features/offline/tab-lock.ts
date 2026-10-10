type TabLocks = {
  request: (
    name: string,
    options: { ifAvailable: true },
    callback: (lock: unknown) => Promise<void>,
  ) => Promise<unknown>;
};
export type JournalTabLock = { done: Promise<void>; cancel: (drain: Promise<unknown>) => void };
/** Cancelled effect setups never request a lock; a replacement waits for its own cleanup only. */
export function startJournalTabLock(
  locks: TabLocks,
  name: string,
  callbacks: {
    acquired: (active: () => boolean) => Promise<void>;
    unavailable: () => void;
    released: () => void;
    failed: (problem: unknown) => void;
  },
  previous?: Promise<unknown>,
): JournalTabLock {
  let active = true,
    release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = Promise.resolve()
    .then(async () => {
      await previous;
      if (!active) return;
      await locks.request(name, { ifAvailable: true }, async (lock) => {
        if (!active) return;
        if (!lock) {
          callbacks.unavailable();
          return;
        }
        try {
          await callbacks.acquired(() => active);
          await released;
        } finally {
          callbacks.released();
        }
      });
    })
    .catch((problem: unknown) => {
      if (active) callbacks.failed(problem);
    });
  return {
    done,
    cancel(drain) {
      active = false;
      // Keep the browser lock until already-started journal writes have settled.
      void drain.then(release, release);
    },
  };
}
