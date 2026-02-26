/**
 * Claude Code Tasks Service
 *
 * Reads Claude Code task files from ~/.claude/tasks/
 * Each task list is a directory containing individual task JSON files.
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { legacyEncodeProjectPath } from './utils/path-utils';

// ============================================================================
// Types
// ============================================================================

export interface Task {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'deleted';
  blocks: string[];
  blockedBy: string[];
  owner?: string;
  metadata?: Record<string, unknown>;
}

export interface SessionInfo {
  sessionId: string;
  projectPath: string;
  projectKey: string;
  filePath: string;
  exists: boolean;
}

export interface TaskList {
  listId: string;
  tasks: Task[];
  taskCount: number;
  path: string;
  sessionInfo?: SessionInfo;
}

export interface TaskListSummary {
  listId: string;
  taskCount: number;
  pendingCount: number;
  inProgressCount: number;
  completedCount: number;
  lastModified: Date;
  sessionInfo?: SessionInfo;
}

export interface CreateTaskInput {
  subject: string;
  description?: string;
  activeForm?: string;
  status?: 'pending' | 'in_progress' | 'completed';
  blocks?: string[];
  blockedBy?: string[];
  owner?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateTaskInput {
  subject?: string;
  description?: string;
  activeForm?: string;
  status?: 'pending' | 'in_progress' | 'completed';
  blocks?: string[];
  blockedBy?: string[];
  addBlocks?: string[];
  addBlockedBy?: string[];
  owner?: string;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Service Implementation
// ============================================================================

export class TasksService {
  private tasksDir: string;

  // Cache: sessionId → SessionInfo (avoids scanning 30 project dirs per lookup)
  private _sessionInfoCache = new Map<string, SessionInfo | null>();

  // Cache: listTaskLists() result, invalidated on file changes
  private _taskListCache: TaskListSummary[] | null = null;
  private _taskListCacheDirty = true;

  constructor(tasksDir?: string) {
    this.tasksDir = tasksDir || path.join(homedir(), '.claude', 'tasks');
  }

  invalidateCache(): void {
    this._taskListCache = null;
    this._taskListCacheDirty = true;
  }

  invalidateSessionInfoCache(): void {
    this._sessionInfoCache.clear();
  }

  getTasksDir(): string {
    return this.tasksDir;
  }

  isSessionIdFormat(id: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(id);
  }

  findSessionById(sessionId: string): SessionInfo | null {
    if (!this.isSessionIdFormat(sessionId)) {
      return null;
    }

    if (this._sessionInfoCache.has(sessionId)) {
      return this._sessionInfoCache.get(sessionId) || null;
    }

    const projectsDir = path.join(homedir(), '.claude', 'projects');
    if (!fs.existsSync(projectsDir)) {
      this._sessionInfoCache.set(sessionId, null);
      return null;
    }

    try {
      const dirs = fs.readdirSync(projectsDir, { withFileTypes: true })
        .filter(d => d.isDirectory());

      for (const dir of dirs) {
        const sessionFile = path.join(projectsDir, dir.name, `${sessionId}.jsonl`);
        if (fs.existsSync(sessionFile)) {
          const projectPath = '/' + dir.name.replace(/^-/, '').replace(/-/g, '/');

          const info: SessionInfo = {
            sessionId,
            projectPath,
            projectKey: dir.name,
            filePath: sessionFile,
            exists: true,
          };
          this._sessionInfoCache.set(sessionId, info);
          return info;
        }
      }
    } catch {
      // Ignore errors
    }

    this._sessionInfoCache.set(sessionId, null);
    return null;
  }

  getSessionInfo(listId: string): SessionInfo | null {
    return this.findSessionById(listId);
  }

  async listTaskLists(): Promise<TaskListSummary[]> {
    if (!this._taskListCacheDirty && this._taskListCache) {
      return this._taskListCache;
    }

    if (!fs.existsSync(this.tasksDir)) {
      return [];
    }

    const entries = fs.readdirSync(this.tasksDir, { withFileTypes: true });
    const summaries: TaskListSummary[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const listPath = path.join(this.tasksDir, entry.name);
        const tasks = await this.readTasksFromDir(listPath);
        const stat = fs.statSync(listPath);

        const sessionInfo = this.getSessionInfo(entry.name);

        summaries.push({
          listId: entry.name,
          taskCount: tasks.length,
          pendingCount: tasks.filter(t => t.status === 'pending').length,
          inProgressCount: tasks.filter(t => t.status === 'in_progress').length,
          completedCount: tasks.filter(t => t.status === 'completed').length,
          lastModified: stat.mtime,
          sessionInfo: sessionInfo || undefined,
        });
      }
    }

    const result = summaries.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

    this._taskListCache = result;
    this._taskListCacheDirty = false;

    return result;
  }

  encodeProjectPath(projectPath: string): string {
    const normalized = projectPath.replace(/[\\/]+$/, '');
    return legacyEncodeProjectPath(normalized);
  }

  async getTaskListsForProject(projectPath: string): Promise<TaskListSummary[]> {
    const allLists = await this.listTaskLists();
    const targetProjectKey = this.encodeProjectPath(projectPath);

    return allLists.filter(list => {
      if (!list.sessionInfo) return false;
      return list.sessionInfo.projectKey === targetProjectKey;
    });
  }

  async getTaskList(listId: string): Promise<TaskList | null> {
    const listPath = path.join(this.tasksDir, listId);

    if (!fs.existsSync(listPath)) {
      return null;
    }

    const tasks = await this.readTasksFromDir(listPath);
    const sessionInfo = this.getSessionInfo(listId);

    return {
      listId,
      tasks,
      taskCount: tasks.length,
      path: listPath,
      sessionInfo: sessionInfo || undefined,
    };
  }

  async getTask(listId: string, taskId: string): Promise<Task | null> {
    const taskPath = path.join(this.tasksDir, listId, `${taskId}.json`);
    if (fs.existsSync(taskPath)) {
      try {
        const content = fs.readFileSync(taskPath, 'utf-8');
        return JSON.parse(content) as Task;
      } catch {
        // Fall through
      }
    }

    const taskList = await this.getTaskList(listId);
    return taskList?.tasks.find(t => t.id === taskId) || null;
  }

  async getReadyTasks(listId: string): Promise<Task[]> {
    const taskList = await this.getTaskList(listId);
    if (!taskList) return [];

    const completedIds = new Set(
      taskList.tasks
        .filter(t => t.status === 'completed')
        .map(t => t.id)
    );

    return taskList.tasks.filter(task => {
      if (task.status === 'completed') return false;
      return task.blockedBy.every(id => completedIds.has(id));
    });
  }

  async getAllTasksFlat(): Promise<Array<Task & { sessionId: string; projectPath?: string; projectName?: string }>> {
    if (!fs.existsSync(this.tasksDir)) {
      return [];
    }

    const entries = fs.readdirSync(this.tasksDir, { withFileTypes: true });
    const allTasks: Array<Task & { sessionId: string; projectPath?: string; projectName?: string }> = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const listId = entry.name;
      const listPath = path.join(this.tasksDir, listId);
      const rawTasks = await this.readTasksFromDir(listPath);
      const tasks = rawTasks.filter(t => (t.status as string) !== 'deleted');

      if (tasks.length === 0) continue;

      const sessionInfo = this.getSessionInfo(listId);
      const projectPath = sessionInfo?.projectPath;
      const projectName = projectPath ? path.basename(projectPath) : undefined;

      for (const task of tasks) {
        allTasks.push({
          ...task,
          sessionId: listId,
          projectPath,
          projectName,
        });
      }
    }

    return allTasks;
  }

  async getDependencyGraph(listId: string): Promise<{
    nodes: Array<{ id: string; subject: string; status: string }>;
    edges: Array<{ from: string; to: string }>;
  }> {
    const taskList = await this.getTaskList(listId);
    if (!taskList) {
      return { nodes: [], edges: [] };
    }

    const nodes = taskList.tasks.map(t => ({
      id: t.id,
      subject: t.subject,
      status: t.status,
    }));

    const edges: Array<{ from: string; to: string }> = [];
    const edgeSet = new Set<string>();
    for (const task of taskList.tasks) {
      for (const blockedId of task.blocks) {
        const key = `${task.id}->${blockedId}`;
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          edges.push({ from: task.id, to: blockedId });
        }
      }
      for (const blockerId of task.blockedBy) {
        const key = `${blockerId}->${task.id}`;
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          edges.push({ from: blockerId, to: task.id });
        }
      }
    }

    return { nodes, edges };
  }

  private async readTasksFromDir(dirPath: string): Promise<Task[]> {
    if (!fs.existsSync(dirPath)) {
      return [];
    }

    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
    const tasks: Task[] = [];

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(dirPath, file), 'utf-8');
        const task = JSON.parse(content) as Task;
        tasks.push(task);
      } catch {
        // Skip invalid files
      }
    }

    return tasks.sort((a, b) => {
      const aNum = parseInt(a.id, 10);
      const bNum = parseInt(b.id, 10);
      if (isNaN(aNum) || isNaN(bNum)) {
        return a.id.localeCompare(b.id);
      }
      return aNum - bNum;
    });
  }
}

export function createTasksService(tasksDir?: string): TasksService {
  return new TasksService(tasksDir);
}
