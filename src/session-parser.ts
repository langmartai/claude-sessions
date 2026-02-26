/**
 * Session Parser
 *
 * Core JSONL parsing for Claude Code sessions.
 * Extracted from AgentSessionStore — pure data parsing with no EventEmitter,
 * no server-side dependencies, no SDK session management.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { legacyEncodeProjectPath } from './utils/path-utils';
import { CostCalculator } from './cost-calculator';
import type { SessionCacheData, CachedToolUse, CachedModelUsage, PromptType } from './session-cache';

// ============================================================================
// Types
// ============================================================================

export type SessionStatus = 'running' | 'completed' | 'error' | 'idle' | 'stale' | 'interrupted' | 'unknown';

export type ClaudeSessionMessageType = 'system' | 'user' | 'assistant' | 'result' | 'progress' | 'compact';
export type ClaudeSystemSubtype = 'init' | 'api_conversation_turn_stream' | 'unrecognized';

export interface ClaudeSessionMessage {
  type: ClaudeSessionMessageType;
  subtype?: string;
  timestamp?: string;
  uuid?: string;
  parentUuid?: string;
  lineIndex?: number;
  [key: string]: any;
}

export interface ClaudeSystemInit {
  type: 'system';
  subtype: 'init';
  session_id?: string;
  cwd?: string;
  model?: string;
  claude_code_version?: string;
  permissionMode?: string;
  tools?: string[];
  mcp_servers?: Array<{ name: string; status: string }>;
}

export interface ClaudeAssistantMessage {
  type: 'assistant';
  message: {
    model?: string;
    content?: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: any;
      thinking?: string;
    }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  costUSD?: number;
  timestamp?: string;
}

export interface ClaudeResultMessage {
  type: 'result';
  subtype?: 'success' | 'error';
  result?: string;
  error?: string;
  num_turns?: number;
  total_cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export interface ClaudeToolUse {
  id: string;
  name: string;
  input: any;
  turnIndex?: number;
  lineIndex?: number;
}

export type FileActionCategory = 'read' | 'write' | 'execute' | 'search' | 'navigation' | 'other';

export interface FileChange {
  path: string;
  action: FileActionCategory;
  tool?: string;
}

export interface GitOperation {
  type: GitOperationType;
  command: string;
  args: string[];
}

export type GitOperationType = 'commit' | 'push' | 'pull' | 'checkout' | 'branch' | 'merge' | 'rebase' | 'stash' | 'reset' | 'other';

export type SubagentType = 'general-purpose' | 'Explore' | 'Plan' | string;
export type SubagentStatus = 'pending' | 'running' | 'completed' | 'error';

export interface SubagentInvocation {
  toolUseId: string;
  type: SubagentType;
  prompt: string;
  description?: string;
  model?: string;
  turnIndex: number;
  lineIndex: number;
  userPromptIndex: number;
  status: SubagentStatus;
  startedAt?: string;
  completedAt?: string;
  result?: string;
  agentId?: string;
  runInBackground?: boolean;
}

export interface SubagentSessionData {
  agentId: string;
  filePath: string;
  sessionData?: ClaudeSessionData;
}

export interface ClaudeUserPrompt {
  turnIndex: number;
  lineIndex: number;
  text: string;
  images?: number;
  timestamp?: string;
  /** Classification: undefined/'user' = real prompt, others = system-injected */
  promptType?: PromptType;
}

export interface CompactMessageSummary {
  role: 'user' | 'assistant';
  turnIndex?: number;
  text: string;
  toolUseCount?: number;
  toolNames?: string[];
}

export interface ClaudeCompactMessage {
  type: 'compact';
  summary: string;
  timestamp?: string;
}

export interface ClaudeSessionData {
  sessionId: string;
  filePath: string;
  projectPath?: string;
  fileSize: number;
  lastModified: Date;
  model?: string;
  cwd?: string;
  claudeCodeVersion?: string;
  permissionMode?: string;
  tools?: string[];
  mcpServers?: Array<{ name: string; status: string }>;
  messages: ClaudeSessionMessage[];
  userPrompts: ClaudeUserPrompt[];
  toolUses: ClaudeToolUse[];
  tasks: Array<{
    id: string;
    subject: string;
    description?: string;
    activeForm?: string;
    status: string;
    blocks: string[];
    blockedBy: string[];
    owner?: string;
  }>;
  subagentInvocations: SubagentInvocation[];
  status: SessionStatus;
  numTurns: number;
  totalCostUsd: number;
  durationMs: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  };
  modelUsage?: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    costUsd: number;
    messageCount: number;
  }>;
  isActive?: boolean;
  lastActivityAt?: Date;
  result?: string;
  errors?: string[];
  success: boolean;
  forkedFromSessionId?: string;
}

export type ToolDetailLevel = 'none' | 'summary' | 'full';

export interface ConversationToolCall {
  id: string;
  name: string;
  input: any;
  result?: string;
  isError?: boolean;
}

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system' | 'result';
  content: string;
  timestamp?: string;
  turnIndex?: number;
  lineIndex?: number;
  toolCalls?: ConversationToolCall[];
  thinking?: string;
  model?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface GetConversationOptions {
  sessionId: string;
  cwd?: string;
  toolDetail?: ToolDetailLevel;
  includeThinking?: boolean;
  maxMessages?: number;
}

export interface ConversationResult {
  sessionId: string;
  messages: ConversationMessage[];
  metadata: {
    model?: string;
    totalCost?: number;
    numTurns?: number;
    status?: SessionStatus;
  };
}

// ============================================================================
// Helper functions
// ============================================================================

export function getFileActionCategory(command: string): FileActionCategory {
  const cmd = command.toLowerCase();
  if (/\b(cat|head|tail|less|more|read|view)\b/.test(cmd)) return 'read';
  if (/\b(write|edit|sed|awk|tee|mv|cp|rm|mkdir|touch|chmod)\b/.test(cmd)) return 'write';
  if (/\b(node|python|npm|yarn|pnpm|cargo|go|make|gcc|bash|sh|zsh)\b/.test(cmd)) return 'execute';
  if (/\b(grep|rg|find|fd|ag|ack|locate|which|where)\b/.test(cmd)) return 'search';
  if (/\b(cd|ls|pwd|tree|du|df|stat)\b/.test(cmd)) return 'navigation';
  return 'other';
}

export function summarizeFileChanges(changes: FileChange[]): {
  totalChanges: number;
  byCategory: Record<FileActionCategory, number>;
  affectedFiles: string[];
} {
  const byCategory: Record<FileActionCategory, number> = {
    read: 0,
    write: 0,
    execute: 0,
    search: 0,
    navigation: 0,
    other: 0,
  };

  const affectedFiles = new Set<string>();

  for (const change of changes) {
    byCategory[change.action]++;
    affectedFiles.add(change.path);
  }

  return {
    totalChanges: changes.length,
    byCategory,
    affectedFiles: Array.from(affectedFiles),
  };
}

export function parseCompactMessageSummary(summary: string): CompactMessageSummary {
  const lines = summary.split('\n').filter(l => l.trim());
  const role = summary.includes('assistant') ? 'assistant' : 'user';
  return {
    role,
    text: lines.join('\n'),
  };
}

/**
 * Convert LMDB cache data to the public ClaudeSessionData format.
 */
export function convertCacheToSessionData(
  cache: SessionCacheData,
  sessionId: string,
  filePath: string,
  stats: fs.Stats
): ClaudeSessionData {
  // Convert user prompts — pass ALL through with promptType (matching original behavior)
  const userPrompts: ClaudeUserPrompt[] = cache.userPrompts.map(p => ({
    turnIndex: p.turnIndex,
    lineIndex: p.lineIndex,
    text: p.text,
    images: p.images,
    timestamp: p.timestamp,
    promptType: p.promptType,
  }));

  const toolUses: ClaudeToolUse[] = cache.toolUses.map(t => ({
    id: t.id,
    name: t.name,
    input: t.input,
    turnIndex: t.turnIndex,
    lineIndex: t.lineIndex,
  }));

  const tasks = cache.tasks.map(t => ({
    id: t.id,
    subject: t.subject,
    description: t.description,
    activeForm: t.activeForm,
    status: t.status,
    blocks: t.blocks,
    blockedBy: t.blockedBy,
    owner: t.owner,
  }));

  const subagentInvocations: SubagentInvocation[] = cache.subagents.map(s => ({
    toolUseId: s.toolUseId,
    type: s.type as SubagentType,
    prompt: s.prompt,
    description: s.description,
    model: s.model,
    turnIndex: s.turnIndex,
    lineIndex: s.lineIndex,
    userPromptIndex: s.userPromptIndex,
    status: s.status as SubagentStatus,
    startedAt: s.startedAt,
    completedAt: s.completedAt,
    result: s.result,
    agentId: s.agentId || undefined,
    runInBackground: s.runInBackground,
  }));

  // Determine session status with time-based heuristics (matching original behavior)
  const lastTimestamp = cache.lastTimestamp ? new Date(cache.lastTimestamp) : null;
  const now = Date.now();
  const msSinceModified = now - stats.mtime.getTime();
  const msSinceLastActivity = lastTimestamp ? now - lastTimestamp.getTime() : Infinity;
  const msSinceActivity = Math.min(msSinceModified, msSinceLastActivity);

  const RUNNING_THRESHOLD = 60_000;      // 1 minute
  const IDLE_THRESHOLD = 10 * 60_000;    // 10 minutes

  const hasResultMessage = cache.result !== undefined || cache.durationMs > 0;
  const hasAssistantResponse = cache.responses.length > 0;

  let status: SessionStatus;
  let isActive: boolean;

  if (hasResultMessage && cache.success) {
    status = 'completed';
    isActive = false;
  } else if (hasResultMessage && cache.errors && cache.errors.length > 0) {
    status = 'error';
    isActive = false;
  } else if (msSinceActivity < RUNNING_THRESHOLD) {
    status = 'running';
    isActive = true;
  } else if (hasAssistantResponse && msSinceActivity >= IDLE_THRESHOLD) {
    status = 'completed';
    isActive = false;
  } else if (msSinceActivity < IDLE_THRESHOLD) {
    status = 'idle';
    isActive = false;
  } else {
    status = 'stale';
    isActive = false;
  }

  // Per-model usage breakdown
  const modelUsage = cache.modelUsage && Object.keys(cache.modelUsage).length > 0
    ? Object.fromEntries(Object.entries(cache.modelUsage).map(([k, v]) => [k, { ...v }]))
    : undefined;

  return {
    sessionId: cache.sessionId || sessionId,
    filePath,
    projectPath: cache.cwd,
    fileSize: stats.size,
    lastModified: stats.mtime,
    model: cache.model,
    cwd: cache.cwd,
    claudeCodeVersion: cache.claudeCodeVersion,
    permissionMode: cache.permissionMode,
    tools: cache.tools,
    mcpServers: cache.mcpServers,
    messages: [],
    userPrompts,
    toolUses,
    tasks,
    subagentInvocations,
    status,
    numTurns: cache.numTurns,
    totalCostUsd: cache.totalCostUsd || cache.cumulativeCostUsd || 0,
    durationMs: cache.durationMs,
    usage: cache.usage,
    modelUsage,
    isActive,
    lastActivityAt: lastTimestamp || undefined,
    result: cache.result,
    errors: cache.errors,
    success: cache.success,
    forkedFromSessionId: cache.forkedFromSessionId,
  };
}

// ============================================================================
// SessionParser
// ============================================================================

/**
 * Pure data parser for Claude Code sessions.
 * No EventEmitter, no file watchers, no server dependencies.
 */
export class SessionParser {
  private configDir: string;
  private costCalculator: CostCalculator;

  constructor(options?: { configDir?: string }) {
    this.configDir = options?.configDir || path.join(os.homedir(), '.claude');
    this.costCalculator = new CostCalculator();
  }

  private getProjectDir(cwd: string): string {
    const projectKey = legacyEncodeProjectPath(cwd);
    return path.join(this.configDir, 'projects', projectKey);
  }

  private getSessionFilePath(sessionId: string, cwd?: string): string | null {
    if (cwd) {
      const filePath = path.join(this.getProjectDir(cwd), `${sessionId}.jsonl`);
      if (fs.existsSync(filePath)) return filePath;
    }

    // Search across all projects
    const projectsDir = path.join(this.configDir, 'projects');
    if (!fs.existsSync(projectsDir)) return null;

    const dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const filePath = path.join(projectsDir, dir.name, `${sessionId}.jsonl`);
      if (fs.existsSync(filePath)) return filePath;
    }

    return null;
  }

  /**
   * Parse a session JSONL file into structured data.
   */
  async parseSession(sessionId: string, cwd?: string): Promise<ClaudeSessionData | null> {
    const filePath = this.getSessionFilePath(sessionId, cwd);
    if (!filePath) return null;

    const stats = fs.statSync(filePath);
    const messages: ClaudeSessionMessage[] = [];

    const fileStream = fs.createReadStream(filePath);
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

    // Extract structured data from messages
    const userPrompts: ClaudeUserPrompt[] = [];
    const toolUses: ClaudeToolUse[] = [];
    const tasks: ClaudeSessionData['tasks'] = [];
    const subagentInvocations: SubagentInvocation[] = [];
    let sessionModel: string | undefined;
    let sessionCwd: string | undefined;
    let claudeCodeVersion: string | undefined;
    let permissionMode: string | undefined;
    let tools: string[] | undefined;
    let mcpServers: Array<{ name: string; status: string }> | undefined;
    let status: SessionStatus = 'unknown';
    let numTurns = 0;
    let totalCostUsd = 0;
    let durationMs = 0;
    let result: string | undefined;
    let errors: string[] | undefined;
    let success = false;
    let forkedFromSessionId: string | undefined;
    let usage = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
    let turnIndex = 0;

    for (const msg of messages) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        sessionModel = msg.model;
        sessionCwd = msg.cwd;
        claudeCodeVersion = msg.claude_code_version;
        permissionMode = msg.permissionMode;
        tools = msg.tools;
        mcpServers = msg.mcp_servers;
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

        if (text && !text.trimStart().startsWith('<')) {
          userPrompts.push({
            turnIndex,
            lineIndex: msg.lineIndex || 0,
            text,
            images: images > 0 ? images : undefined,
            timestamp: msg.timestamp,
          });
        }
      }

      if (msg.type === 'assistant') {
        turnIndex++;
        numTurns++;

        if (msg.message?.model) {
          sessionModel = msg.message.model;
        }

        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_use' && block.id && block.name) {
              toolUses.push({
                id: block.id,
                name: block.name,
                input: block.input,
                turnIndex,
                lineIndex: msg.lineIndex || 0,
              });

              if (block.name === 'Task' && block.input) {
                subagentInvocations.push({
                  toolUseId: block.id,
                  type: block.input.subagent_type || block.input.type || 'general-purpose',
                  prompt: block.input.prompt || '',
                  description: block.input.description,
                  model: block.input.model,
                  turnIndex,
                  lineIndex: msg.lineIndex || 0,
                  userPromptIndex: Math.max(0, userPrompts.length - 1),
                  status: 'pending',
                  startedAt: msg.timestamp,
                  runInBackground: block.input.run_in_background,
                });
              }
            }
          }
        }

        if (msg.message?.usage) {
          const u = msg.message.usage;
          usage.inputTokens += u.input_tokens || 0;
          usage.outputTokens += u.output_tokens || 0;
          usage.cacheCreationInputTokens += u.cache_creation_input_tokens || 0;
          usage.cacheReadInputTokens += u.cache_read_input_tokens || 0;
        }
      }

      if (msg.type === 'result') {
        result = msg.result;
        success = msg.subtype === 'success';
        status = success ? 'completed' : 'error';
        if (msg.error) {
          errors = [msg.error];
        }
        if (msg.total_cost_usd) totalCostUsd = msg.total_cost_usd;
        if (msg.duration_ms) durationMs = msg.duration_ms;
        if (msg.usage) {
          usage = {
            inputTokens: msg.usage.input_tokens || 0,
            outputTokens: msg.usage.output_tokens || 0,
            cacheCreationInputTokens: msg.usage.cache_creation_input_tokens || 0,
            cacheReadInputTokens: msg.usage.cache_read_input_tokens || 0,
          };
        }
      }
    }

    // If no result message, estimate cost from usage
    if (!totalCostUsd && usage.inputTokens > 0) {
      totalCostUsd = this.costCalculator.calculateCost(
        usage,
        sessionModel || ''
      ).totalCost;
    }

    // If no result message, try to determine status using time-based heuristics
    if (status === 'unknown') {
      const now = Date.now();
      const msSinceModified = now - stats.mtime.getTime();
      if (msSinceModified < 60_000) {
        status = 'running';
      } else if (msSinceModified < 10 * 60_000) {
        status = 'idle';
      } else {
        status = 'stale';
      }
    }

    return {
      sessionId,
      filePath,
      projectPath: sessionCwd,
      fileSize: stats.size,
      lastModified: stats.mtime,
      model: sessionModel,
      cwd: sessionCwd,
      claudeCodeVersion,
      permissionMode,
      tools,
      mcpServers,
      messages,
      userPrompts,
      toolUses,
      tasks,
      subagentInvocations,
      status,
      numTurns,
      totalCostUsd,
      durationMs,
      usage,
      result,
      errors,
      success,
      forkedFromSessionId,
    };
  }

  /**
   * Get the conversation in a simplified format.
   */
  async getConversation(options: GetConversationOptions): Promise<ConversationResult | null> {
    const sessionData = await this.parseSession(options.sessionId, options.cwd);
    if (!sessionData) return null;

    const messages: ConversationMessage[] = [];
    const toolDetail = options.toolDetail || 'summary';
    const includeThinking = options.includeThinking ?? false;

    for (const msg of sessionData.messages) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        messages.push({
          role: 'system',
          content: `Session started (model: ${msg.model || 'unknown'})`,
          timestamp: msg.timestamp,
          lineIndex: msg.lineIndex,
        });
      }

      if (msg.type === 'user') {
        const content = msg.message?.content;
        let text = '';

        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') text += block.text;
          }
        } else if (typeof content === 'string') {
          text = content;
        }

        if (text) {
          messages.push({
            role: 'user',
            content: text,
            timestamp: msg.timestamp,
            lineIndex: msg.lineIndex,
          });
        }
      }

      if (msg.type === 'assistant') {
        const content = msg.message?.content;
        let text = '';
        let thinking = '';
        const toolCalls: ConversationToolCall[] = [];

        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') text += block.text;
            if (block.type === 'thinking' && includeThinking) {
              thinking += block.thinking;
            }
            if (block.type === 'tool_use' && toolDetail !== 'none') {
              toolCalls.push({
                id: block.id || '',
                name: block.name || '',
                input: toolDetail === 'full' ? block.input : undefined,
              });
            }
          }
        }

        const convMsg: ConversationMessage = {
          role: 'assistant',
          content: text,
          timestamp: msg.timestamp,
          lineIndex: msg.lineIndex,
          model: msg.message?.model,
        };

        if (toolCalls.length > 0) convMsg.toolCalls = toolCalls;
        if (thinking) convMsg.thinking = thinking;
        if (msg.message?.usage) {
          convMsg.usage = {
            inputTokens: msg.message.usage.input_tokens || 0,
            outputTokens: msg.message.usage.output_tokens || 0,
          };
        }

        messages.push(convMsg);
      }

      if (msg.type === 'result') {
        messages.push({
          role: 'result',
          content: msg.result || (msg.error ? `Error: ${msg.error}` : 'Session ended'),
          timestamp: msg.timestamp,
          lineIndex: msg.lineIndex,
        });
      }
    }

    const finalMessages = options.maxMessages
      ? messages.slice(-options.maxMessages)
      : messages;

    return {
      sessionId: options.sessionId,
      messages: finalMessages,
      metadata: {
        model: sessionData.model,
        totalCost: sessionData.totalCostUsd,
        numTurns: sessionData.numTurns,
        status: sessionData.status,
      },
    };
  }
}

export function createSessionParser(options?: { configDir?: string }): SessionParser {
  return new SessionParser(options);
}
