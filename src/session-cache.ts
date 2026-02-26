/**
 * Session Cache Layer — LMDB-backed
 *
 * Provides efficient caching for Claude Code session JSONL files.
 * Uses LMDB (memory-mapped database) as the storage backend for
 * instant reads with zero warmup on server startup.
 *
 * Key optimizations:
 * 1. LMDB memory-mapped reads — sync ~0ms via OS page cache
 * 2. Incremental parsing — only parse new lines when file grows (append-only)
 * 3. Line index tracking for efficient delta updates
 * 4. Separate sub-database for raw messages (optional, large)
 * 5. Async batched writes via lmdb-js
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { SessionCacheStore } from './session-cache-store';
import { legacyEncodeProjectPath } from './utils/path-utils';
import { CostCalculator } from './cost-calculator';

// ─── Optional chokidar ──────────────────────────────────────────────────
// chokidar is an optional dependency. File watching is disabled if not installed.

type FSWatcher = { close(): Promise<void> | void };
let chokidarWatch: ((paths: string | readonly string[], options?: any) => FSWatcher) | null = null;
try {
  const chokidar = require('chokidar');
  chokidarWatch = chokidar.watch || chokidar.default?.watch;
} catch {
  // chokidar not installed — file watching will be disabled
}

// ─── Types ──────────────────────────────────────────────────

export type PromptType = 'user' | 'command' | 'command_output' | 'system_caveat' | 'hook_result';

export interface CachedUserPrompt {
  turnIndex: number;
  lineIndex: number;
  text: string;
  images?: number;
  timestamp?: string;
  promptType?: PromptType;
}

export function classifyUserPrompt(text: string, isMeta?: boolean): PromptType {
  const trimmed = text.trimStart();
  if (isMeta || trimmed.startsWith('<local-command-caveat>')) return 'system_caveat';
  if (trimmed.startsWith('<command-name>')) return 'command';
  if (trimmed.startsWith('<local-command-stdout>')) return 'command_output';
  if (trimmed.startsWith('<user-prompt-submit-hook>')) return 'hook_result';
  return 'user';
}

export function isRealUserPrompt(prompt: CachedUserPrompt): boolean {
  return !prompt.promptType || prompt.promptType === 'user';
}

export interface CachedToolUse {
  id: string;
  name: string;
  input: any;
  turnIndex: number;
  lineIndex: number;
}

export interface CachedResponse {
  turnIndex: number;
  lineIndex: number;
  text: string;
  isApiError?: boolean;
  requestId?: string;
}

export interface CachedThinkingBlock {
  turnIndex: number;
  lineIndex: number;
  thinking: string;
}

export interface CachedTask {
  id: string;
  subject: string;
  description?: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'deleted';
  blocks: string[];
  blockedBy: string[];
  owner?: string;
  metadata?: Record<string, unknown>;
  turnIndex: number;
  lineIndex: number;
}

export interface CachedTodo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
  lineIndex: number;
}

export interface CachedPlan {
  toolUseId: string;
  status: 'entering' | 'approved';
  planFile?: string;
  planTitle?: string;
  planSummary?: string;
  allowedPrompts?: Array<{ tool: string; prompt: string }>;
  turnIndex: number;
  lineIndex: number;
}

export interface CachedSubagent {
  agentId: string;
  toolUseId: string;
  type: string;
  prompt: string;
  description?: string;
  model?: string;
  turnIndex: number;
  lineIndex: number;
  userPromptIndex: number;
  parentUuid?: string;
  startedAt?: string;
  completedAt?: string;
  status: string;
  result?: string;
  runInBackground?: boolean;
}

export interface CachedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface CachedModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costUsd: number;
  messageCount: number;
}

export interface SessionCacheData {
  version: number;
  sessionId: string;
  filePath: string;
  fileSize: number;
  fileMtime: number;
  lastLineIndex: number;
  lastTurnIndex: number;
  lastByteOffset?: number;
  createdAt: number;

  cwd: string;
  model: string;
  claudeCodeVersion: string;
  permissionMode: string;
  tools: string[];
  mcpServers: Array<{ name: string; status: string }>;
  systemPrompt?: string;

  userPrompts: CachedUserPrompt[];
  toolUses: CachedToolUse[];
  responses: CachedResponse[];
  thinkingBlocks: CachedThinkingBlock[];

  tasks: CachedTask[];
  todos: CachedTodo[];
  subagents: CachedSubagent[];
  subagentProgress: any[];
  plans: CachedPlan[];

  teamName?: string;
  allTeams: string[];
  teamOperations: Array<{ operation: 'spawnTeam' | 'cleanup'; teamName?: string; description?: string; turnIndex: number; lineIndex: number }>;
  teamMessages: Array<{ messageType: 'message' | 'broadcast' | 'shutdown_request' | 'shutdown_response' | 'plan_approval_response'; recipient?: string; content?: string; summary?: string; requestId?: string; approve?: boolean; turnIndex: number; lineIndex: number }>;

  numTurns: number;
  durationMs: number;
  durationApiMs: number;
  totalCostUsd: number;
  cumulativeCostUsd: number;
  usage: CachedUsage;
  modelUsage: Record<string, CachedModelUsage>;

  result?: string;
  errors?: string[];
  success: boolean;

  forkedFromSessionId?: string;
  forkPointUuid?: string;

  firstTimestamp?: string;
  lastTimestamp?: string;
}

export interface RawMessagesCache {
  version: number;
  sessionId: string;
  fileSize: number;
  fileMtime: number;
  lastLineIndex: number;
  lastByteOffset?: number;
  messages: Array<any & { lineIndex: number }>;
}

// ─── Constants ──────────────────────────────────────────────────

const CACHE_VERSION = 9;

// ─── SessionCache Class ──────────────────────────────────────────────────

export class SessionCache {
  private store: SessionCacheStore;

  private watcher: FSWatcher | null = null;
  private watchedPaths: Set<string> = new Set();
  private pendingUpdates: Map<string, NodeJS.Timeout> = new Map();
  private updateDebounceMs = 500;
  private isWatching = false;

  private onChangeCallbacks: Array<(sessionId: string, cacheData: SessionCacheData) => void> = [];
  private onFileEventCallbacks: Array<(event: 'add' | 'change' | 'unlink', filePath: string) => void> = [];

  constructor(cacheDir?: string) {
    const dir = cacheDir || path.join(
      process.env.CLAUDE_SESSIONS_CACHE_DIR ||
      path.join(os.homedir(), '.claude-sessions'),
      'session-cache'
    );
    this.store = new SessionCacheStore(dir);
  }

  onSessionChange(cb: (sessionId: string, cacheData: SessionCacheData) => void): void {
    this.onChangeCallbacks.push(cb);
  }

  onFileEvent(cb: (event: 'add' | 'change' | 'unlink', filePath: string) => void): void {
    this.onFileEventCallbacks.push(cb);
  }

  private fireFileEvent(event: 'add' | 'change' | 'unlink', filePath: string): void {
    for (const cb of this.onFileEventCallbacks) {
      try { cb(event, filePath); } catch { /* ignore */ }
    }
  }

  private fireOnChange(cacheData: SessionCacheData): void {
    if (this.onChangeCallbacks.length === 0 || !cacheData.sessionId) return;
    for (const cb of this.onChangeCallbacks) {
      try { cb(cacheData.sessionId, cacheData); } catch { /* ignore */ }
    }
  }

  /**
   * Start watching session directories for file changes.
   * Requires chokidar to be installed (optional dependency).
   * Returns false if chokidar is not available.
   */
  startWatching(projectPaths?: string[]): boolean {
    if (this.isWatching) return true;
    if (!chokidarWatch) return false;

    const projectsDir = path.join(os.homedir(), '.claude', 'projects');

    const watchPaths: string[] = [];
    if (projectPaths && projectPaths.length > 0) {
      for (const projectPath of projectPaths) {
        const projectKey = legacyEncodeProjectPath(projectPath);
        const projectDir = path.join(projectsDir, projectKey);
        if (fs.existsSync(projectDir)) {
          watchPaths.push(projectDir);
        }
      }
    } else {
      if (fs.existsSync(projectsDir)) {
        watchPaths.push(projectsDir);
      }
    }

    if (watchPaths.length === 0) {
      return false;
    }

    this.watcher = chokidarWatch(watchPaths, {
      persistent: true,
      ignoreInitial: true,
      depth: 3,
      ignored: [
        /node_modules/,
        /\.git/,
        /\.lmdb/,
      ],
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });

    const watcher = this.watcher as any;

    watcher.on('add', (filePath: string) => {
      if (filePath.endsWith('.jsonl')) {
        this.fireFileEvent('add', filePath);
        this.scheduleUpdate(filePath);
      }
    });

    watcher.on('change', (filePath: string) => {
      if (filePath.endsWith('.jsonl')) {
        this.fireFileEvent('change', filePath);
        this.scheduleUpdate(filePath);
      }
    });

    watcher.on('unlink', (filePath: string) => {
      if (filePath.endsWith('.jsonl')) {
        this.fireFileEvent('unlink', filePath);
      }
    });

    watcher.on('error', (error: Error) => {
      console.error('[SessionCache] Watcher error:', error);
    });

    this.isWatching = true;
    watchPaths.forEach(p => this.watchedPaths.add(p));
    return true;
  }

  stopWatching(): void {
    if (this.watcher) {
      (this.watcher as any).close();
      this.watcher = null;
    }
    this.isWatching = false;
    this.watchedPaths.clear();

    for (const timeout of this.pendingUpdates.values()) {
      clearTimeout(timeout);
    }
    this.pendingUpdates.clear();
  }

  private scheduleUpdate(filePath: string): void {
    const existing = this.pendingUpdates.get(filePath);
    if (existing) {
      clearTimeout(existing);
    }

    const timeout = setTimeout(() => {
      this.pendingUpdates.delete(filePath);
      this.warmCache(filePath).catch(() => {});
    }, this.updateDebounceMs);

    this.pendingUpdates.set(filePath, timeout);
  }

  async warmCache(filePath: string): Promise<void> {
    if (!fs.existsSync(filePath)) return;
    try {
      await this.getSessionData(filePath);
    } catch {
      // Silently ignore errors during background warming
    }
  }

  async warmProjectCache(projectPath: string): Promise<{ warmed: number; errors: number }> {
    const projectKey = legacyEncodeProjectPath(projectPath);
    const projectDir = path.join(os.homedir(), '.claude', 'projects', projectKey);

    if (!fs.existsSync(projectDir)) {
      return { warmed: 0, errors: 0 };
    }

    let warmed = 0;
    let errors = 0;

    const files: string[] = [];

    const mainFiles = fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => path.join(projectDir, f));
    files.push(...mainFiles);

    const entries = fs.readdirSync(projectDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subagentsDir = path.join(projectDir, entry.name, 'subagents');
        if (fs.existsSync(subagentsDir)) {
          const agentFiles = fs.readdirSync(subagentsDir)
            .filter(f => f.endsWith('.jsonl'))
            .map(f => path.join(subagentsDir, f));
          files.push(...agentFiles);
        }
      }
    }

    const CONCURRENCY = 10;
    for (let i = 0; i < files.length; i += CONCURRENCY) {
      const batch = files.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(f => this.warmCache(f))
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          warmed++;
        } else {
          errors++;
        }
      }
    }

    return { warmed, errors };
  }

  getCacheStats(): {
    memoryCacheSize: number;
    rawMemoryCacheSize: number;
    isWatching: boolean;
    watchedPaths: string[];
    pendingUpdates: number;
    lmdb: {
      sessionCount: number;
      rawCount: number;
    };
  } {
    return {
      memoryCacheSize: this.store.sessionCount,
      rawMemoryCacheSize: this.store.rawCount,
      isWatching: this.isWatching,
      watchedPaths: Array.from(this.watchedPaths),
      pendingUpdates: this.pendingUpdates.size,
      lmdb: {
        sessionCount: this.store.sessionCount,
        rawCount: this.store.rawCount,
      },
    };
  }

  private isCacheValid(cache: SessionCacheData | null, stats: fs.Stats): 'valid' | 'append' | 'invalid' {
    if (!cache) return 'invalid';
    if (cache.version !== CACHE_VERSION) return 'invalid';

    const fileMtime = stats.mtime.getTime();
    const fileSize = stats.size;

    if (fileSize < cache.fileSize) return 'invalid';
    if (fileMtime < cache.fileMtime) return 'invalid';
    if (fileSize === cache.fileSize && fileMtime === cache.fileMtime) return 'valid';
    if (fileSize > cache.fileSize) return 'append';

    return 'invalid';
  }

  private async parseNewLines(
    sessionPath: string,
    startLineIndex: number,
    startTurnIndex: number,
    existingCache: SessionCacheData
  ): Promise<{
    newMessages: Array<any & { lineIndex: number }>;
    lastLineIndex: number;
    lastTurnIndex: number;
    lastByteOffset: number;
  }> {
    const newMessages: Array<any & { lineIndex: number }> = [];

    const cachedLineIndexes = new Set<number>();
    for (const p of existingCache.userPrompts) cachedLineIndexes.add(p.lineIndex);
    for (const t of existingCache.toolUses) cachedLineIndexes.add(t.lineIndex);
    for (const r of existingCache.responses) cachedLineIndexes.add(r.lineIndex);
    for (const tb of existingCache.thinkingBlocks) cachedLineIndexes.add(tb.lineIndex);

    let lineIndex: number;
    let turnIndex = startTurnIndex;
    let byteOffset: number;

    if (existingCache.lastByteOffset && existingCache.lastByteOffset > 0) {
      const fileStream = fs.createReadStream(sessionPath, { start: existingCache.lastByteOffset });
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      lineIndex = startLineIndex + 1;
      byteOffset = existingCache.lastByteOffset;

      for await (const line of rl) {
        byteOffset += Buffer.byteLength(line, 'utf8') + 1;
        if (line.trim() && !cachedLineIndexes.has(lineIndex)) {
          try {
            const msg = JSON.parse(line);
            newMessages.push({ ...msg, lineIndex });
            if (msg.type === 'assistant') {
              turnIndex++;
            }
          } catch {
            // Skip invalid JSON
          }
        }
        lineIndex++;
      }
    } else {
      const fileStream = fs.createReadStream(sessionPath);
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      lineIndex = 0;
      byteOffset = 0;

      for await (const line of rl) {
        byteOffset += Buffer.byteLength(line, 'utf8') + 1;
        if (lineIndex > startLineIndex && line.trim() && !cachedLineIndexes.has(lineIndex)) {
          try {
            const msg = JSON.parse(line);
            newMessages.push({ ...msg, lineIndex });
            if (msg.type === 'assistant') {
              turnIndex++;
            }
          } catch {
            // Skip invalid JSON
          }
        }
        lineIndex++;
      }
    }

    return {
      newMessages,
      lastLineIndex: lineIndex - 1,
      lastTurnIndex: turnIndex,
      lastByteOffset: byteOffset,
    };
  }

  private mergeNewMessages(
    cache: SessionCacheData,
    newMessages: Array<any & { lineIndex: number }>,
    stats: fs.Stats
  ): SessionCacheData {
    const updated: SessionCacheData = JSON.parse(JSON.stringify(cache));
    updated.fileSize = stats.size;
    updated.fileMtime = stats.mtime.getTime();

    if (updated.cumulativeCostUsd === undefined) updated.cumulativeCostUsd = 0;
    if (!updated.modelUsage) updated.modelUsage = {};

    let turnIndex = cache.lastTurnIndex;
    let lastTimestamp: string | undefined = cache.lastTimestamp;

    for (const msg of newMessages) {
      if (msg.timestamp) {
        lastTimestamp = msg.timestamp;
      }

      if (!updated.sessionId && msg.sessionId) {
        const fileBasedId = path.basename(updated.filePath, '.jsonl');
        if (msg.sessionId !== fileBasedId && !fileBasedId.startsWith('agent-')) {
          updated.forkedFromSessionId = msg.sessionId;
          updated.forkPointUuid = msg.parentUuid || undefined;
        } else if (msg.forkedFrom?.sessionId) {
          updated.forkedFromSessionId = msg.forkedFrom.sessionId;
          updated.forkPointUuid = msg.forkedFrom.messageUuid || undefined;
        }
        updated.sessionId = msg.sessionId;
      }
      if (!updated.cwd && msg.cwd) {
        updated.cwd = msg.cwd;
      }
      if (!updated.claudeCodeVersion && msg.version) {
        updated.claudeCodeVersion = msg.version;
      }
      if (!updated.teamName && msg.teamName) {
        updated.teamName = msg.teamName;
      }

      if (msg.type === 'system' && msg.subtype === 'init') {
        updated.sessionId = msg.session_id || updated.sessionId;
        updated.cwd = msg.cwd || updated.cwd;
        updated.model = msg.model || updated.model;
        updated.claudeCodeVersion = msg.claude_code_version || updated.claudeCodeVersion;
        updated.permissionMode = msg.permissionMode || updated.permissionMode;
        updated.tools = msg.tools || updated.tools;
        updated.mcpServers = msg.mcp_servers || updated.mcpServers;
      }

      if (msg.type === 'user') {
        const content = msg.message?.content;
        let text = '';
        let images = 0;

        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') text += block.text;
            if (block.type === 'image') images++;
          }
        } else if (typeof content === 'string') {
          text = content;
        }

        if (text || images > 0) {
          const promptType = classifyUserPrompt(text, msg.isMeta);
          updated.userPrompts.push({
            turnIndex,
            lineIndex: msg.lineIndex,
            text,
            images: images > 0 ? images : undefined,
            timestamp: msg.timestamp,
            promptType: promptType !== 'user' ? promptType : undefined,
          });
        }

        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              let resultText = '';
              if (typeof block.content === 'string') {
                resultText = block.content;
              } else if (Array.isArray(block.content)) {
                resultText = block.content
                  .filter((b: any) => b.type === 'text' && b.text)
                  .map((b: any) => b.text)
                  .join('\n');
              }

              const taskCreateMatch = resultText.match(/Task #(\d+) created successfully/);
              if (taskCreateMatch) {
                const assignedId = taskCreateMatch[1];
                const tempId = `temp-${block.tool_use_id}`;
                const tempIdx = updated.tasks.findIndex(t => t.id === tempId);
                if (tempIdx >= 0) {
                  updated.tasks[tempIdx].id = assignedId;
                }
              }

              const subagent = updated.subagents.find(s => s.toolUseId === block.tool_use_id);
              if (subagent && subagent.status !== 'completed' && resultText) {
                subagent.status = block.is_error ? 'error' : 'completed';
                subagent.result = resultText;
                subagent.completedAt = msg.timestamp || new Date().toISOString();
              }
            }
          }
        }
      }

      if (msg.type === 'assistant') {
        turnIndex++;

        if (msg.message?.model) {
          updated.model = msg.message.model;
        }

        const isApiError = !!(msg.isApiErrorMessage || msg.error);

        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              if (isApiError) {
                let requestId: string | undefined;
                const reqMatch = block.text.match(/"request_id"\s*:\s*"([^"]+)"/);
                if (reqMatch) requestId = reqMatch[1];
                updated.responses.push({
                  turnIndex,
                  lineIndex: msg.lineIndex,
                  text: block.text,
                  isApiError: true,
                  requestId,
                });
              } else {
                updated.responses.push({
                  turnIndex,
                  lineIndex: msg.lineIndex,
                  text: block.text,
                });
              }
            }

            if (block.type === 'tool_use' && block.id && block.name) {
              updated.toolUses.push({
                id: block.id,
                name: block.name,
                input: block.input,
                turnIndex,
                lineIndex: msg.lineIndex,
              });

              if (!updated.tools.includes(block.name)) {
                updated.tools.push(block.name);
              }

              if (block.name === 'TaskCreate' && block.input) {
                const input = block.input;
                const tempId = `temp-${block.id}`;
                updated.tasks.push({
                  id: tempId,
                  subject: input.subject || '',
                  description: input.description,
                  activeForm: input.activeForm,
                  status: 'pending',
                  blocks: [],
                  blockedBy: input.blockedBy || [],
                  owner: input.owner,
                  metadata: input.metadata,
                  turnIndex,
                  lineIndex: msg.lineIndex,
                });
              }

              if (block.name === 'TaskUpdate' && block.input) {
                const input = block.input;
                const taskId = input.taskId;
                if (taskId) {
                  const existingIdx = updated.tasks.findIndex(t => t.id === taskId);
                  if (existingIdx >= 0) {
                    const existing = updated.tasks[existingIdx];
                    if (input.status) existing.status = input.status;
                    if (input.subject) existing.subject = input.subject;
                    if (input.description) existing.description = input.description;
                    if (input.activeForm) existing.activeForm = input.activeForm;
                    if (input.owner !== undefined) existing.owner = input.owner;
                    if (input.addBlocks) existing.blocks.push(...input.addBlocks);
                    if (input.addBlockedBy) existing.blockedBy.push(...input.addBlockedBy);
                    if (input.metadata) {
                      existing.metadata = existing.metadata || {};
                      for (const [k, v] of Object.entries(input.metadata)) {
                        if (v === null) {
                          delete existing.metadata[k];
                        } else {
                          existing.metadata[k] = v;
                        }
                      }
                    }
                    existing.turnIndex = turnIndex;
                    existing.lineIndex = msg.lineIndex;
                  } else if (input.status !== 'deleted') {
                    updated.tasks.push({
                      id: taskId,
                      subject: input.subject || `Task #${taskId}`,
                      description: input.description,
                      activeForm: input.activeForm,
                      status: input.status || 'pending',
                      blocks: input.addBlocks || [],
                      blockedBy: input.addBlockedBy || [],
                      owner: input.owner,
                      metadata: input.metadata,
                      turnIndex,
                      lineIndex: msg.lineIndex,
                    });
                  }
                }
              }

              if (block.name === 'EnterPlanMode') {
                updated.plans.push({
                  toolUseId: block.id,
                  status: 'entering',
                  turnIndex,
                  lineIndex: msg.lineIndex,
                });
              }

              if (block.name === 'ExitPlanMode' && block.input) {
                const input = block.input;
                const planContent: string = input.plan || '';
                const titleMatch = planContent.match(/^#\s+(.+)/m);
                const planTitle = titleMatch ? titleMatch[1].trim() : undefined;
                const planSummary = planContent.length > 300
                  ? planContent.slice(0, 300) + '...'
                  : planContent || undefined;

                const pendingFile = (updated as any)._pendingPlanFile;

                updated.plans.push({
                  toolUseId: block.id,
                  status: 'approved',
                  planFile: pendingFile,
                  planTitle,
                  planSummary,
                  allowedPrompts: input.allowedPrompts,
                  turnIndex,
                  lineIndex: msg.lineIndex,
                });

                delete (updated as any)._pendingPlanFile;
              }

              if ((block.name === 'Write' || block.name === 'Edit') && block.input) {
                const filePath: string = block.input.file_path || '';
                const planMatch = filePath.match(/\.claude\/plans\/([^\s/]+\.md)$/);
                if (planMatch) {
                  const planFileName = planMatch[1];
                  let attached = false;
                  for (let pi = updated.plans.length - 1; pi >= 0; pi--) {
                    if (updated.plans[pi].status === 'approved' && !updated.plans[pi].planFile) {
                      updated.plans[pi].planFile = planFileName;
                      attached = true;
                      break;
                    }
                  }
                  if (!attached) {
                    (updated as any)._pendingPlanFile = planFileName;
                  }
                }
              }

              if (block.name === 'Task' && block.input) {
                const input = block.input;
                updated.subagents.push({
                  agentId: '',
                  toolUseId: block.id,
                  type: input.subagent_type || input.type || 'general-purpose',
                  prompt: input.prompt || '',
                  description: input.description,
                  model: input.model,
                  turnIndex,
                  lineIndex: msg.lineIndex,
                  userPromptIndex: Math.max(0, updated.userPrompts.length - 1),
                  startedAt: msg.timestamp,
                  status: 'pending',
                  runInBackground: input.run_in_background,
                });
              }

              if (block.name === 'TeamCreate' && block.input) {
                const input = block.input;
                updated.teamOperations.push({
                  operation: 'spawnTeam',
                  teamName: input.team_name,
                  description: input.description,
                  turnIndex,
                  lineIndex: msg.lineIndex,
                });
                if (input.team_name) {
                  if (!updated.allTeams.includes(input.team_name)) {
                    updated.allTeams.push(input.team_name);
                  }
                }
              }

              if (block.name === 'SendMessage' && block.input) {
                const input = block.input;
                updated.teamMessages.push({
                  messageType: (input.type || 'message') as any,
                  recipient: input.recipient,
                  content: input.content,
                  summary: input.summary,
                  requestId: input.request_id,
                  approve: input.approve,
                  turnIndex,
                  lineIndex: msg.lineIndex,
                });
              }
            }

            if (block.type === 'thinking' && block.thinking) {
              updated.thinkingBlocks.push({
                turnIndex,
                lineIndex: msg.lineIndex,
                thinking: block.thinking,
              });
            }
          }
        }

        if (msg.message?.usage) {
          const u = msg.message.usage;
          const inputToks = u.input_tokens || 0;
          const outputToks = u.output_tokens || 0;
          const cacheCreateToks = u.cache_creation_input_tokens || 0;
          const cacheReadToks = u.cache_read_input_tokens || 0;

          updated.usage.inputTokens += inputToks;
          updated.usage.outputTokens += outputToks;
          updated.usage.cacheCreationInputTokens += cacheCreateToks;
          updated.usage.cacheReadInputTokens += cacheReadToks;

          const modelName = msg.message?.model;
          if (modelName && modelName !== '<synthetic>') {
            if (!updated.modelUsage) {
              updated.modelUsage = {};
            }
            if (!updated.modelUsage[modelName]) {
              updated.modelUsage[modelName] = {
                inputTokens: 0,
                outputTokens: 0,
                cacheCreationInputTokens: 0,
                cacheReadInputTokens: 0,
                costUsd: 0,
                messageCount: 0,
              };
            }
            const mu = updated.modelUsage[modelName];
            mu.inputTokens += inputToks;
            mu.outputTokens += outputToks;
            mu.cacheCreationInputTokens += cacheCreateToks;
            mu.cacheReadInputTokens += cacheReadToks;
            mu.messageCount++;
          }
        }

        if (typeof msg.costUSD === 'number' && msg.costUSD > 0) {
          updated.cumulativeCostUsd += msg.costUSD;

          const modelName = msg.message?.model;
          if (modelName && modelName !== '<synthetic>' && updated.modelUsage?.[modelName]) {
            updated.modelUsage[modelName].costUsd += msg.costUSD;
          }
        }
      }

      if (msg.type === 'result') {
        updated.result = msg.result;
        if (msg.subtype === 'error' || msg.error) {
          updated.errors = updated.errors || [];
          updated.errors.push(msg.error || msg.result || 'Unknown error');
        }
        updated.success = msg.subtype === 'success';
        if (msg.duration_ms) updated.durationMs = msg.duration_ms;
        if (msg.duration_api_ms) updated.durationApiMs = msg.duration_api_ms;
        if (msg.total_cost_usd) updated.totalCostUsd = msg.total_cost_usd;
        if (msg.usage) {
          updated.usage = {
            inputTokens: msg.usage.input_tokens || 0,
            outputTokens: msg.usage.output_tokens || 0,
            cacheCreationInputTokens: msg.usage.cache_creation_input_tokens || 0,
            cacheReadInputTokens: msg.usage.cache_read_input_tokens || 0,
          };
        }

        if (msg.modelUsage && typeof msg.modelUsage === 'object') {
          if (!updated.modelUsage) {
            updated.modelUsage = {};
          }
          for (const [modelName, mu] of Object.entries(msg.modelUsage as Record<string, any>)) {
            if (modelName === '<synthetic>' || !mu) continue;
            const existingMessageCount = updated.modelUsage[modelName]?.messageCount || 0;
            updated.modelUsage[modelName] = {
              inputTokens: mu.input_tokens || mu.inputTokens || 0,
              outputTokens: mu.output_tokens || mu.outputTokens || 0,
              cacheCreationInputTokens: mu.cache_creation_input_tokens || mu.cacheCreationInputTokens || 0,
              cacheReadInputTokens: mu.cache_read_input_tokens || mu.cacheReadInputTokens || 0,
              costUsd: mu.costUSD || mu.costUsd || 0,
              messageCount: existingMessageCount,
            };
          }
        }
      }

      if (msg.type === 'progress' && msg.data?.type === 'agent_progress' && msg.data.agentId) {
        const agentId = msg.data.agentId;
        const parentToolUseId = msg.parentToolUseID;
        const parentUuid = msg.parentUuid;
        if (parentToolUseId) {
          const subagent = updated.subagents.find(s => s.toolUseId === parentToolUseId);
          if (subagent && !subagent.agentId) {
            subagent.agentId = agentId;
            subagent.status = 'running';
            if (parentUuid) {
              subagent.parentUuid = parentUuid;
            }
          }
        }
      }
    }

    updated.lastLineIndex = newMessages.length > 0
      ? newMessages[newMessages.length - 1].lineIndex
      : cache.lastLineIndex;
    updated.lastTurnIndex = turnIndex;
    updated.lastTimestamp = lastTimestamp;
    updated.numTurns = turnIndex;

    return updated;
  }

  private async createInitialCache(
    sessionPath: string,
    stats: fs.Stats
  ): Promise<SessionCacheData> {
    const messages: Array<any & { lineIndex: number }> = [];

    const fileStream = fs.createReadStream(sessionPath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    let lineIndex = 0;
    for await (const line of rl) {
      if (line.trim()) {
        try {
          const msg = JSON.parse(line);
          messages.push({ ...msg, lineIndex });
        } catch {
          // Skip invalid JSON
        }
      }
      lineIndex++;
    }

    const cache: SessionCacheData = {
      version: CACHE_VERSION,
      sessionId: '',
      filePath: sessionPath,
      fileSize: stats.size,
      fileMtime: stats.mtime.getTime(),
      lastLineIndex: -1,
      lastTurnIndex: 0,
      lastByteOffset: stats.size,
      createdAt: Date.now(),

      cwd: '',
      model: '',
      claudeCodeVersion: '',
      permissionMode: '',
      tools: [],
      mcpServers: [],

      userPrompts: [],
      toolUses: [],
      responses: [],
      thinkingBlocks: [],

      tasks: [],
      todos: [],
      subagents: [],
      subagentProgress: [],
      plans: [],

      allTeams: [],
      teamOperations: [],
      teamMessages: [],

      numTurns: 0,
      durationMs: 0,
      durationApiMs: 0,
      totalCostUsd: 0,
      cumulativeCostUsd: 0,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      modelUsage: {},

      success: false,
    };

    return this.mergeNewMessages(cache, messages, stats);
  }

  getSessionDataFromMemory(sessionPath: string): SessionCacheData | null {
    return this.store.getSessionData(sessionPath) || null;
  }

  async getSessionData(sessionPath: string): Promise<SessionCacheData | null> {
    if (!fs.existsSync(sessionPath)) {
      return null;
    }

    const stats = fs.statSync(sessionPath);

    let cache = this.store.getSessionData(sessionPath);

    const validity = this.isCacheValid(cache || null, stats);

    if (validity === 'valid' && cache) {
      return cache;
    }

    if (validity === 'append' && cache) {
      const { newMessages, lastLineIndex, lastTurnIndex, lastByteOffset } = await this.parseNewLines(
        sessionPath,
        cache.lastLineIndex,
        cache.lastTurnIndex,
        cache
      );

      if (newMessages.length > 0) {
        cache = this.mergeNewMessages(cache, newMessages, stats);
        cache.lastLineIndex = lastLineIndex;
        cache.lastTurnIndex = lastTurnIndex;
        cache.lastByteOffset = lastByteOffset;

        await this.store.putSessionData(sessionPath, cache);
        this.fireOnChange(cache);
      } else {
        cache.lastByteOffset = lastByteOffset;
        cache.fileSize = stats.size;
        cache.fileMtime = stats.mtime.getTime();
        await this.store.putSessionData(sessionPath, cache);
      }

      return cache;
    }

    cache = await this.createInitialCache(sessionPath, stats);

    await this.store.putSessionData(sessionPath, cache);
    this.fireOnChange(cache);

    return cache;
  }

  async getRawMessages(sessionPath: string): Promise<Array<any & { lineIndex: number }> | null> {
    if (!fs.existsSync(sessionPath)) {
      return null;
    }

    const stats = fs.statSync(sessionPath);

    let cache = this.store.getRawMessages(sessionPath);

    const validity = this.isRawCacheValid(cache || null, stats);

    if (validity === 'valid' && cache) {
      return cache.messages;
    }

    if (validity === 'append' && cache) {
      const { messages: newMessages, lastByteOffset } = await this.parseRawNewLines(
        sessionPath, cache.lastLineIndex, cache.lastByteOffset
      );

      if (newMessages.length > 0) {
        cache.messages.push(...newMessages);
        cache.lastLineIndex = newMessages[newMessages.length - 1].lineIndex;
        cache.lastByteOffset = lastByteOffset;
        cache.fileSize = stats.size;
        cache.fileMtime = stats.mtime.getTime();

        await this.store.putRawMessages(sessionPath, cache);
      } else {
        cache.lastByteOffset = lastByteOffset;
        cache.fileSize = stats.size;
        cache.fileMtime = stats.mtime.getTime();
        await this.store.putRawMessages(sessionPath, cache);
      }

      return cache.messages;
    }

    const messages: Array<any & { lineIndex: number }> = [];

    const fileStream = fs.createReadStream(sessionPath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    let lineIndex = 0;
    for await (const line of rl) {
      if (line.trim()) {
        try {
          const msg = JSON.parse(line);
          messages.push({ ...msg, lineIndex });
        } catch {
          // Skip invalid JSON
        }
      }
      lineIndex++;
    }

    const rawCache: RawMessagesCache = {
      version: CACHE_VERSION,
      sessionId: path.basename(sessionPath, '.jsonl'),
      fileSize: stats.size,
      fileMtime: stats.mtime.getTime(),
      lastLineIndex: lineIndex - 1,
      lastByteOffset: stats.size,
      messages,
    };

    await this.store.putRawMessages(sessionPath, rawCache);

    return messages;
  }

  private isRawCacheValid(cache: RawMessagesCache | null, stats: fs.Stats): 'valid' | 'append' | 'invalid' {
    if (!cache) return 'invalid';
    if (cache.version !== CACHE_VERSION) return 'invalid';

    const fileMtime = stats.mtime.getTime();
    const fileSize = stats.size;

    if (fileSize < cache.fileSize) return 'invalid';
    if (fileMtime < cache.fileMtime) return 'invalid';
    if (fileSize === cache.fileSize && fileMtime === cache.fileMtime) return 'valid';
    if (fileSize > cache.fileSize) return 'append';

    return 'invalid';
  }

  private async parseRawNewLines(
    sessionPath: string,
    startLineIndex: number,
    lastByteOffset?: number
  ): Promise<{ messages: Array<any & { lineIndex: number }>; lastByteOffset: number }> {
    const newMessages: Array<any & { lineIndex: number }> = [];
    let lineIndex: number;
    let byteOffset: number;

    if (lastByteOffset && lastByteOffset > 0) {
      const fileStream = fs.createReadStream(sessionPath, { start: lastByteOffset });
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      lineIndex = startLineIndex + 1;
      byteOffset = lastByteOffset;

      for await (const line of rl) {
        byteOffset += Buffer.byteLength(line, 'utf8') + 1;
        if (line.trim()) {
          try {
            const msg = JSON.parse(line);
            newMessages.push({ ...msg, lineIndex });
          } catch {
            // Skip invalid JSON
          }
        }
        lineIndex++;
      }
    } else {
      const fileStream = fs.createReadStream(sessionPath);
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      lineIndex = 0;
      byteOffset = 0;

      for await (const line of rl) {
        byteOffset += Buffer.byteLength(line, 'utf8') + 1;
        if (lineIndex > startLineIndex && line.trim()) {
          try {
            const msg = JSON.parse(line);
            newMessages.push({ ...msg, lineIndex });
          } catch {
            // Skip invalid JSON
          }
        }
        lineIndex++;
      }
    }

    return { messages: newMessages, lastByteOffset: byteOffset };
  }

  getSessionDataSync(sessionPath: string): SessionCacheData | null {
    if (!fs.existsSync(sessionPath)) {
      return null;
    }

    const stats = fs.statSync(sessionPath);

    let cache = this.store.getSessionData(sessionPath);

    const validity = this.isCacheValid(cache || null, stats);

    if (validity === 'valid' && cache) {
      return cache;
    }

    if (validity === 'append' && cache) {
      const content = fs.readFileSync(sessionPath, 'utf-8');
      const lines = content.split('\n');
      const newMessages: Array<any & { lineIndex: number }> = [];
      let turnIdx = cache.lastTurnIndex;

      for (let li = cache.lastLineIndex + 1; li < lines.length; li++) {
        const line = lines[li];
        if (line.trim()) {
          try {
            const msg = JSON.parse(line);
            newMessages.push({ ...msg, lineIndex: li });
            if (msg.type === 'assistant') {
              turnIdx++;
            }
          } catch {
            // Skip invalid JSON
          }
        }
      }

      if (newMessages.length > 0) {
        cache = this.mergeNewMessages(cache, newMessages, stats);
        cache.lastLineIndex = lines.length - 1;
        cache.lastTurnIndex = turnIdx;

        this.store.putSessionData(sessionPath, cache).catch(() => {});
      }

      return cache;
    }

    const content = fs.readFileSync(sessionPath, 'utf-8');
    const lines = content.split('\n');
    const messages: Array<any & { lineIndex: number }> = [];

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      if (line.trim()) {
        try {
          const msg = JSON.parse(line);
          messages.push({ ...msg, lineIndex: li });
        } catch {
          // Skip invalid JSON
        }
      }
    }

    cache = {
      version: CACHE_VERSION,
      sessionId: '',
      filePath: sessionPath,
      fileSize: stats.size,
      fileMtime: stats.mtime.getTime(),
      lastLineIndex: -1,
      lastTurnIndex: 0,
      createdAt: Date.now(),

      cwd: '',
      model: '',
      claudeCodeVersion: '',
      permissionMode: '',
      tools: [],
      mcpServers: [],

      userPrompts: [],
      toolUses: [],
      responses: [],
      thinkingBlocks: [],

      tasks: [],
      todos: [],
      subagents: [],
      subagentProgress: [],
      plans: [],

      allTeams: [],
      teamOperations: [],
      teamMessages: [],

      numTurns: 0,
      durationMs: 0,
      durationApiMs: 0,
      totalCostUsd: 0,
      cumulativeCostUsd: 0,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      modelUsage: {},

      success: false,
    };

    cache = this.mergeNewMessages(cache, messages, stats);

    this.store.putSessionData(sessionPath, cache).catch(() => {});

    return cache;
  }

  clearCache(sessionPath: string): void {
    this.store.clear(sessionPath).catch(() => {});
  }

  clearAllCaches(): void {
    this.store.clear().catch(() => {});
  }

  async compactCache(): Promise<{ beforeSize: number; afterSize: number }> {
    const wasWatching = this.isWatching;
    const watchedPaths = [...this.watchedPaths];
    if (wasWatching) {
      this.stopWatching();
    }

    const result = await this.store.compact();

    if (wasWatching) {
      this.startWatching(watchedPaths.length > 0 ? watchedPaths : undefined);
    }

    return result;
  }

  getAllSessionsFromCache(): Array<{
    sessionId: string;
    filePath: string;
    cacheData: SessionCacheData;
  }> {
    const results: Array<{ sessionId: string; filePath: string; cacheData: SessionCacheData }> = [];
    for (const { key: filePath, value: cacheData } of this.store.allSessions()) {
      const normalizedFilePath = filePath.replace(/\\/g, '/');
      if (normalizedFilePath.includes('/subagents/')) continue;
      const sessionId = path.basename(filePath, '.jsonl');
      if (sessionId.startsWith('agent-')) continue;
      results.push({ sessionId, filePath, cacheData });
    }
    return results;
  }

  getProjectSessionsFromCache(projectPath: string): Array<{
    sessionId: string;
    filePath: string;
    cacheData: SessionCacheData;
  }> {
    const projectKey = legacyEncodeProjectPath(projectPath);
    const results: Array<{
      sessionId: string;
      filePath: string;
      cacheData: SessionCacheData;
    }> = [];

    for (const { key: filePath, value: cacheData } of this.store.allSessions()) {
      const normalizedFilePath = filePath.replace(/\\/g, '/');
      if (normalizedFilePath.includes(`/projects/${projectKey}/`) && !normalizedFilePath.includes('/subagents/')) {
        const sessionId = path.basename(filePath, '.jsonl');
        if (!sessionId.startsWith('agent-')) {
          results.push({ sessionId, filePath, cacheData });
        }
      }
    }

    return results;
  }

  getPerProjectCosts(): Map<string, number> {
    let calc: CostCalculator | null = null;
    const costMap = new Map<string, number>();

    for (const { key: filePath, value: cacheData } of this.store.allSessions()) {
      const normalized = filePath.replace(/\\/g, '/');

      const projMatch = normalized.match(/\/projects\/([^/]+)\//);
      if (!projMatch) continue;
      const encodedKey = projMatch[1];

      let cost = cacheData.totalCostUsd || cacheData.cumulativeCostUsd || 0;
      if (!cost && cacheData.usage && cacheData.usage.inputTokens > 0) {
        if (!calc) calc = new CostCalculator();
        cost = calc.calculateCost(cacheData.usage, cacheData.model || '').totalCost;
      }

      if (cost > 0) {
        costMap.set(encodedKey, (costMap.get(encodedKey) || 0) + cost);
      }
    }

    return costMap;
  }

  getStats(): { memoryCacheSize: number; diskCacheCount: number; diskCacheSize: number } {
    return {
      memoryCacheSize: this.store.sessionCount + this.store.rawCount,
      diskCacheCount: this.store.sessionCount + this.store.rawCount,
      diskCacheSize: 0,
    };
  }

  close(): void {
    this.stopWatching();
    this.store.close();
  }
}

export function createSessionCache(cacheDir?: string): SessionCache {
  return new SessionCache(cacheDir);
}

export default SessionCache;
