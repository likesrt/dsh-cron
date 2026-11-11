/**
 * Cross-process tick lock.
 *
 * The in-process guard already prevents overlapping ticks; this file keeps a
 * second host process (a dev profile, a rescue boot) from running the same due
 * tasks twice. A lock older than the TTL or owned by a dead pid is reclaimed.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_TTL_MS = 300_000;

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export class TickLock {
  constructor(directory, { ttlMs = DEFAULT_TTL_MS, logger } = {}) {
    this.file = path.join(directory, '.tick.lock');
    this.ttlMs = ttlMs;
    this.logger = logger ?? console;
    this.held = false;
  }

  async acquire() {
    if (this.held) return true;
    const payload = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await fs.open(this.file, 'wx');
        await handle.writeFile(payload, 'utf8');
        await handle.close();
        this.held = true;
        return true;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const stale = await this.#stale();
        if (!stale) return false;
        await this.release({ force: true });
      }
    }
    return false;
  }

  async #stale() {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      const age = Date.now() - Date.parse(parsed?.at ?? 0);
      if (!Number.isFinite(age) || age > this.ttlMs) return true;
      return !alive(parsed?.pid);
    } catch {
      // Unreadable or half-written lock: treat as stale.
      return true;
    }
  }

  async release({ force = false } = {}) {
    if (!this.held && !force) return;
    this.held = false;
    try {
      await fs.unlink(this.file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}
