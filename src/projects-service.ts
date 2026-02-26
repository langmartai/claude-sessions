/**
 * Projects Service
 *
 * Comprehensive API for session projects from ~/.claude/projects/
 * Provides:
 * - List all projects
 * - Get project sessions
 * - Get project git info
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';
import {
  getProjectsDir,
  decodePath,
  legacyEncodeProjectPath,
} from './utils/path-utils';
import { CostCalculator } from './cost-calculator';
import type { SessionCache, SessionCacheData } from './session-cache';
import { isRealUserPrompt } from './session-cache';

// ============================================================================
// Types
// ============================================================================

export interface GitRemote {
  name: string;
  url: string;
  type: 'fetch' | 'push';
}

export interface GitInfo {
  initialized: boolean;
  branch: string | null;
  isBare: boolean;
  isWorktree: boolean;
  mainWorktreePath: string | null;
  worktrees: Array<{
    path: string;
    branch: string | null;
    head: string;
    isCurrent: boolean;
  }>;
  remotes: GitRemote[];
  headCommit: string | null;
}

export interface Project {
  path: string;
  encodedPath: string;
  sessionCount: number;
  lastActivity?: Date;
  storageSize: number;
  hasClaudeMd: boolean;
  isGitProject: boolean;
  git: GitInfo | null;
}

export interface ProjectSession {
  sessionId: string;
  projectPath: string;
  projectKey: string;
  filePath: string;
  fileSize: number;
  lastModified: Date;
  isActive: boolean;
  userPromptCount?: number;
  taskCount?: number;
  agentCount?: number;
  lastUserMessage?: string;
  model?: string;
  totalCostUsd?: number;
  usage?: {
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
  numTurns?: number;
  forkedFromSessionId?: string;
}

export interface ListProjectsOptions {
  encoded?: boolean;
  includeSize?: boolean;
  force?: boolean;
}

export interface ListSessionsOptions {
  limit?: number;
  offset?: number;
  sortBy?: 'lastModified' | 'size' | 'cost';
  sortOrder?: 'asc' | 'desc';
  activeOnly?: boolean;
}

// ============================================================================
// Service Implementation
// ============================================================================

export class ProjectsService {
  private costCalculator: CostCalculator;
  private sessionCache: SessionCache | null;

  constructor(options?: { sessionCache?: SessionCache }) {
    this.costCalculator = new CostCalculator();
    this.sessionCache = options?.sessionCache || null;
  }

  /**
   * List all projects with session counts and metadata.
   */
  listProjects(options?: ListProjectsOptions): Project[] {
    const projectsDir = getProjectsDir();
    if (!fs.existsSync(projectsDir)) return [];

    const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
    const projects: Project[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const projectDir = path.join(projectsDir, entry.name);
      const files = fs.readdirSync(projectDir)
        .filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'));

      if (files.length === 0) continue;

      const decodedPath = decodePath(entry.name);

      let lastActivity: Date | undefined;
      let totalSize = 0;

      for (const file of files) {
        try {
          const stats = fs.statSync(path.join(projectDir, file));
          if (!lastActivity || stats.mtime > lastActivity) {
            lastActivity = stats.mtime;
          }
          totalSize += stats.size;
        } catch {
          // Skip files we can't stat
        }
      }

      const hasClaudeMd = fs.existsSync(path.join(decodedPath, 'CLAUDE.md'));
      const isGitProject = fs.existsSync(path.join(decodedPath, '.git'));

      let git: GitInfo | null = null;
      if (isGitProject) {
        git = this.getGitInfo(decodedPath);
      }

      projects.push({
        path: decodedPath,
        encodedPath: entry.name,
        sessionCount: files.length,
        lastActivity,
        storageSize: totalSize,
        hasClaudeMd,
        isGitProject,
        git,
      });
    }

    projects.sort((a, b) => {
      const aTime = a.lastActivity?.getTime() || 0;
      const bTime = b.lastActivity?.getTime() || 0;
      return bTime - aTime;
    });

    return projects;
  }

  /**
   * List sessions for a project with detailed metadata.
   */
  listProjectSessions(projectPath: string, options?: ListSessionsOptions): ProjectSession[] {
    const projectKey = legacyEncodeProjectPath(projectPath);
    const projectDir = path.join(getProjectsDir(), projectKey);

    if (!fs.existsSync(projectDir)) return [];

    const files = fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'));

    const ACTIVE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
    const now = Date.now();

    const sessions: ProjectSession[] = [];

    for (const file of files) {
      const sessionId = file.replace('.jsonl', '');
      const filePath = path.join(projectDir, file);

      let stats: fs.Stats;
      try {
        stats = fs.statSync(filePath);
      } catch {
        continue;
      }

      const isActive = now - stats.mtime.getTime() < ACTIVE_THRESHOLD_MS;

      if (options?.activeOnly && !isActive) continue;

      const session: ProjectSession = {
        sessionId,
        projectPath,
        projectKey,
        filePath,
        fileSize: stats.size,
        lastModified: stats.mtime,
        isActive,
      };

      // Enrich from cache if available
      if (this.sessionCache) {
        const cacheData = this.sessionCache.getSessionDataFromMemory(filePath)
          || this.sessionCache.getSessionDataSync(filePath);

        if (cacheData) {
          const realPrompts = cacheData.userPrompts.filter(isRealUserPrompt);
          session.userPromptCount = realPrompts.length;
          session.taskCount = cacheData.tasks.length;
          session.agentCount = cacheData.subagents.length;
          session.model = cacheData.model;
          session.numTurns = cacheData.numTurns;
          session.forkedFromSessionId = cacheData.forkedFromSessionId;
          session.usage = cacheData.usage;
          session.modelUsage = cacheData.modelUsage;

          // Calculate cost
          session.totalCostUsd = cacheData.totalCostUsd || cacheData.cumulativeCostUsd || 0;
          if (!session.totalCostUsd && cacheData.usage.inputTokens > 0) {
            session.totalCostUsd = this.costCalculator.calculateCost(
              cacheData.usage, cacheData.model || ''
            ).totalCost;
          }

          // Last user message
          const lastPrompt = realPrompts[realPrompts.length - 1];
          if (lastPrompt?.text) {
            const words = lastPrompt.text.split(/\s+/);
            session.lastUserMessage = words.length > 100
              ? words.slice(0, 100).join(' ') + '...'
              : lastPrompt.text;
          }
        }
      }

      sessions.push(session);
    }

    // Sort
    const sortBy = options?.sortBy || 'lastModified';
    const sortOrder = options?.sortOrder || 'desc';
    const multiplier = sortOrder === 'desc' ? -1 : 1;

    sessions.sort((a, b) => {
      switch (sortBy) {
        case 'size':
          return multiplier * (a.fileSize - b.fileSize);
        case 'cost':
          return multiplier * ((a.totalCostUsd || 0) - (b.totalCostUsd || 0));
        default:
          return multiplier * (a.lastModified.getTime() - b.lastModified.getTime());
      }
    });

    // Apply pagination
    const offset = options?.offset || 0;
    const limit = options?.limit || sessions.length;
    return sessions.slice(offset, offset + limit);
  }

  /**
   * Get git info for a project directory.
   */
  getGitInfo(projectPath: string): GitInfo | null {
    if (!fs.existsSync(projectPath)) return null;

    try {
      const opts = { cwd: projectPath, timeout: 5000 };

      const isGit = (() => {
        try {
          execFileSync('git', ['rev-parse', '--is-inside-work-tree'], opts);
          return true;
        } catch {
          return false;
        }
      })();

      if (!isGit) return null;

      const branch = (() => {
        try {
          return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], opts).toString().trim() || null;
        } catch {
          return null;
        }
      })();

      const headCommit = (() => {
        try {
          return execFileSync('git', ['rev-parse', '--short', 'HEAD'], opts).toString().trim() || null;
        } catch {
          return null;
        }
      })();

      const isBare = (() => {
        try {
          return execFileSync('git', ['rev-parse', '--is-bare-repository'], opts).toString().trim() === 'true';
        } catch {
          return false;
        }
      })();

      const remotes: GitRemote[] = [];
      try {
        const remotesOutput = execFileSync('git', ['remote', '-v'], opts).toString().trim();
        for (const line of remotesOutput.split('\n')) {
          const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)/);
          if (match) {
            remotes.push({
              name: match[1],
              url: match[2],
              type: match[3] as 'fetch' | 'push',
            });
          }
        }
      } catch {
        // Ignore
      }

      return {
        initialized: true,
        branch,
        isBare,
        isWorktree: false,
        mainWorktreePath: null,
        worktrees: [],
        remotes,
        headCommit,
      };
    } catch {
      return null;
    }
  }
}

export function createProjectsService(options?: { sessionCache?: SessionCache }): ProjectsService {
  return new ProjectsService(options);
}
