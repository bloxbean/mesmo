// Isolate lifecycle: use-after-close.
//
// close() tore the isolate down but left its stale handle reachable, so the next call handed it back
// to the native side and GraalVM aborted the *process* ("Failed to enter the specified IsolateThread
// context"). That is not a JS exception — try/catch could not see it, and no stack pointed at the
// call. Every example teaches `finally { bridge.close() }`, so any stray async callback racing that
// close would kill the process.

import { describe, expect, test } from 'bun:test';
import { CclBridge, CclClosedError, TESTNET } from '../src/index.js';

describe('use-after-close', () => {
  test('throws CclClosedError instead of aborting the process', () => {
    const bridge = new CclBridge();
    bridge.close();

    expect(() => bridge.accounts.create(TESTNET)).toThrow(CclClosedError);
    expect(() => bridge.version()).toThrow(CclClosedError);
  });

  test('the thrown error is a real Error with a name', () => {
    const bridge = new CclBridge();
    bridge.close();

    try {
      bridge.version();
      throw new Error('expected a throw');
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect(e.name).toBe('CclClosedError');
      expect(e.message).toContain('closed');
    }
  });

  test('close() is idempotent', () => {
    const bridge = new CclBridge();
    bridge.close();
    expect(() => bridge.close()).not.toThrow();
  });

  test('the process survives a use-after-close', () => {
    // The regression was a process abort, and an aborted process cannot report its own failure — an
    // in-process assertion would simply vanish along with the runtime. Prove it out-of-process.
    const code = `
      import { CclBridge, CclClosedError, TESTNET } from '${import.meta.dir}/../src/index.js';
      const b = new CclBridge();
      b.close();
      try { b.accounts.create(TESTNET); } catch (e) { if (e instanceof CclClosedError) console.log('raised'); }
      console.log('survived');
    `;
    const proc = Bun.spawnSync(['bun', '-e', code]);
    const stdout = proc.stdout.toString();

    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain('raised');
    expect(stdout).toContain('survived');
  });
});

describe('Symbol.dispose', () => {
  test('`using` closes the bridge at end of scope', () => {
    let escaped;
    {
      using bridge = new CclBridge();
      expect(bridge.version()).toBeTruthy();
      escaped = bridge;
    }
    // Out of scope: disposed, so it must now refuse rather than abort.
    expect(() => escaped.version()).toThrow(CclClosedError);
  });
});
