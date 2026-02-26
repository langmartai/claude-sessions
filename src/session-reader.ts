/**
 * Session Reader
 *
 * Read-only access to session files in ~/.claude/projects/.
 * Provides low-level JSONL file discovery and reading.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { decodePath } from './utils/path-utils';

// ============================================================================
// Types
// ============================================================================

/**
 * Summary info about a session (for listing)
 */
export interface SessionSummary {
  sessionId: string;
  projectPath: string;
  projectKey: string;
  lastModified: Date;
  sizeBytes: number;
}

/**
 * Detailed info about a session
 */
export interface SessionInfo extends SessionSummary {
  model?: string;
  numTurns?: number;
  totalCostUsd?: number;
  status?: 'active' | 'completed' | 'error';
  result?: string;
  durationMs?: number;
}

/**
 * Project info (from raw session files)
 */
export interface ProjectInfo {
  key: string;
  path: string;
  sessionCount: number;
  lastActivity: Date;
}

/**
 * Subagent file metadata
 */
export interface SubagentFileInfo {
  agentId: string;
  sessionId: string;
  filePath: string;
  lastModified: Date;
  sizeBytes: number;
}

/**
 * Configuration for SessionReader
 */
export interface SessionReaderConfig {
  /** Override config directory (default: ~/.claude) */
  configDir?: string;
  /** Default working directory for project resolution */
  defaultCwd?: string;
}

// ============================================================================
// SessionReader Implementation
// ============================================================================

/**
 * Read-only access to session files.
 *
 * Sessions are stored in ~/.claude/projects/{projectKey}/ as JSONL files.
 * This class provides methods to:
 * - List sessions and projects
 * - Read session data (messages, tool uses, etc.)
 * - Access conversation history
 * - Read subagent session files
 */
export class SessionReader {
  private configDir: string;
  private defaultCwd?: string;

  constructor(config?: SessionReaderConfig) {
    this.configDir = config?.configDir || path.join(os.homedir(), '.claude');
    this.defaultCwd = config?.defaultCwd;
  }

  getProjectsDir(): string {
    return path.join(this.configDir, 'projects');
  }

  cwdToProjectKey(cwd: string): string {
    return cwd.replace(/[:\\/]/g, '-');
  }

  getProjectDir(cwd?: string): string {
    const workingDir = cwd || this.defaultCwd || process.cwd();
    const projectKey = this.cwdToProjectKey(workingDir);
    return path.join(this.getProjectsDir(), projectKey);
  }

  getSessionFilePath(sessionId: string, cwd?: string): string {
    return path.join(this.getProjectDir(cwd), `${sessionId}.jsonl`);
  }

  listSessions(cwd?: string): SessionSummary[] {
    const projectDir = this.getProjectDir(cwd);
    if (!fs.existsSync(projectDir)) {
      return [];
    }

    const sessions: SessionSummary[] = [];
    const files = fs.readdirSync(projectDir);

    for (const file of files) {
      if (!file.endsWith('.jsonl') || file.startsWith('agent-')) {
        continue;
      }

      const sessionId = file.replace('.jsonl', '');
      const filePath = path.join(projectDir, file);
      const stats = fs.statSync(filePath);

      sessions.push({
        sessionId,
        projectPath: cwd || this.defaultCwd || process.cwd(),
        projectKey: this.cwdToProjectKey(cwd || this.defaultCwd || process.cwd()),
        lastModified: stats.mtime,
        sizeBytes: stats.size,
      });
    }

    sessions.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

    return sessions;
  }

  listSessionsWithDetails(cwd?: string): SessionInfo[] {
    const summaries = this.listSessions(cwd);
    const detailed: SessionInfo[] = [];

    for (const summary of summaries) {
      const info: SessionInfo = { ...summary };

      try {
        const filePath = this.getSessionFilePath(summary.sessionId, cwd);
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.trim().split('\n');

        if (lines.length > 0) {
          try {
            const firstLine = JSON.parse(lines[0]);
            if (firstLine.type === 'system' && firstLine.subtype === 'init') {
              info.model = firstLine.model;
            }
          } catch {
            // Ignore parse errors
          }

          try {
            const lastLine = JSON.parse(lines[lines.length - 1]);
            if (lastLine.type === 'result') {
              info.numTurns = lastLine.num_turns;
              info.totalCostUsd = lastLine.total_cost_usd;
              info.durationMs = lastLine.duration_ms;
              info.status = lastLine.is_error ? 'error' : 'completed';
              info.result = lastLine.result;
            } else {
              info.status = 'active';
            }
          } catch {
            // Ignore parse errors
          }
        }
      } catch {
        // Ignore read errors
      }

      detailed.push(info);
    }

    return detailed;
  }

  listProjects(): ProjectInfo[] {
    const projectsDir = this.getProjectsDir();
    if (!fs.existsSync(projectsDir)) {
      return [];
    }

    const projects: ProjectInfo[] = [];
    const entries = fs.readdirSync(projectsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const projectDir = path.join(projectsDir, entry.name);
      const files = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'));

      if (files.length === 0) continue;

      let lastActivity = new Date(0);
      for (const file of files) {
        const stats = fs.statSync(path.join(projectDir, file));
        if (stats.mtime > lastActivity) {
          lastActivity = stats.mtime;
        }
      }

      projects.push({
        key: entry.name,
        path: decodePath(entry.name),
        sessionCount: files.length,
        lastActivity,
      });
    }

    projects.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());

    return projects;
  }

  sessionExists(sessionId: string, cwd?: string): boolean {
    const filePath = this.getSessionFilePath(sessionId, cwd);
    return fs.existsSync(filePath);
  }

  listSubagentFiles(sessionId?: string, cwd?: string): SubagentFileInfo[] {
    const projectDir = this.getProjectDir(cwd);
    if (!fs.existsSync(projectDir)) {
      return [];
    }

    const files: SubagentFileInfo[] = [];
    const addAgentFile = (filePath: string, parentSessionId: string) => {
      const fileName = path.basename(filePath);
      const match = fileName.match(/^agent-(.+)\.jsonl$/);
      if (!match) return;

      const agentId = match[1];
      try {
        const stats = fs.statSync(filePath);
        files.push({
          agentId,
          sessionId: parentSessionId,
          filePath,
          lastModified: stats.mtime,
          sizeBytes: stats.size,
        });
      } catch {
        // Ignore files we can't stat
      }
    };

    const entries = fs.readdirSync(projectDir);
    for (const file of entries) {
      if (file.startsWith('agent-') && file.endsWith('.jsonl')) {
        addAgentFile(path.join(projectDir, file), sessionId || 'unknown');
      }
    }

    for (const entry of entries) {
      const entryPath = path.join(projectDir, entry);
      const subagentsDir = path.join(entryPath, 'subagents');

      if (sessionId && entry !== sessionId) continue;

      if (fs.existsSync(subagentsDir) && fs.statSync(subagentsDir).isDirectory()) {
        const subagentFiles = fs.readdirSync(subagentsDir);
        for (const file of subagentFiles) {
          if (file.startsWith('agent-') && file.endsWith('.jsonl')) {
            addAgentFile(path.join(subagentsDir, file), entry);
          }
        }
      }
    }

    files.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

    return files;
  }

  async readSessionLines(sessionId: string, cwd?: string): Promise<string[]> {
    const filePath = this.getSessionFilePath(sessionId, cwd);
    if (!fs.existsSync(filePath)) {
      return [];
    }

    const lines: string[] = [];
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (line.trim()) {
        lines.push(line);
      }
    }

    return lines;
  }

  async readSessionLinesFrom(
    sessionId: string,
    fromLineIndex: number,
    cwd?: string,
    limit?: number
  ): Promise<{ lines: string[]; totalLines: number }> {
    const allLines = await this.readSessionLines(sessionId, cwd);
    const totalLines = allLines.length;

    let lines = allLines.slice(fromLineIndex);
    if (limit && limit > 0) {
      lines = lines.slice(0, limit);
    }

    return { lines, totalLines };
  }

  parseJsonlLine<T = unknown>(line: string): T | null {
    try {
      return JSON.parse(line) as T;
    } catch {
      return null;
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createSessionReader(config?: SessionReaderConfig): SessionReader {
  return new SessionReader(config);
}
