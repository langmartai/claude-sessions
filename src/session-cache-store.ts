/**
 * Session Cache Store — LMDB-backed storage adapter
 *
 * Replaces the old Memory Map + .cache.gz disk files with a single
 * memory-mapped LMDB database. Reads are synchronous and instant
 * (served directly from mmap'd pages by the OS), writes are async
 * and auto-batched by lmdb-js.
 *
 * Storage layout:
 *   ~/.claude-sessions/session-cache/
 *     session-cache.lmdb
 *       ├── sessions (sub-db)     # key: sessionPath → value: SessionCacheData
 *       ├── raw (sub-db)          # key: sessionPath → value: RawMessagesCache
 *       └── meta (sub-db)         # key: "stats"|"version" → value: metadata
 */

import { open, RootDatabase, Database } from 'lmdb';
import * as path from 'path';
import * as fs from 'fs';
import type { SessionCacheData, RawMessagesCache } from './session-cache';

const DEFAULT_CACHE_DIR = path.join(
  process.env.CLAUDE_SESSIONS_CACHE_DIR ||
  path.join(require('os').homedir(), '.claude-sessions'),
  'session-cache'
);

export class SessionCacheStore {
  private env: RootDatabase;
  private sessionsDb: Database<SessionCacheData, string>;
  private rawDb: Database<RawMessagesCache, string>;
  private metaDb: Database<any, string>;
  private _closed = false;
  private _path: string;

  constructor(cacheDir?: string) {
    const dir = cacheDir || DEFAULT_CACHE_DIR;
    this._path = dir;

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Startup cleanup: if a previous compact flagged for file deletion,
    // delete the old data.mdb before opening LMDB so it creates a fresh file.
    const compactFlag = path.join(dir, '.compact-pending');
    if (fs.existsSync(compactFlag)) {
      const dataFile = path.join(dir, 'data.mdb');
      const lockFile = path.join(dir, 'lock.mdb');
      for (const f of [dataFile, lockFile]) {
        try { fs.unlinkSync(f); } catch { /* ok — may not exist */ }
      }
      try {
        for (const f of fs.readdirSync(dir)) {
          if (f.endsWith('.old')) {
            try { fs.unlinkSync(path.join(dir, f)); } catch { /* ok */ }
          }
        }
      } catch { /* ok */ }
      try { fs.unlinkSync(compactFlag); } catch { /* ok */ }
    }

    this.env = open({
      path: dir,
      compression: true,
      maxDbs: 3,
      mapSize: 2 * 1024 * 1024 * 1024,
    });

    this.sessionsDb = this.env.openDB('sessions', {
      encoding: 'msgpack',
    });
    this.rawDb = this.env.openDB('raw', {
      encoding: 'msgpack',
    });
    this.metaDb = this.env.openDB('meta', {
      encoding: 'msgpack',
    });
  }

  // ─── Session Data ────────────────────────────────────────

  getSessionData(sessionPath: string): SessionCacheData | undefined {
    return this.sessionsDb.get(sessionPath);
  }

  async putSessionData(sessionPath: string, data: SessionCacheData): Promise<void> {
    await this.sessionsDb.put(sessionPath, data);
  }

  async removeSessionData(sessionPath: string): Promise<void> {
    await this.sessionsDb.remove(sessionPath);
  }

  // ─── Raw Messages ────────────────────────────────────────

  getRawMessages(sessionPath: string): RawMessagesCache | undefined {
    return this.rawDb.get(sessionPath);
  }

  async putRawMessages(sessionPath: string, data: RawMessagesCache): Promise<void> {
    await this.rawDb.put(sessionPath, data);
  }

  async removeRawMessages(sessionPath: string): Promise<void> {
    await this.rawDb.remove(sessionPath);
  }

  // ─── Iteration ───────────────────────────────────────────

  *allSessions(): IterableIterator<{ key: string; value: SessionCacheData }> {
    for (const { key, value } of this.sessionsDb.getRange()) {
      yield { key: key as string, value };
    }
  }

  get sessionCount(): number {
    return this.sessionsDb.getCount();
  }

  get rawCount(): number {
    return this.rawDb.getCount();
  }

  // ─── Meta ────────────────────────────────────────────────

  getMeta(key: string): any {
    return this.metaDb.get(key);
  }

  async putMeta(key: string, value: any): Promise<void> {
    await this.metaDb.put(key, value);
  }

  // ─── Housekeeping ────────────────────────────────────────

  async clear(sessionPath?: string): Promise<void> {
    if (sessionPath) {
      await this.sessionsDb.remove(sessionPath);
      await this.rawDb.remove(sessionPath);
    } else {
      await this.sessionsDb.clearAsync();
      await this.rawDb.clearAsync();
    }
  }

  async compact(): Promise<{ beforeSize: number; afterSize: number }> {
    const dataFile = path.join(this._path, 'data.mdb');

    let beforeSize = 0;
    try { beforeSize = fs.statSync(dataFile).size; } catch { /* ok */ }

    await this.sessionsDb.clearAsync();
    await this.rawDb.clearAsync();
    await this.metaDb.clearAsync();

    let deleted = false;
    this.close();
    await new Promise(resolve => setTimeout(resolve, 500));

    try {
      fs.unlinkSync(dataFile);
      try { fs.unlinkSync(path.join(this._path, 'lock.mdb')); } catch { /* ok */ }
      deleted = true;
    } catch {
      const compactFlag = path.join(this._path, '.compact-pending');
      fs.writeFileSync(compactFlag, new Date().toISOString());
    }

    try {
      for (const f of fs.readdirSync(this._path)) {
        if (f.endsWith('.old')) {
          try { fs.unlinkSync(path.join(this._path, f)); } catch { /* ok */ }
        }
      }
    } catch { /* ok */ }

    this._closed = false;
    this.env = open({
      path: this._path,
      compression: true,
      maxDbs: 3,
      mapSize: 2 * 1024 * 1024 * 1024,
    });
    this.sessionsDb = this.env.openDB('sessions', { encoding: 'msgpack' });
    this.rawDb = this.env.openDB('raw', { encoding: 'msgpack' });
    this.metaDb = this.env.openDB('meta', { encoding: 'msgpack' });

    let afterSize = 0;
    try { afterSize = fs.statSync(dataFile).size; } catch { /* ok */ }

    return { beforeSize, afterSize };
  }

  getPath(): string {
    return this._path;
  }

  close(): void {
    if (!this._closed) {
      this._closed = true;
      this.env.close();
    }
  }

  get closed(): boolean {
    return this._closed;
  }
}
