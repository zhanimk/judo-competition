import { startProcess } from './process-group.mjs';

const running = new Set();
let stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  await Promise.all([...running].map((process) => process.stop()));
}
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
])
  process.on(signal, () => void stop(code));

function start(args) {
  const process = startProcess('npm', args, { stdio: 'inherit' });
  running.add(process);
  return process;
}
const build = start(['run', 'build', '-w', '@judo/api']);
const result = await build.done;
if (result.error) console.error(result.error.message);
if (!stopping && result.code === 0) {
  running.delete(build);
  const services = [
    start(['run', 'start', '-w', '@judo/api']),
    start(['run', 'dev', '-w', '@judo/web']),
  ];
  for (const service of services)
    void service.done.then((result) => {
      if (result.error) console.error(result.error.message);
      return stop(result.code ?? 1);
    });
} else if (!stopping) await stop(result.code ?? 1);
