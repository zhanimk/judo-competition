import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startProcess } from '../process-group.mjs';

test(
  'shutdown stops an npm-style child and its server descendant',
  { skip: process.platform === 'win32', timeout: 7000 },
  async () => {
    const program =
      "const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(c.pid); setInterval(()=>{},1000);";
    const managed = startProcess(process.execPath, ['-e', program], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const pid = await new Promise((resolve, reject) => {
        managed.child.stdout.once('data', (chunk) => resolve(Number(chunk.toString().trim())));
        managed.child.once('error', reject);
        managed.child.once('exit', () =>
          reject(new Error('fixture exited before starting descendant')),
        );
      });
      assert.ok(Number.isInteger(pid) && pid > 0);
      await managed.stop();
      const deadline = Date.now() + 2000;
      let alive = true;
      while (alive && Date.now() < deadline) {
        try {
          process.kill(pid, 0);
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
          alive = false;
        }
        if (alive) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(alive, false, 'server descendant must exit with its parent');
      await managed.stop();
    } finally {
      await managed.stop();
    }
  },
);

test('failed process startup resolves with an error instead of hanging', async () => {
  const managed = startProcess('/nonexistent/judo-command', [], { stdio: 'ignore' });
  const result = await managed.done;
  assert.equal(result.code, 1);
  assert.equal(result.error.code, 'ENOENT');
  await managed.stop();
});

test(
  'shutdown waits for a server descendant to save before terminating it',
  { skip: process.platform === 'win32', timeout: 7000 },
  async () => {
    const server =
      "process.on('SIGTERM',()=>setTimeout(()=>{console.log('SAVED');process.exit(0)},100)); console.log('READY'); setInterval(()=>{},1000);";
    const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(server)}],{stdio:['ignore',process.stdout,'ignore']}); setInterval(()=>{},1000);`;
    const managed = startProcess(process.execPath, ['-e', parent], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    try {
      await new Promise((resolve, reject) => {
        managed.child.stdout.on('data', (chunk) => {
          output += chunk;
          if (output.includes('READY')) resolve();
        });
        managed.child.once('error', reject);
      });
      await managed.stop();
      assert.ok(output.includes('SAVED'), 'API must finish graceful persistence after npm exits');
    } finally {
      await managed.stop();
    }
  },
);
