/**
 * claude-sessions — Read Claude Code session data
 *
 * Standalone package for reading Claude Code sessions, projects,
 * tasks, teams, and cost data from ~/.claude/projects/.
 *
 * @packageDocumentation
 */

// Core reading
export { SessionReader, createSessionReader } from './session-reader';
export type {
  SessionSummary,
  SessionInfo,
  ProjectInfo,
  SubagentFileInfo,
  SessionReaderConfig,
} from './session-reader';

// Session parsing
export { SessionParser, createSessionParser } from './session-parser';
export {
  getFileActionCategory,
  summarizeFileChanges,
  parseCompactMessageSummary,
  convertCacheToSessionData,
} from './session-parser';
export type {
  SessionStatus,
  ClaudeSessionMessageType,
  ClaudeSystemSubtype,
  ClaudeSessionMessage,
  ClaudeSystemInit,
  ClaudeAssistantMessage,
  ClaudeResultMessage,
  ClaudeToolUse,
  FileActionCategory,
  FileChange,
  GitOperation,
  GitOperationType,
  SubagentType,
  SubagentStatus,
  SubagentInvocation,
  SubagentSessionData,
  ClaudeUserPrompt,
  CompactMessageSummary,
  ClaudeCompactMessage,
  ClaudeSessionData,
  ToolDetailLevel,
  ConversationToolCall,
  ConversationMessage,
  GetConversationOptions,
  ConversationResult,
} from './session-parser';

// LMDB-backed session cache
export { SessionCache, createSessionCache } from './session-cache';
export {
  classifyUserPrompt,
  isRealUserPrompt,
} from './session-cache';
export type {
  PromptType,
  CachedUserPrompt,
  CachedToolUse,
  CachedResponse,
  CachedThinkingBlock,
  CachedTask,
  CachedTodo,
  CachedPlan,
  CachedSubagent,
  CachedUsage,
  CachedModelUsage,
  SessionCacheData,
  RawMessagesCache,
} from './session-cache';

// LMDB store adapter
export { SessionCacheStore } from './session-cache-store';

// Services
export { ProjectsService, createProjectsService } from './projects-service';
export type {
  GitRemote,
  GitInfo,
  Project,
  ProjectSession,
  ListProjectsOptions,
  ListSessionsOptions,
} from './projects-service';

export { TasksService, createTasksService } from './tasks-service';
export type {
  Task,
  TaskList,
  TaskListSummary,
  CreateTaskInput,
  UpdateTaskInput,
} from './tasks-service';
export type { SessionInfo as TaskSessionInfo } from './tasks-service';

export { AgentTeamsService, createAgentTeamsService } from './teams-service';
export type {
  TeamMember,
  TeamConfig,
  TeamResult,
} from './teams-service';

// Cost calculator
export { CostCalculator, createCostCalculator, DEFAULT_MODEL_PRICING } from './cost-calculator';

// Utilities
export {
  legacyEncodeProjectPath,
  encodePath,
  decodePath,
  getDataDir,
  getClaudeConfigDir,
  getProjectsDir,
  getSessionFilePath,
  getProjectStorageDir,
  transformPaths,
  normalizePath,
  isAbsolutePath,
  getRelativePath,
  extractProjectPath,
} from './utils/path-utils';

// Types
export type {
  TokenUsage,
  ModelPricing,
  CostEstimate,
  UsageSummary,
  ContentBlock,
} from './types';
