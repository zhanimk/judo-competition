/** One authoritative read at a time. Notices during a read request one fresh read afterwards. */
export function pollSnapshots<T>(
  read: () => Promise<T>,
  onValue: (value: T) => void,
  onError: (error: unknown) => void,
  intervalMs: number,
) {
  let active = true;
  let pending = false;
  let inFlight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function refresh(): Promise<void> {
    clearTimeout(timer);
    if (!active) return;
    pending = true;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      while (active && pending) {
        pending = false;
        try {
          const value = await read();
          if (active) onValue(value);
        } catch (error) {
          if (active) onError(error);
        }
      }
    })();
    try {
      await inFlight;
    } finally {
      inFlight = null;
      if (active) timer = setTimeout(() => void refresh(), intervalMs);
    }
  }

  return {
    refresh,
    stop() {
      active = false;
      pending = false;
      clearTimeout(timer);
    },
  };
}
