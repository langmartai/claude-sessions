# claude-sessions

Read Claude Code session data (sessions, projects, tasks, teams, costs) without running lm-assist.

## Install

```bash
npm install claude-sessions
```

## Quick Start

```typescript
import {
  createSessionReader,
  createSessionParser,
  createSessionCache,
  createProjectsService,
  createTasksService,
  createAgentTeamsService,
  createCostCalculator,
} from 'claude-sessions';

// List all projects and sessions
const reader = createSessionReader();
const projects = reader.listProjects();
const sessions = reader.listSessions('/path/to/project');

// Parse a session with full detail
const parser = createSessionParser();
const session = await parser.parseSession('session-uuid', '/path/to/project');
console.log(session.userPrompts);
console.log(session.toolUses);
console.log(session.totalCostUsd);

// Get conversation in simplified format
const convo = await parser.getConversation({
  sessionId: 'session-uuid',
  toolDetail: 'summary',
  includeThinking: true,
});

// LMDB-backed cache for fast repeated reads
const cache = createSessionCache();
const data = await cache.getSessionData('/path/to/session.jsonl');
const allSessions = cache.getAllSessionsFromCache();
cache.close();

// Projects with git info and cost
const projService = createProjectsService({ sessionCache: cache });
const projs = projService.listProjects();

// Tasks
const tasks = createTasksService();
const lists = await tasks.listTaskLists();
const taskList = await tasks.getTaskList('list-id');

// Teams
const teams = createAgentTeamsService();
const teamList = teams.listTeams();

// Cost calculation
const calc = createCostCalculator();
const cost = calc.calculateCost(
  { inputTokens: 100000, outputTokens: 5000, cacheCreationInputTokens: 50000, cacheReadInputTokens: 200000 },
  'claude-sonnet-4'
);
console.log(calc.formatCost(cost.totalCost));
```

## API Overview

### SessionReader
Low-level JSONL file discovery and reading from `~/.claude/projects/`.

- `listProjects()` — List all projects
- `listSessions(cwd?)` — List sessions for a project
- `listSessionsWithDetails(cwd?)` — Sessions with model/cost/status
- `readSessionLines(sessionId, cwd?)` — Raw JSONL lines
- `listSubagentFiles(sessionId?, cwd?)` — Subagent file metadata

### SessionParser
Parse JSONL sessions into structured data. No server dependencies.

- `parseSession(sessionId, cwd?)` — Full session parse
- `getConversation(options)` — Simplified conversation format

### SessionCache
LMDB-backed cache for fast repeated reads with incremental parsing.

- `getSessionData(filePath)` — Cached session data (async)
- `getSessionDataSync(filePath)` — Synchronous variant
- `getRawMessages(filePath)` — Raw parsed messages
- `getAllSessionsFromCache()` — All cached sessions
- `getProjectSessionsFromCache(projectPath)` — Project sessions from cache
- `getPerProjectCosts()` — Per-project cost totals
- `startWatching()` — File watcher (requires chokidar)
- `close()` — Shut down LMDB

### ProjectsService
Project discovery with git info and cost metadata.

- `listProjects(options?)` — All projects with metadata
- `listProjectSessions(projectPath, options?)` — Sessions with enriched data
- `getGitInfo(projectPath)` — Git branch, remotes, commit

### TasksService
Read Claude Code task files from `~/.claude/tasks/`.

- `listTaskLists()` — All task lists
- `getTaskList(listId)` — Tasks in a list
- `getReadyTasks(listId)` — Unblocked tasks
- `getAllTasksFlat()` — All tasks across all lists

### AgentTeamsService
Read team configs from `~/.claude/teams/`.

- `listTeams()` — All teams
- `getTeam(teamName)` — Team config

### CostCalculator
Token cost calculation with tiered pricing.

- `calculateCost(usage, model?)` — Calculate cost from token usage
- `getPricing(model)` — Get pricing for a model
- `formatCost(cost)` — Format as `$X.XX`

### Path Utilities
- `legacyEncodeProjectPath(path)` — Dash-encoded path
- `encodePath(path)` / `decodePath(encoded)` — Base64 path encoding
- `getProjectsDir()` — `~/.claude/projects/`
- `extractProjectPath(storagePath)` — Extract project path from storage path

## Optional Dependencies

- **chokidar** — File watching for live cache updates. Install with `npm install chokidar` if you need `SessionCache.startWatching()`.
