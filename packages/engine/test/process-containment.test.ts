import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { spawnLogged, STOPPED_BY_YOU } from '../src/util/spawn.js';
import { streamProcess } from '../src/util/stream.js';
import { assertStopped, cleanupDetached, detachedFixture as fixture } from './helpers/process-containment.js';

it.each(['exit', 'timeout', 'abort'])( 'contains a detached server on %s and preserves unrelated siblings', async mode => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-containment-'));
  const record = join(dir, 'child.json');
  const sibling = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    const result = await spawnLogged(process.execPath, [fixture, record, mode === 'exit' ? 'exit' : 'wait'], {
      timeoutMs: mode === 'timeout' ? 3000 : 15000,
      abortOn: mode === 'abort' ? line => line === 'READY' ? 'test abort' : undefined : undefined,
    });
    expect(result.code).toBe(mode === 'exit' ? 0 : mode === 'timeout' ? 124 : 125);
    await assertStopped(record);
    expect(() => process.kill(sibling.pid!, 0)).not.toThrow();
  } finally {
    sibling.kill('SIGKILL');
    cleanupDetached(record);
    rmSync(dir, { recursive: true, force: true });
  }
}, 25000);

it.each(['streamProcess', 'spawnLogged'])('%s kills the whole process tree when its signal aborts', async (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-stop-'));
  const record = join(dir, 'child.json');
  const ctl = new AbortController();
  try {
    const onLine = (line: string): void => { if (line === 'READY') ctl.abort(); };
    const args = [fixture, record, 'wait'];
    const result = fn === 'streamProcess'
      ? await streamProcess(process.execPath, args, { cwd: dir, timeoutMs: 15000, onLine, signal: ctl.signal })
      : await spawnLogged(process.execPath, args, { timeoutMs: 15000, abortOn: (line) => { onLine(line); return undefined; }, signal: ctl.signal });
    expect(result).toMatchObject({ code: 125, timedOut: false, aborted: STOPPED_BY_YOU });
    await assertStopped(record);
  } finally {
    cleanupDetached(record);
    rmSync(dir, { recursive: true, force: true });
  }
}, 25000);
