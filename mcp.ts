// MCP over Streamable HTTP: JSON-RPC 2.0, the 2026-07-28 discovery revision plus the classic
// initialize handshake, and tools over the same store REST and GraphQL use — so an issue created
// here reads back identically over REST (the suite's rest-parity check).

import { planMerge } from './diff.ts';
import { addCommentRecord, createIssueRecord, createPullRecord, mergePull } from './ops.ts';
import { issueJson, labelJson, repoJson, type Json } from './serialize.ts';
import { VIEWER_LOGIN, forge, nowDate, type IssueRec, type Repo } from './store.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SESSION_ID = 'git-forge-mcp-session';

class ToolError extends Error {}

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
  run: (args: Record<string, unknown>) => unknown;
}

function repoArgs(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if (typeof args.full_name === 'string' && args.full_name.includes('/')) {
    const [o, r] = args.full_name.split('/');
    if (!owner) owner = o;
    if (!repo) repo = r;
  }
  if (!owner) owner = VIEWER_LOGIN;
  return { owner, repo };
}

function needRepo(args: Record<string, unknown>): Repo {
  const { owner, repo } = repoArgs(args);
  if (!repo) throw new ToolError('missing required argument: repo');
  const found = forge.getRepo(owner, repo);
  if (!found) throw new ToolError(`repository ${owner}/${repo} not found`);
  return found;
}

function needString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value === '') throw new ToolError(`missing required argument: ${key}`);
  return value;
}

function needNumber(args: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  throw new ToolError(`missing required argument: ${keys[0]}`);
}

function pullShape(repo: Repo, pr: IssueRec): Json {
  const base = issueJson(repo, pr) as Json;
  const pull = pr.pull as NonNullable<IssueRec['pull']>;
  const plan = planMerge(repo, pull.headRef, pull.baseRef);
  return {
    ...base,
    head: { ref: pull.headRef, sha: repo.refs.get(`refs/heads/${pull.headRef}`) ?? null },
    base: { ref: pull.baseRef, sha: repo.refs.get(`refs/heads/${pull.baseRef}`) ?? null },
    merged: pull.merged,
    merged_at: pull.mergedAt ? pull.mergedAt.toISOString().replace(/\.\d{3}Z$/, 'Z') : null,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.merged ? true : plan.mergeable,
  };
}

const ownerRepoProps = {
  owner: { type: 'string', description: 'The repository owner login.' },
  repo: { type: 'string', description: 'The repository name.' },
  full_name: { type: 'string', description: 'The repository full name, "owner/repo".' },
};

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
    run: (args) => {
      const name = needString(args, 'name');
      if (forge.getRepo(VIEWER_LOGIN, name)) throw new ToolError(`a repository named ${name} already exists on this account`);
      const repo = forge.createRepo(name, typeof args.description === 'string' ? args.description : '', args.private === true);
      return repoJson(repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: { ...ownerRepoProps },
    required: ['repo'],
    run: (args) => repoJson(needRepo(args)),
  },
  {
    name: 'list_repos',
    description: 'List the repositories owned by the authenticated user.',
    properties: {},
    required: [],
    run: () => forge.listRepos().map((repo) => repoJson(repo)),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      ...ownerRepoProps,
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
      labels: { type: 'array', description: 'Label names to apply; each must already exist on the repository.' },
    },
    required: ['repo', 'title'],
    run: (args) => {
      const repo = needRepo(args);
      const title = needString(args, 'title');
      const labels = Array.isArray(args.labels) ? args.labels.filter((item): item is string => typeof item === 'string') : [];
      for (const name of labels) if (!repo.labels.has(name)) throw new ToolError(`label "${name}" does not exist on ${repo.fullName}`);
      const rec = createIssueRecord(forge, repo, { title, body: typeof args.body === 'string' ? args.body : null, labels });
      return issueJson(repo, rec);
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    properties: { ...ownerRepoProps, issue_number: { type: 'number', description: 'The issue number.' } },
    required: ['repo', 'issue_number'],
    run: (args) => {
      const repo = needRepo(args);
      const rec = repo.issues.get(needNumber(args, ['issue_number', 'number']));
      if (!rec || rec.pull) throw new ToolError('issue not found');
      return issueJson(repo, rec);
    },
  },
  {
    name: 'list_issues',
    description: 'List a repository\'s issues, optionally filtered by state (open, closed, all).',
    properties: { ...ownerRepoProps, state: { type: 'string', description: 'open, closed or all (default open).' } },
    required: ['repo'],
    run: (args) => {
      const repo = needRepo(args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      return [...repo.issues.values()]
        .filter((rec) => !rec.pull && (state === 'all' || rec.state === state))
        .sort((a, b) => a.number - b.number)
        .map((rec) => issueJson(repo, rec));
    },
  },
  {
    name: 'update_issue',
    description: 'Update an issue\'s title, body or state.',
    properties: {
      ...ownerRepoProps,
      issue_number: { type: 'number', description: 'The issue number.' },
      title: { type: 'string', description: 'The new title.' },
      body: { type: 'string', description: 'The new body.' },
      state: { type: 'string', description: 'open or closed.' },
    },
    required: ['repo', 'issue_number'],
    run: (args) => {
      const repo = needRepo(args);
      const rec = repo.issues.get(needNumber(args, ['issue_number', 'number']));
      if (!rec) throw new ToolError('issue not found');
      if (typeof args.title === 'string') rec.title = args.title;
      if (typeof args.body === 'string') rec.body = args.body;
      if (args.state === 'closed' || args.state === 'open') {
        rec.state = args.state;
        rec.closedAt = args.state === 'closed' ? nowDate() : null;
      }
      rec.updatedAt = nowDate();
      return issueJson(repo, rec);
    },
  },
  {
    name: 'create_comment',
    description: 'Comment on an issue or pull request.',
    properties: {
      ...ownerRepoProps,
      issue_number: { type: 'number', description: 'The issue or pull request number.' },
      body: { type: 'string', description: 'The comment body.' },
    },
    required: ['repo', 'issue_number', 'body'],
    run: (args) => {
      const repo = needRepo(args);
      const rec = repo.issues.get(needNumber(args, ['issue_number', 'number']));
      if (!rec) throw new ToolError('issue not found');
      const comment = addCommentRecord(forge, repo, rec, needString(args, 'body'));
      return { id: comment.id, body: comment.body, issue_number: rec.number };
    },
  },
  {
    name: 'list_comments',
    description: 'List the comments on an issue or pull request.',
    properties: { ...ownerRepoProps, issue_number: { type: 'number', description: 'The issue or pull request number.' } },
    required: ['repo', 'issue_number'],
    run: (args) => {
      const repo = needRepo(args);
      const rec = repo.issues.get(needNumber(args, ['issue_number', 'number']));
      if (!rec) throw new ToolError('issue not found');
      return rec.comments.map((comment) => ({ id: comment.id, body: comment.body }));
    },
  },
  {
    name: 'create_label',
    description: 'Create a label on a repository.',
    properties: {
      ...ownerRepoProps,
      name: { type: 'string', description: 'The label name.' },
      color: { type: 'string', description: 'The label color, six hex digits.' },
      description: { type: 'string', description: 'The label description.' },
    },
    required: ['repo', 'name'],
    run: (args) => {
      const repo = needRepo(args);
      const name = needString(args, 'name');
      if (repo.labels.has(name)) throw new ToolError(`label "${name}" already exists`);
      const label = {
        id: forge.newLabelId(),
        name,
        color: (typeof args.color === 'string' ? args.color : 'ededed').replace(/^#/, ''),
        description: typeof args.description === 'string' ? args.description : null,
      };
      repo.labels.set(name, label);
      return labelJson(repo, label);
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    properties: {
      ...ownerRepoProps,
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['repo', 'title', 'head', 'base'],
    run: (args) => {
      const repo = needRepo(args);
      const headRaw = needString(args, 'head');
      const head = headRaw.includes(':') ? headRaw.slice(headRaw.indexOf(':') + 1) : headRaw;
      const base = needString(args, 'base');
      if (!repo.refs.has(`refs/heads/${head}`)) throw new ToolError(`head branch ${head} does not exist`);
      if (!repo.refs.has(`refs/heads/${base}`)) throw new ToolError(`base branch ${base} does not exist`);
      const rec = createPullRecord(forge, repo, {
        title: needString(args, 'title'),
        body: typeof args.body === 'string' ? args.body : null,
        head,
        base,
      });
      return pullShape(repo, rec);
    },
  },
  {
    name: 'get_pull_request',
    description: 'Get one pull request by number.',
    properties: { ...ownerRepoProps, pull_number: { type: 'number', description: 'The pull request number.' } },
    required: ['repo', 'pull_number'],
    run: (args) => {
      const repo = needRepo(args);
      const rec = repo.issues.get(needNumber(args, ['pull_number', 'number']));
      if (!rec?.pull) throw new ToolError('pull request not found');
      return pullShape(repo, rec);
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List a repository\'s pull requests, optionally filtered by state.',
    properties: { ...ownerRepoProps, state: { type: 'string', description: 'open, closed or all (default open).' } },
    required: ['repo'],
    run: (args) => {
      const repo = needRepo(args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      return [...repo.issues.values()]
        .filter((rec) => rec.pull && (state === 'all' || rec.state === state))
        .sort((a, b) => a.number - b.number)
        .map((rec) => pullShape(repo, rec));
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    properties: { ...ownerRepoProps, pull_number: { type: 'number', description: 'The pull request number.' } },
    required: ['repo', 'pull_number'],
    run: (args) => {
      const repo = needRepo(args);
      const rec = repo.issues.get(needNumber(args, ['pull_number', 'number']));
      if (!rec?.pull) throw new ToolError('pull request not found');
      const outcome = mergePull(forge, repo, rec);
      if (!outcome.ok) {
        if (outcome.reason === 'already-merged') throw new ToolError('pull request is already merged');
        if (outcome.reason === 'conflict') throw new ToolError('pull request is not mergeable: it conflicts with the base branch');
        throw new ToolError('pull request branches are missing');
      }
      return { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' };
    },
  },
];

/** The tools/list result, built once so repeated calls are byte-for-byte identical. */
const TOOLS_LIST_RESULT = {
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
  })),
};

interface RpcMessage {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function handleMessage(message: RpcMessage): Record<string, unknown> | null {
  const isNotification = message.id === undefined || message.id === null;
  const method = message.method;
  if (typeof method !== 'string') {
    return isNotification ? null : rpcError(message.id, -32600, 'Invalid Request: method must be a string');
  }
  if (method.startsWith('notifications/')) return null;
  const params = message.params ?? {};
  switch (method) {
    case 'server/discover':
      return rpcResult(message.id, {
        protocolVersion: SUPPORTED_VERSIONS[0],
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: { name: 'git-forge', version: '1.0.0' },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(message.id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'git-forge', version: '1.0.0' },
      });
    }
    case 'ping':
      return rpcResult(message.id, {});
    case 'tools/list':
      return rpcResult(message.id, TOOLS_LIST_RESULT);
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((item) => item.name === name);
      if (!tool) return rpcError(message.id, -32602, `Unknown tool: ${name}`);
      const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
      try {
        const value = tool.run(args);
        const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
        return rpcResult(message.id, {
          content: [{ type: 'text', text }],
          structuredContent: value && typeof value === 'object' ? value : undefined,
          isError: false,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        return rpcResult(message.id, { content: [{ type: 'text', text }], isError: true });
      }
    }
    case 'resources/list':
      return rpcResult(message.id, { resources: [] });
    case 'resources/templates/list':
      return rpcResult(message.id, { resourceTemplates: [] });
    case 'prompts/list':
      return rpcResult(message.id, { prompts: [] });
    default:
      return rpcError(message.id, -32601, `Method not found: ${method}`);
  }
}

export interface McpResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
}

/** Handle one POST /mcp with a raw body (single message or a batch array). */
export function handleMcp(rawBody: Buffer): McpResponse {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Mcp-Session-Id': SESSION_ID };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: JSON.stringify(rpcError(null, -32700, 'Parse error: the body is not valid JSON')), headers };
  }
  if (Array.isArray(parsed)) {
    const results = parsed
      .map((item) => (item && typeof item === 'object' ? handleMessage(item as RpcMessage) : rpcError(null, -32600, 'Invalid Request')))
      .filter((item) => item !== null);
    if (results.length === 0) return { status: 202, body: '', headers };
    return { status: 200, body: JSON.stringify(results), headers };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { status: 400, body: JSON.stringify(rpcError(null, -32600, 'Invalid Request: expected a JSON-RPC object')), headers };
  }
  const result = handleMessage(parsed as RpcMessage);
  if (result === null) return { status: 202, body: '', headers };
  return { status: 200, body: JSON.stringify(result), headers };
}
