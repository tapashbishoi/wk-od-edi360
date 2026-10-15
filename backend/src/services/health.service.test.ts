import { describe, it, expect } from 'vitest';
import { workerLevel } from './health.service.js';
import type { WorkerStatus } from '../utils/runStatus.js';

const status = (over: Partial<WorkerStatus> = {}): WorkerStatus => ({ started: true, busy: false, lastRunAt: '2026-10-08T01:00:00.000Z', lastError: null, ...over });

describe('workerLevel', () => {
  it('is fine when a disabled worker is not running', () => {
    expect(workerLevel(false, status({ started: false })).level).toBe('ok');
  });
  it('is down when an enabled worker is not running', () => {
    expect(workerLevel(true, status({ started: false }))).toMatchObject({ level: 'down', detail: 'Not running' });
  });
  it('warns when the last pass failed, with the reason', () => {
    expect(workerLevel(true, status({ lastError: 'connection reset' }))).toEqual({ level: 'warn', detail: 'Last pass failed: connection reset' });
  });
  it('is fine before the first pass and after a clean one', () => {
    expect(workerLevel(true, status({ lastRunAt: null })).level).toBe('ok');
    expect(workerLevel(true, status()).detail).toMatch(/Last pass 2026-10-08/);
    expect(workerLevel(true, status({ busy: true })).detail).toMatch(/running now/);
  });
});
