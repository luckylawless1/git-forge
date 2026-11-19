// REST API v3: repositories, contents, branches, refs, commits, labels, issues, comments and pull
// requests, in GitHub's shapes and status codes. A repository under any owner but the token's
// login does not exist here (404, never 403).

import { flattenTree, parseCommit, parseTree } from './git.ts';
import { diffTrees, planMerge } from './diff.ts';
import { addCommentRecord, branchFiles, commitFiles, createIssueRecord, createPullRecord, mergePull } from './ops.ts';
import {
  commentJson,
  commitJson,
  issueJson,
  labelJson,
  repoJson,
  userJson,
  viewerJson,
  type Json,
} from './serialize.ts';
import {
  VIEWER_LOGIN,
  forge,
  nowDate,
  type IssueRec,
  type Repo,
} from './store.ts';

export interface RestResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface RestRequest {
  method: string;
  /** Path segments after /api/v3, URL-decoded. */
  parts: string[];
  query: URLSearchParams;
  body: Record<string, unknown> | undefined;
  /** Absolute base of this server, for Link headers. */
  base: string;
}

const notFound = (): RestResult => ({ status: 404, body: { message: 'Not Found' } });
const unprocessable = (message: string, errors?: unknown[]): RestResult => ({
  status: 422,
  body: errors ? { message, errors } : { message },
});

function bodyString(body: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = body?.[key];
  return typeof value === 'string' ? value : undefined;
}

function labelNames(body: Record<string, unknown> | undefined): string[] {
  const raw = body?.labels;
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') names.push(item);
    else if (item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') {
      names.push((item as { name: string }).name);
    }
  }
  return names;
}

/** Validate label names against the repo; returns a 422 result or null. */
function checkLabels(repo: Repo, names: string[]): RestResult | null {
  const missing = names.filter((name) => !repo.labels.has(name));
  if (missing.length === 0) return null;
  return unprocessable('Validation Failed', [
    { resource: 'Issue', code: 'invalid', field: 'labels', value: missing[0] },
  ]);
}

function paginate<T>(req: RestRequest, items: T[], path: string): { page: T[]; headers?: Record<string, string> } {
  const perPage = Math.max(1, Math.min(100, Number(req.query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(req.query.get('page') ?? '1') || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const last = Math.ceil(items.length / perPage);
    headers.Link =
      `<${req.base}${path}?page=${page + 1}&per_page=${perPage}>; rel="next", ` +
      `<${req.base}${path}?page=${last}&per_page=${perPage}>; rel="last"`;
  }
  return { page: slice, headers };
}

/** Resolve a branch name, full ref or oid to a commit oid. */
export function resolveCommit(repo: Repo, name: string | null | undefined): string | null {
  if (!name) return repo.defaultTip();
  for (const candidate of [`refs/heads/${name}`, name, `refs/tags/${name}`]) {
    const oid = repo.refs.get(candidate);
    if (oid) return oid;
  }
  const object = repo.objects.get(name);
  return object ? name : null;
}

export function handleRest(req: RestRequest): RestResult {
  const { parts } = req;
  if (parts.length === 0) {
    if (req.method === 'GET') {
      return {
        status: 200,
        body: {
          current_user_url: `${req.base}/api/v3/user`,
          repository_url: `${req.base}/api/v3/repos/{owner}/{repo}`,
          issue_search_url: `${req.base}/api/v3/search/issues?q={query}{&page,per_page,sort,order}`,
          _links: {
            user: { href: `${req.base}/api/v3/user` },
            meta: { href: `${req.base}/api/v3/meta` },
          },
        },
      };
    }
    return notFound();
  }
  if (parts[0] === 'meta' && parts.length === 1 && req.method === 'GET') {
    return {
      status: 200,
      body: {
        verifiable_password_authentication: false,
        ssh_key_fingerprints: { SHA256_RSA: '', SHA256_ECDSA: '', SHA256_ED25519: '' },
        ssh_keys: [],
        hooks: [],
        web: [],
        api: [],
        git: [],
        packages: [],
        pages: [],
        importer: [],
        actions: [],
        dependabot: [],
        installed_version: '1.0.0',
      },
    };
  }
  if (parts[0] === 'user') return userRoutes(req);
  if (parts[0] === 'users' && parts.length === 2 && req.method === 'GET') {
    return parts[1] === VIEWER_LOGIN ? { status: 200, body: viewerJson() } : notFound();
  }
  if (parts[0] === 'repos' && parts.length >= 3) return repoRoutes(req, parts[1], parts[2]);
  return notFound();
}

function userRoutes(req: RestRequest): RestResult {
  const { parts } = req;
  if (parts.length === 1 && req.method === 'GET') return { status: 200, body: viewerJson() };
  if (parts.length === 2 && parts[1] === 'repos') {
    if (req.method === 'POST') {
      const name = bodyString(req.body, 'name');
      if (!name) {
        return unprocessable('Repository creation failed.', [
          { resource: 'Repository', code: 'missing_field', field: 'name', message: 'name is required' },
        ]);
      }
      if (forge.getRepo(VIEWER_LOGIN, name)) {
        return unprocessable('Repository creation failed.', [
          { resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' },
        ]);
      }
      const repo = forge.createRepo(
        name,
        bodyString(req.body, 'description') ?? '',
        req.body?.private === true,
        bodyString(req.body, 'default_branch') || 'main',
      );
      return { status: 201, body: repoJson(repo) };
    }
    if (req.method === 'GET') {
      const { page, headers } = paginate(req, forge.listRepos(), '/api/v3/user/repos');
      return { status: 200, body: page.map((repo) => repoJson(repo)), headers };
    }
  }
  return notFound();
}

function repoRoutes(req: RestRequest, owner: string, name: string): RestResult {
  const repo = forge.getRepo(owner, name);
  const rest = req.parts.slice(3);
  if (rest.length === 0) {
    if (!repo) return notFound();
    if (req.method === 'GET') return { status: 200, body: repoJson(repo) };
    if (req.method === 'PATCH') {
      const newName = bodyString(req.body, 'name');
      if (newName && newName !== repo.name) {
        if (forge.getRepo(owner, newName)) return unprocessable('Repository update failed.', [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }]);
        forge.repos.delete(repo.fullName);
        repo.name = newName;
        forge.repos.set(repo.fullName, repo);
      }
      const description = bodyString(req.body, 'description');
      if (description !== undefined) repo.description = description;
      if (typeof req.body?.private === 'boolean') repo.isPrivate = req.body.private;
      const defaultBranch = bodyString(req.body, 'default_branch');
      if (defaultBranch) {
        repo.defaultBranch = defaultBranch;
        repo.headRef = `refs/heads/${defaultBranch}`;
      }
      repo.updatedAt = nowDate();
      return { status: 200, body: repoJson(repo) };
    }
    if (req.method === 'DELETE') {
      forge.deleteRepo(repo);
      return { status: 204 };
    }
    return notFound();
  }
  if (!repo) return notFound();
  switch (rest[0]) {
    case 'branches':
      return branchRoutes(req, repo, rest.slice(1));
    case 'commits':
      return commitRoutes(req, repo, rest.slice(1));
    case 'contents':
      return contentRoutes(req, repo, rest.slice(1).join('/'));
    case 'git':
      return gitRoutes(req, repo, rest.slice(1));
    case 'labels':
      return labelRoutes(req, repo, rest.slice(1));
    case 'issues':
      return issueRoutes(req, repo, rest.slice(1));
    case 'pulls':
      return pullRoutes(req, repo, rest.slice(1));
    default:
      return notFound();
  }
}

function branchRoutes(req: RestRequest, repo: Repo, rest: string[]): RestResult {
  if (rest.length === 0 && req.method === 'GET') {
    const branches = [...repo.refs.keys()]
      .filter((ref) => ref.startsWith('refs/heads/'))
      .sort()
      .map((ref) => ({
        name: ref.slice('refs/heads/'.length),
        commit: { sha: repo.refs.get(ref) as string, url: `${req.base}/api/v3/repos/${repo.fullName}/commits/${repo.refs.get(ref)}` },
        protected: false,
      }));
    return { status: 200, body: branches };
  }
  if (req.method === 'GET') {
    const branch = rest.join('/');
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (!sha) return notFound();
    const commit = commitJson(repo, sha);
    return {
      status: 200,
      body: {
        name: branch,
        commit,
        protected: false,
        _links: { self: `${req.base}/api/v3/repos/${repo.fullName}/branches/${branch}`, html: `${req.base}/${repo.fullName}/tree/${branch}` },
      },
    };
  }
  return notFound();
}

function commitRoutes(req: RestRequest, repo: Repo, rest: string[]): RestResult {
  if (req.method !== 'GET') return notFound();
  if (rest.length === 1) {
    const commit = commitJson(repo, rest[0]);
    return commit ? { status: 200, body: commit } : notFound();
  }
  if (rest.length === 0) {
    const start = resolveCommit(repo, req.query.get('sha'));
    if (!start) return { status: 200, body: [] };
    const perPage = Math.max(1, Math.min(100, Number(req.query.get('per_page') ?? '30') || 30));
    const page = Math.max(1, Number(req.query.get('page') ?? '1') || 1);
    const all = repo.listCommits(start, 1000);
    const slice = all.slice((page - 1) * perPage, page * perPage);
    return { status: 200, body: slice.map((sha) => commitJson(repo, sha)).filter(Boolean) };
  }
  return notFound();
}

function contentRoutes(req: RestRequest, repo: Repo, path: string): RestResult {
  const api = `${req.base}/api/v3/repos/${repo.fullName}`;
  if (req.method === 'GET') {
    const commit = resolveCommit(repo, req.query.get('ref'));
    if (!commit) return notFound();
    const commitObj = repo.objects.get(commit);
    if (!commitObj || commitObj.type !== 'commit') return notFound();
    const files = flattenTree(repo.objects, parseCommit(commitObj.data).tree);
    if (path === '') {
      return { status: 200, body: dirListing(repo, '', files, req.base) };
    }
    const blob = files.get(path);
    if (blob) {
      const object = repo.objects.get(blob);
      const data = object?.data ?? Buffer.alloc(0);
      return {
        status: 200,
        body: {
          name: path.split('/').pop(),
          path,
          sha: blob,
          size: data.length,
          url: `${api}/contents/${path}`,
          html_url: `${req.base}/${repo.fullName}/blob/${repo.defaultBranch}/${path}`,
          git_url: `${api}/git/blobs/${blob}`,
          download_url: `${req.base}/${repo.fullName}/raw/${repo.defaultBranch}/${path}`,
          type: 'file',
          content: data.toString('base64').replace(/(.{60})/g, '$1\n'),
          encoding: 'base64',
          _links: { self: `${api}/contents/${path}`, git: `${api}/git/blobs/${blob}`, html: `${req.base}/${repo.fullName}/blob/${repo.defaultBranch}/${path}` },
        },
      };
    }
    const prefix = `${path}/`;
    if ([...files.keys()].some((key) => key.startsWith(prefix))) {
      return { status: 200, body: dirListing(repo, path, files, req.base) };
    }
    return notFound();
  }
  if (req.method === 'PUT') {
    const message = bodyString(req.body, 'message');
    const content = bodyString(req.body, 'content');
    if (message === undefined || content === undefined) return unprocessable('Validation Failed', [{ resource: 'Content', code: 'missing_field', field: message === undefined ? 'message' : 'content' }]);
    const branch = bodyString(req.body, 'branch') || repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    const files = branchFiles(repo, ref);
    const existing = files.get(path);
    const givenSha = bodyString(req.body, 'sha');
    if (existing && givenSha !== existing) {
      return { status: 409, body: { message: 'Conflict: the given sha does not match the current file sha' } };
    }
    const blob = repo.objects.put('blob', Buffer.from(content.replace(/\s+/g, ''), 'base64'));
    files.set(path, blob);
    const commitSha = commitFiles(repo, ref, files, message);
    const status = existing ? 200 : 201;
    const commit = commitJson(repo, commitSha);
    return {
      status,
      body: {
        content: {
          name: path.split('/').pop(),
          path,
          sha: blob,
          size: repo.objects.get(blob)?.data.length ?? 0,
          url: `${api}/contents/${path}`,
          html_url: `${req.base}/${repo.fullName}/blob/${branch}/${path}`,
          git_url: `${api}/git/blobs/${blob}`,
          download_url: `${req.base}/${repo.fullName}/raw/${branch}/${path}`,
          type: 'file',
          encoding: 'base64',
          content: (repo.objects.get(blob)?.data ?? Buffer.alloc(0)).toString('base64'),
          _links: { self: `${api}/contents/${path}`, git: `${api}/git/blobs/${blob}`, html: `${req.base}/${repo.fullName}/blob/${branch}/${path}` },
        },
        commit: commit?.commit ? { ...commit.commit, sha: commitSha, url: `${api}/git/commits/${commitSha}`, html_url: `${req.base}/${repo.fullName}/commit/${commitSha}` } : { sha: commitSha },
      },
    };
  }
  if (req.method === 'DELETE') {
    const message = bodyString(req.body, 'message');
    const sha = bodyString(req.body, 'sha');
    if (message === undefined || sha === undefined) return unprocessable('Validation Failed');
    const branch = bodyString(req.body, 'branch') || repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    const files = branchFiles(repo, ref);
    const existing = files.get(path);
    if (!existing) return notFound();
    if (sha !== existing) return { status: 409, body: { message: 'Conflict: the given sha does not match the current file sha' } };
    files.delete(path);
    const commitSha = commitFiles(repo, ref, files, message);
    const commit = commitJson(repo, commitSha);
    return {
      status: 200,
      body: {
        content: null,
        commit: commit?.commit ? { ...commit.commit, sha: commitSha, url: `${api}/git/commits/${commitSha}`, html_url: `${req.base}/${repo.fullName}/commit/${commitSha}` } : { sha: commitSha },
      },
    };
  }
  return notFound();
}

function dirListing(repo: Repo, dir: string, files: Map<string, string>, base: string): Json[] {
  const prefix = dir === '' ? '' : `${dir}/`;
  const entries = new Map<string, { type: 'file' | 'dir'; sha: string | null; size: number }>();
  for (const [path, blob] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) entries.set(rest, { type: 'file', sha: blob, size: repo.objects.get(blob)?.data.length ?? 0 });
    else if (!entries.has(rest.slice(0, slash))) entries.set(rest.slice(0, slash), { type: 'dir', sha: null, size: 0 });
  }
  return [...entries.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, entry]) => {
      const full = prefix + name;
      const tree = dirTreeSha(repo, full);
      return {
        name,
        path: full,
        sha: entry.type === 'file' ? entry.sha : tree,
        size: entry.size,
        url: `${base}/api/v3/repos/${repo.fullName}/contents/${full}`,
        html_url: `${base}/${repo.fullName}/${entry.type === 'file' ? 'blob' : 'tree'}/${repo.defaultBranch}/${full}`,
        git_url: `${base}/api/v3/repos/${repo.fullName}/git/${entry.type === 'file' ? 'blobs' : 'trees'}/${entry.type === 'file' ? entry.sha : tree}`,
        download_url: entry.type === 'file' ? `${base}/${repo.fullName}/raw/${repo.defaultBranch}/${full}` : null,
        type: entry.type,
        _links: {
          self: `${base}/api/v3/repos/${repo.fullName}/contents/${full}`,
          git: `${base}/api/v3/repos/${repo.fullName}/git/${entry.type === 'file' ? 'blobs' : 'trees'}/${entry.type === 'file' ? entry.sha : tree}`,
          html: `${base}/${repo.fullName}/${entry.type === 'file' ? 'blob' : 'tree'}/${repo.defaultBranch}/${full}`,
        },
      } as unknown as Json;
    });
}

/** The tree oid for a directory path in the default branch (for directory listings). */
function dirTreeSha(repo: Repo, dir: string): string | null {
  const tip = repo.defaultTip();
  if (!tip) return null;
  const commitObj = repo.objects.get(tip);
  if (!commitObj || commitObj.type !== 'commit') return null;
  let tree = parseCommit(commitObj.data).tree;
  if (dir === '') return tree;
  for (const part of dir.split('/')) {
    const entries = parseTree(repo.objects.get(tree)?.data ?? Buffer.alloc(0));
    const next = entries.find((entry) => entry.name === part && entry.mode === '40000');
    if (!next) return null;
    tree = next.oid;
  }
  return tree;
}

function gitRoutes(req: RestRequest, repo: Repo, rest: string[]): RestResult {
  if (rest[0] === 'refs') {
    if (req.method === 'POST' && rest.length === 1) {
      const ref = bodyString(req.body, 'ref');
      const sha = bodyString(req.body, 'sha');
      if (!ref || !sha || !ref.startsWith('refs/')) return unprocessable('Validation Failed');
      const object = repo.objects.get(sha);
      if (!object) return unprocessable('Object does not exist', [{ resource: 'Reference', code: 'custom', field: 'sha', message: 'Object does not exist' }]);
      repo.refs.set(ref, sha);
      return {
        status: 201,
        body: {
          ref,
          node_id: `REF:${ref}`,
          url: `${req.base}/api/v3/repos/${repo.fullName}/git/refs/${ref.slice('refs/'.length)}`,
          object: { type: object.type, sha, url: `${req.base}/api/v3/repos/${repo.fullName}/git/${object.type === 'commit' ? 'commits' : 'trees'}/${sha}` },
        },
      };
    }
    if (req.method === 'GET') {
      const name = rest.slice(1).join('/');
      if (name) {
        const full = name.startsWith('refs/') ? name : `refs/${name}`;
        const sha = repo.refs.get(full);
        if (!sha) return notFound();
        const object = repo.objects.get(sha);
        return {
          status: 200,
          body: {
            ref: full,
            node_id: `REF:${full}`,
            url: `${req.base}/api/v3/repos/${repo.fullName}/git/refs/${name}`,
            object: { type: object?.type ?? 'commit', sha, url: `${req.base}/api/v3/repos/${repo.fullName}/git/commits/${sha}` },
          },
        };
      }
      const all = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([ref, sha]) => ({
        ref,
        node_id: `REF:${ref}`,
        url: `${req.base}/api/v3/repos/${repo.fullName}/git/refs/${ref.slice('refs/'.length)}`,
        object: { type: repo.objects.get(sha)?.type ?? 'commit', sha, url: `${req.base}/api/v3/repos/${repo.fullName}/git/commits/${sha}` },
      }));
      return { status: 200, body: all };
    }
  }
  return notFound();
}

function labelRoutes(req: RestRequest, repo: Repo, rest: string[]): RestResult {
  if (rest.length === 0) {
    if (req.method === 'GET') return { status: 200, body: [...repo.labels.values()].map((label) => labelJson(repo, label)) };
    if (req.method === 'POST') {
      const name = bodyString(req.body, 'name');
      if (!name) return unprocessable('Validation Failed', [{ resource: 'Label', code: 'missing_field', field: 'name' }]);
      if (repo.labels.has(name)) return unprocessable('Validation Failed', [{ resource: 'Label', code: 'already_exists', field: 'name' }]);
      const label = {
        id: forge.newLabelId(),
        name,
        color: (bodyString(req.body, 'color') ?? 'ededed').replace(/^#/, ''),
        description: bodyString(req.body, 'description') ?? null,
      };
      repo.labels.set(name, label);
      return { status: 201, body: labelJson(repo, label) };
    }
  }
  if (rest.length === 1) {
    const label = repo.labels.get(decodeURIComponent(rest[0]));
    if (!label) return notFound();
    if (req.method === 'GET') return { status: 200, body: labelJson(repo, label) };
  }
  return notFound();
}

function sortedIssues(repo: Repo, req: RestRequest, pullsOnly: boolean): IssueRec[] {
  const state = req.query.get('state') ?? 'open';
  const sort = req.query.get('sort') ?? 'created';
  const direction = req.query.get('direction') ?? 'desc';
  let list = [...repo.issues.values()].filter((issue) => (pullsOnly ? issue.pull !== null : issue.pull === null));
  if (state === 'open') list = list.filter((issue) => issue.state === 'open');
  else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
  const key = (issue: IssueRec): number => (sort === 'updated' ? issue.updatedAt.getTime() : issue.createdAt.getTime());
  list.sort((a, b) => {
    const byKey = key(a) - key(b);
    const byNumber = a.number - b.number;
    return direction === 'asc' ? byKey || byNumber : -(byKey || byNumber);
  });
  return list;
}

function issueRoutes(req: RestRequest, repo: Repo, rest: string[]): RestResult {
  if (rest.length === 0) {
    if (req.method === 'POST') {
      const title = bodyString(req.body, 'title');
      if (!title) return unprocessable('Validation Failed', [{ resource: 'Issue', code: 'missing_field', field: 'title' }]);
      const labels = labelNames(req.body);
      const bad = checkLabels(repo, labels);
      if (bad) return bad;
      const issue = createIssueRecord(forge, repo, { title, body: bodyString(req.body, 'body') ?? null, labels });
      return { status: 201, body: issueJson(repo, issue) };
    }
    if (req.method === 'GET') {
      const { page, headers } = paginate(req, sortedIssues(repo, req, false), `/api/v3/repos/${repo.fullName}/issues`);
      return { status: 200, body: page.map((issue) => issueJson(repo, issue)), headers };
    }
    return notFound();
  }
  const number = Number(rest[0]);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
  if (!issue) return notFound();
  if (rest.length === 1) {
    if (req.method === 'GET') return { status: 200, body: issueJson(repo, issue) };
    if (req.method === 'PATCH') {
      const labels = req.body && 'labels' in req.body ? labelNames(req.body) : undefined;
      if (labels) {
        const bad = checkLabels(repo, labels);
        if (bad) return bad;
        issue.labels = labels;
      }
      const title = bodyString(req.body, 'title');
      if (title !== undefined) issue.title = title;
      if (req.body && 'body' in req.body) issue.body = bodyString(req.body, 'body') ?? null;
      const state = bodyString(req.body, 'state');
      if (state === 'closed' || state === 'open') {
        issue.state = state;
        issue.closedAt = state === 'closed' ? nowDate() : null;
      }
      issue.updatedAt = nowDate();
      return { status: 200, body: issueJson(repo, issue) };
    }
    return notFound();
  }
  if (rest[1] === 'comments') {
    if (rest.length === 2 && req.method === 'GET') {
      return { status: 200, body: issue.comments.map((comment) => commentJson(repo, issue, comment)) };
    }
    if (rest.length === 2 && req.method === 'POST') {
      const body = bodyString(req.body, 'body');
      if (body === undefined) return unprocessable('Validation Failed', [{ resource: 'IssueComment', code: 'missing_field', field: 'body' }]);
      const comment = addCommentRecord(forge, issue, body);
      return { status: 201, body: commentJson(repo, issue, comment) };
    }
    if (rest.length === 3 && req.method === 'GET') {
      const comment = issue.comments.find((item) => item.id === Number(rest[2]));
      return comment ? { status: 200, body: commentJson(repo, issue, comment) } : notFound();
    }
  }
  if (rest[1] === 'labels') {
    if (req.method === 'GET') {
      return { status: 200, body: issue.labels.map((name) => repo.labels.get(name)).filter(Boolean).map((label) => labelJson(repo, label as NonNullable<typeof label>)) };
    }
    if (req.method === 'POST') {
      const labels = labelNames(req.body);
      const bad = checkLabels(repo, labels);
      if (bad) return bad;
      for (const name of labels) if (!issue.labels.includes(name)) issue.labels.push(name);
      issue.updatedAt = nowDate();
      return { status: 200, body: issue.labels.map((name) => repo.labels.get(name)).filter(Boolean).map((label) => labelJson(repo, label as NonNullable<typeof label>)) };
    }
  }
  return notFound();
}

function pullJson(req: RestRequest, repo: Repo, pr: IssueRec): Json {
  const out = issueJson(repo, pr) as Json;
  const pull = pr.pull as NonNullable<IssueRec['pull']>;
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? null;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? null;
  const plan = planMerge(repo, pull.headRef, pull.baseRef);
  const files = plan.base ? diffTrees(repo.objects, treeOf(repo, plan.base), treeOf(repo, plan.headTip)) : [];
  const side = (ref: string, sha: string | null): Json => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: userJson(repo.owner),
    repo: sha ? repoJson(repo) : repoJson(repo),
  });
  out.url = `${req.base}/api/v3/repos/${repo.fullName}/pulls/${pr.number}`;
  out.html_url = `${req.base}/${repo.fullName}/pull/${pr.number}`;
  out.diff_url = `${req.base}/${repo.fullName}/pull/${pr.number}.diff`;
  out.patch_url = `${req.base}/${repo.fullName}/pull/${pr.number}.patch`;
  out.head = side(pull.headRef, headTip);
  out.base = side(pull.baseRef, baseTip);
  out.merged = pull.merged;
  out.merged_at = pull.mergedAt ? pull.mergedAt.toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
  out.merge_commit_sha = pull.mergeCommitSha ?? (pull.merged ? null : plan.baseTip);
  out.mergeable = pull.merged ? true : plan.mergeable;
  out.mergeable_state = pull.merged || plan.mergeable ? 'clean' : 'dirty';
  out.rebaseable = plan.mergeable;
  out.draft = false;
  out.commits = plan.base && plan.headTip ? repo.listCommits(plan.headTip, 250).filter((sha) => sha !== plan.base && !isReachable(repo, plan.base as string, sha)).length : 0;
  out.additions = files.reduce((sum, file) => sum + file.additions, 0);
  out.deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  out.changed_files = files.length;
  delete out.pull_request;
  return out;
}

function treeOf(repo: Repo, commitOid: string | null): string | null {
  if (!commitOid) return null;
  const object = repo.objects.get(commitOid);
  return object && object.type === 'commit' ? parseCommit(object.data).tree : null;
}

function isReachable(repo: Repo, from: string, target: string): boolean {
  return repo.listCommits(from, 1000).includes(target);
}

function pullRoutes(req: RestRequest, repo: Repo, rest: string[]): RestResult {
  if (rest.length === 0) {
    if (req.method === 'POST') {
      const title = bodyString(req.body, 'title');
      const headRaw = bodyString(req.body, 'head');
      const base = bodyString(req.body, 'base');
      if (!title || !headRaw || !base) return unprocessable('Validation Failed');
      const head = headRaw.includes(':') ? headRaw.slice(headRaw.indexOf(':') + 1) : headRaw;
      if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) {
        return unprocessable('Validation Failed', [{ resource: 'PullRequest', code: 'invalid', field: 'head', message: 'head or base branch does not exist' }]);
      }
      const pr = createPullRecord(forge, repo, { title, body: bodyString(req.body, 'body') ?? null, head, base });
      return { status: 201, body: pullJson(req, repo, pr) };
    }
    if (req.method === 'GET') {
      const { page, headers } = paginate(req, sortedIssues(repo, req, true), `/api/v3/repos/${repo.fullName}/pulls`);
      return { status: 200, body: page.map((pr) => pullJson(req, repo, pr)), headers };
    }
    return notFound();
  }
  const number = Number(rest[0]);
  const pr = Number.isInteger(number) ? repo.issues.get(number) : undefined;
  if (!pr || !pr.pull) return notFound();
  if (rest.length === 1) {
    if (req.method === 'GET') return { status: 200, body: pullJson(req, repo, pr) };
    if (req.method === 'PATCH') {
      const title = bodyString(req.body, 'title');
      if (title !== undefined) pr.title = title;
      if (req.body && 'body' in req.body) pr.body = bodyString(req.body, 'body') ?? null;
      const state = bodyString(req.body, 'state');
      if (state === 'closed' || state === 'open') {
        pr.state = state;
        pr.closedAt = state === 'closed' ? nowDate() : null;
      }
      pr.updatedAt = nowDate();
      return { status: 200, body: pullJson(req, repo, pr) };
    }
    return notFound();
  }
  if (rest[1] === 'files' && rest.length === 2 && req.method === 'GET') {
    const plan = planMerge(repo, pr.pull.headRef, pr.pull.baseRef);
    const files = plan.base ? diffTrees(repo.objects, treeOf(repo, plan.base), treeOf(repo, plan.headTip)) : [];
    const api = `${req.base}/api/v3/repos/${repo.fullName}`;
    return {
      status: 200,
      body: files.map((file) => ({
        sha: file.sha,
        filename: file.path,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        blob_url: file.sha ? `${api}/git/blobs/${file.sha}` : null,
        raw_url: file.sha ? `${req.base}/${repo.fullName}/raw/${pr.pull?.headRef}/${file.path}` : null,
        contents_url: `${api}/contents/${file.path}?ref=${pr.pull?.headRef}`,
      })),
    };
  }
  if (rest[1] === 'merge' && rest.length === 2 && req.method === 'PUT') {
    if (pr.pull.merged || pr.state === 'closed') {
      return { status: 405, body: { message: 'Pull Request is not mergeable' } };
    }
    const expectedSha = bodyString(req.body, 'sha');
    const headTip = repo.refs.get(`refs/heads/${pr.pull.headRef}`);
    if (expectedSha && headTip && expectedSha !== headTip) {
      return { status: 409, body: { message: 'Head branch was modified. Review and try the merge again.' } };
    }
    const outcome = mergePull(repo, pr);
    if (!outcome.ok) {
      if (outcome.reason === 'already-merged') return { status: 405, body: { message: 'Pull Request is not mergeable' } };
      if (outcome.reason === 'missing-ref') return notFound();
      return { status: 405, body: { message: 'Pull Request is not mergeable' } };
    }
    return { status: 200, body: { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' } };
  }
  if (rest[1] === 'commits' && rest.length === 2 && req.method === 'GET') {
    const headTip = repo.refs.get(`refs/heads/${pr.pull.headRef}`);
    if (!headTip) return { status: 200, body: [] };
    return { status: 200, body: repo.listCommits(headTip, 250).map((sha) => commitJson(repo, sha)).filter(Boolean) };
  }
  return notFound();
}
