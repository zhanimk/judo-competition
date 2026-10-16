import { spawn } from 'node:child_process';

// npm launches grandchildren; killing npm alone leaves API/web processes behind.
export function startProcess(file, args, options = {}) {
  const { stopGraceMs = 3000, ...spawnOptions } = options;
  const grouped = process.platform !== 'win32';
  const child = spawn(file, args, { ...spawnOptions, detached: grouped });
  const done = new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: 1, error }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  function signalGroup(signal) {
    if (!child.pid) return;
    try {
      if (grouped) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  function alive() {
    if (!child.pid) return false;
    if (!grouped) return child.exitCode === null && child.signalCode === null;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      throw error;
    }
  }
  let stopping;
  return {
    child,
    done,
    stop() {
      return (stopping ??= (async () => {
        signalGroup('SIGTERM');
        // The npm parent can exit before the API has finished saving its clocks.
        const deadline = Date.now() + stopGraceMs;
        while (alive() && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 20));
        if (alive()) signalGroup('SIGKILL');
        await done;
      })());
    },
  };
}
