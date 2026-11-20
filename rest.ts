// REST API v3: repositories, contents, branches, refs, commits, labels, issues, comments and pull
// requests, in GitHub's shapes and status codes. A repository under any owner but the token's
// login does not exist here (404, never 403).

import {
  ZERO_OID,
  buildTreeFromFiles,
  flattenTree,
  formatIdent,
  mergeBase,
  parseCommit,
  parseTree,
  peelToCommit,
} from './git.ts';
import { diffTrees, planMerge } from './diff.ts';
import { recordIssueEvent, recordRefUpdate } from './events.ts';
import { addCommentRecord, branchFiles, commitFiles, createIssueRecord, createPullRecord, mergePull, viewerIdentLine } from './ops.ts';
import {
  commentJson,
  commitJson,
  eventJson,
  gitCommitJson,
  issueEventJson,
  issueJson,
  labelJson,
  releaseJson,
  repoJson,
  tagRefJson,
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
  /** A pre-serialised JSON body, sent verbatim (the single-issue GET memo). */
  raw?: Buffer;
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
  if (parts[0] === 'users' && parts.length === 3 && parts[2] === 'events' && req.method === 'GET') {
    if (parts[1] !== VIEWER_LOGIN) return notFound();
    const mine = [...forge.events].reverse();
    const { page, headers } = paginate(req, mine, `/api/v3/users/${VIEWER_LOGIN}/events`);
    return {
      status: 200,
      body: page.map((event) => eventJson(forge.repos.get(event.repoFullName) ?? null, event)),
      headers,
    };
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
      forge.recordEvent('CreateEvent', repo, {
        ref: null,
        ref_type: 'repository',
        master_branch: repo.defaultBranch,
        description: repo.description,
        pusher_type: 'user',
      });
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
    case 'compare':
      return compareRoutes(req, repo, rest.slice(1).join('/'));
    case 'contents':
      return contentRoutes(req, repo, rest.slice(1).join('/'));
    case 'events':
      return repoEventRoutes(req, repo, rest.slice(1));
    case 'git':
      return gitRoutes(req, repo, rest.slice(1));
    case 'labels':
      return labelRoutes(req, repo, rest.slice(1));
    case 'issues':
      return issueRoutes(req, repo, rest.slice(1));
    case 'pulls':
      return pullRoutes(req, repo, rest.slice(1));
    case 'releases':
      return releaseRoutes(req, repo, rest.slice(1));
    case 'tags':
      if (rest.length === 1 && req.method === 'GET') {
        const tags = [...repo.refs.entries()]
          .filter(([ref]) => ref.startsWith('refs/tags/'))
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([ref, sha]) => tagRefJson(repo, ref.slice('refs/tags/'.length), peelToCommit(repo.objects, sha) ?? sha));
        return { status: 200, body: tags };
      }
      return notFound();
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
    const commitSha = commitFiles(forge, repo, ref, files, message);
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
    const commitSha = commitFiles(forge, repo, ref, files, message);
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
  switch (rest[0]) {
    case 'refs':
      return gitRefRoutes(req, repo, rest.slice(1));
    case 'trees':
      return gitTreeRoutes(req, repo, rest[1]);
    case 'blobs':
      return gitBlobRoutes(req, repo, rest[1]);
    case 'commits':
      return gitCommitRoutes(req, repo, rest[1]);
    case 'tags':
      return gitTagRoutes(req, repo, rest[1]);
    default:
      return notFound();
  }
}

function refJson(req: RestRequest, repo: Repo, ref: string, sha: string): Json {
  const object = repo.objects.get(sha);
  return {
    ref,
    node_id: `REF:${ref}`,
    url: `${req.base}/api/v3/repos/${repo.fullName}/git/refs/${ref.slice('refs/'.length)}`,
    object: {
      type: object?.type ?? 'commit',
      sha,
      url: `${req.base}/api/v3/repos/${repo.fullName}/git/${object?.type === 'tree' ? 'trees' : object?.type === 'tag' ? 'tags' : 'commits'}/${sha}`,
    },
  } as unknown as Json;
}

function gitRefRoutes(req: RestRequest, repo: Repo, rest: string[]): RestResult {
  if (req.method === 'POST' && rest.length === 0) {
    const ref = bodyString(req.body, 'ref');
    const sha = bodyString(req.body, 'sha');
    if (!ref || !sha || !ref.startsWith('refs/')) return unprocessable('Validation Failed');
    const object = repo.objects.get(sha);
    if (!object) return unprocessable('Object does not exist', [{ resource: 'Reference', code: 'custom', field: 'sha', message: 'Object does not exist' }]);
    if (repo.refs.has(ref)) return unprocessable('Reference already exists');
    repo.refs.set(ref, sha);
    recordRefUpdate(forge, repo, ref, ZERO_OID, sha);
    return { status: 201, body: refJson(req, repo, ref, sha) };
  }
  const name = rest.join('/');
  const full = name.startsWith('refs/') ? name : `refs/${name}`;
  if (req.method === 'GET') {
    if (name) {
      const sha = repo.refs.get(full);
      if (!sha) return notFound();
      return { status: 200, body: refJson(req, repo, full, sha) };
    }
    const all = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([ref, sha]) => refJson(req, repo, ref, sha));
    return { status: 200, body: all };
  }
  if (req.method === 'PATCH' && name) {
    const current = repo.refs.get(full);
    if (!current) return notFound();
    const sha = bodyString(req.body, 'sha');
    if (!sha || !repo.objects.has(sha)) {
      return unprocessable('Object does not exist', [{ resource: 'Reference', code: 'custom', field: 'sha', message: 'Object does not exist' }]);
    }
    repo.refs.set(full, sha);
    recordRefUpdate(forge, repo, full, current, sha);
    return { status: 200, body: refJson(req, repo, full, sha) };
  }
  if (req.method === 'DELETE' && name) {
    const current = repo.refs.get(full);
    if (!current) return notFound();
    repo.refs.delete(full);
    recordRefUpdate(forge, repo, full, current, ZERO_OID);
    return { status: 204 };
  }
  return notFound();
}

function gitTreeRoutes(req: RestRequest, repo: Repo, sha: string | undefined): RestResult {
  if (req.method === 'POST' && sha === undefined) {
    // Create a tree from path entries, optionally overlaid on a base tree. An entry with
    // `content` stores a new blob; `sha: null` deletes the path. The forge's file model is
    // the flat path -> blob map every other surface uses, so entries name full paths.
    const baseTree = bodyString(req.body, 'base_tree');
    let files = new Map<string, string>();
    if (baseTree) {
      const baseObject = repo.objects.get(baseTree);
      if (!baseObject || baseObject.type !== 'tree') return unprocessable('Validation Failed', [{ resource: 'Tree', code: 'invalid', field: 'base_tree' }]);
      files = flattenTree(repo.objects, baseTree);
    }
    const entries = Array.isArray(req.body?.tree) ? (req.body.tree as Array<Record<string, unknown>>) : null;
    if (!entries) return unprocessable('Validation Failed', [{ resource: 'Tree', code: 'missing_field', field: 'tree' }]);
    for (const entry of entries) {
      const path = typeof entry.path === 'string' ? entry.path : null;
      if (!path || entry.type !== 'blob') continue;
      if (entry.sha === null) {
        files.delete(path);
        continue;
      }
      if (typeof entry.content === 'string') {
        files.set(path, repo.objects.put('blob', Buffer.from(entry.content, 'utf8')));
      } else if (typeof entry.sha === 'string') {
        const target = repo.objects.get(entry.sha);
        if (!target || target.type !== 'blob') return unprocessable('Validation Failed', [{ resource: 'Tree', code: 'invalid', field: 'sha', value: entry.sha }]);
        files.set(path, entry.sha);
      }
    }
    const tree = buildTreeFromFiles(repo.objects, files);
    return { status: 201, body: { sha: tree, url: `${req.base}/api/v3/repos/${repo.fullName}/git/trees/${tree}` } };
  }
  if (req.method !== 'GET' || !sha) return notFound();
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'tree') return notFound();
  const recursive = req.query.get('recursive') === '1' || req.query.get('recursive') === 'true';
  const entries: Json[] = [];
  const walk = (treeOid: string, prefix: string): void => {
    const treeObject = repo.objects.get(treeOid);
    if (!treeObject || treeObject.type !== 'tree') return;
    for (const entry of parseTree(treeObject.data)) {
      const isTree = entry.mode === '40000';
      const item: Json = {
        path: prefix + entry.name,
        mode: entry.mode,
        type: isTree ? 'tree' : 'blob',
        sha: entry.oid,
        url: `${req.base}/api/v3/repos/${repo.fullName}/git/${isTree ? 'trees' : 'blobs'}/${entry.oid}`,
      };
      if (!isTree) item.size = repo.objects.get(entry.oid)?.data.length ?? 0;
      entries.push(item);
      if (isTree && recursive) walk(entry.oid, `${prefix}${entry.name}/`);
    }
  };
  walk(sha, '');
  return {
    status: 200,
    body: { sha, url: `${req.base}/api/v3/repos/${repo.fullName}/git/trees/${sha}`, tree: entries, truncated: false },
  };
}

function gitBlobRoutes(req: RestRequest, repo: Repo, sha: string | undefined): RestResult {
  if (req.method === 'POST' && sha === undefined) {
    const content = bodyString(req.body, 'content');
    if (content === undefined) return unprocessable('Validation Failed', [{ resource: 'Blob', code: 'missing_field', field: 'content' }]);
    const encoding = bodyString(req.body, 'encoding') ?? 'utf-8';
    const data = encoding === 'base64' ? Buffer.from(content.replace(/\s+/g, ''), 'base64') : Buffer.from(content, 'utf8');
    const created = repo.objects.put('blob', data);
    return { status: 201, body: { sha: created, url: `${req.base}/api/v3/repos/${repo.fullName}/git/blobs/${created}` } };
  }
  if (req.method !== 'GET' || !sha) return notFound();
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'blob') return notFound();
  return {
    status: 200,
    body: {
      content: object.data.toString('base64'),
      encoding: 'base64',
      size: object.data.length,
      sha,
      url: `${req.base}/api/v3/repos/${repo.fullName}/git/blobs/${sha}`,
      node_id: `BLOB:${sha}`,
    },
  };
}

/** An ident object ({name, email, date}) from a request body, as a git ident line. */
function identLineFrom(body: Record<string, unknown> | undefined, key: string): string {
  const raw = body?.[key] as { name?: unknown; email?: unknown; date?: unknown } | undefined;
  if (!raw || typeof raw.name !== 'string' || typeof raw.email !== 'string') return viewerIdentLine();
  const epoch = typeof raw.date === 'string' ? Math.floor(Date.parse(raw.date) / 1000) : NaN;
  return formatIdent(raw.name, raw.email, Number.isFinite(epoch) ? epoch : Math.floor(Date.now() / 1000));
}

function gitCommitRoutes(req: RestRequest, repo: Repo, sha: string | undefined): RestResult {
  if (req.method === 'POST' && sha === undefined) {
    const message = bodyString(req.body, 'message');
    const tree = bodyString(req.body, 'tree');
    if (message === undefined || !tree) return unprocessable('Validation Failed');
    const treeObject = repo.objects.get(tree);
    if (!treeObject || treeObject.type !== 'tree') {
      return unprocessable('Validation Failed', [{ resource: 'GitCommit', code: 'invalid', field: 'tree', message: 'tree does not exist' }]);
    }
    const parentsRaw = Array.isArray(req.body?.parents) ? (req.body.parents as unknown[]) : [];
    const parents: string[] = [];
    for (const parent of parentsRaw) {
      if (typeof parent !== 'string' || !repo.objects.has(parent)) {
        return unprocessable('Validation Failed', [{ resource: 'GitCommit', code: 'invalid', field: 'parents', message: 'a parent does not exist' }]);
      }
      parents.push(parent);
    }
    const data = Buffer.from(
      `${[`tree ${tree}`, ...parents.map((parent) => `parent ${parent}`), `author ${identLineFrom(req.body, 'author')}`, `committer ${identLineFrom(req.body, 'committer')}`].join('\n')}\n\n${message}`,
      'utf8',
    );
    const created = repo.objects.put('commit', data);
    return { status: 201, body: gitCommitJson(repo, created) };
  }
  if (req.method !== 'GET' || !sha) return notFound();
  const commit = gitCommitJson(repo, sha);
  return commit ? { status: 200, body: commit } : notFound();
}

function gitTagRoutes(req: RestRequest, repo: Repo, sha: string | undefined): RestResult {
  const api = `${req.base}/api/v3/repos/${repo.fullName}`;
  if (req.method === 'POST' && sha === undefined) {
    const tag = bodyString(req.body, 'tag');
    const message = bodyString(req.body, 'message');
    const objectSha = bodyString(req.body, 'object');
    const type = bodyString(req.body, 'type') ?? 'commit';
    if (!tag || message === undefined || !objectSha) return unprocessable('Validation Failed');
    const target = repo.objects.get(objectSha);
    if (!target) return unprocessable('Object does not exist', [{ resource: 'Tag', code: 'custom', field: 'object', message: 'Object does not exist' }]);
    const tagger = identLineFrom(req.body, 'tagger');
    const data = Buffer.from(`object ${objectSha}\ntype ${type}\ntag ${tag}\ntagger ${tagger}\n\n${message}`, 'utf8');
    const created = repo.objects.put('tag', data);
    const ref = `refs/tags/${tag}`;
    const before = repo.refs.get(ref) ?? ZERO_OID;
    repo.refs.set(ref, created);
    recordRefUpdate(forge, repo, ref, before, created);
    return {
      status: 201,
      body: {
        node_id: `TAG:${created}`,
        tag,
        sha: created,
        url: `${api}/git/tags/${created}`,
        message,
        tagger: { name: tagger.replace(/ <.*$/, ''), email: /<([^>]*)>/.exec(tagger)?.[1] ?? '', date: '' },
        object: { sha: objectSha, type: target.type, url: `${api}/git/${target.type === 'commit' ? 'commits' : 'trees'}/${objectSha}` },
      },
    };
  }
  if (req.method !== 'GET' || !sha) return notFound();
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'tag') return notFound();
  const text = object.data.toString('utf8');
  const field = (name: string): string => new RegExp(`^${name} (.*)$`, 'm').exec(text)?.[1] ?? '';
  const taggerLine = field('tagger');
  const taggerMatch = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(taggerLine);
  const targetSha = field('object');
  const targetType = field('type') || 'commit';
  return {
    status: 200,
    body: {
      node_id: `TAG:${sha}`,
      tag: field('tag'),
      sha,
      url: `${api}/git/tags/${sha}`,
      message: text.includes('\n\n') ? text.slice(text.indexOf('\n\n') + 2) : '',
      tagger: taggerMatch
        ? { name: taggerMatch[1], email: taggerMatch[2], date: new Date(Number(taggerMatch[3]) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') }
        : { name: '', email: '', date: '' },
      object: { sha: targetSha, type: targetType, url: `${api}/git/${targetType === 'commit' ? 'commits' : targetType === 'tree' ? 'trees' : 'tags'}/${targetSha}` },
    },
  };
}

/** GET /repos/{owner}/{repo}/events — the repository's activity feed, newest first. */
function repoEventRoutes(req: RestRequest, repo: Repo, rest: string[]): RestResult {
  if (rest.length !== 0 || req.method !== 'GET') return notFound();
  const mine = forge.events.filter((event) => event.repoFullName === repo.fullName).reverse();
  const { page, headers } = paginate(req, mine, `/api/v3/repos/${repo.fullName}/events`);
  return { status: 200, body: page.map((event) => eventJson(repo, event)), headers };
}

/** GET /repos/{owner}/{repo}/compare/{base}...{head} — divergence and the diff between two commits. */
function compareRoutes(req: RestRequest, repo: Repo, spec: string): RestResult {
  if (req.method !== 'GET') return notFound();
  const splitAt = spec.includes('...') ? spec.indexOf('...') : spec.indexOf('..');
  if (splitAt < 0) return notFound();
  const dots = spec.startsWith('...', splitAt) ? 3 : 2;
  const baseName = decodeURIComponent(spec.slice(0, splitAt));
  const headName = decodeURIComponent(spec.slice(splitAt + dots));
  const baseRaw = resolveCommit(repo, baseName);
  const headRaw = resolveCommit(repo, headName);
  if (!baseRaw || !headRaw) return notFound();
  const base = peelToCommit(repo.objects, baseRaw) ?? baseRaw;
  const head = peelToCommit(repo.objects, headRaw) ?? headRaw;
  const baseCommits = repo.listCommits(base, 10_000);
  const headCommits = repo.listCommits(head, 10_000);
  const baseSet = new Set(baseCommits);
  const headSet = new Set(headCommits);
  const ahead = headCommits.filter((sha) => !baseSet.has(sha));
  const behind = baseCommits.filter((sha) => !headSet.has(sha));
  const status = base === head ? 'identical' : ahead.length > 0 && behind.length > 0 ? 'diverged' : ahead.length > 0 ? 'ahead' : 'behind';
  const baseForDiff = mergeBase(repo.objects, base, head) ?? base;
  const files = diffTrees(repo.objects, treeOf(repo, baseForDiff), treeOf(repo, head));
  const api = `${req.base}/api/v3/repos/${repo.fullName}`;
  return {
    status: 200,
    body: {
      url: `${api}/compare/${baseName}...${headName}`,
      html_url: `${req.base}/${repo.fullName}/compare/${baseName}...${headName}`,
      permalink_url: `${api}/compare/${base.slice(0, 7)}...${head.slice(0, 7)}`,
      diff_url: `${req.base}/${repo.fullName}/compare/${baseName}...${headName}.diff`,
      patch_url: `${req.base}/${repo.fullName}/compare/${baseName}...${headName}.patch`,
      base_commit: commitJson(repo, base),
      merge_base_commit: commitJson(repo, baseForDiff),
      status,
      ahead_by: ahead.length,
      behind_by: behind.length,
      total_commits: ahead.length,
      commits: ahead.slice(0, 250).map((sha) => commitJson(repo, sha)).filter(Boolean),
      files: files.map((file) => ({
        sha: file.sha,
        filename: file.path,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        blob_url: file.sha ? `${api}/git/blobs/${file.sha}` : null,
        raw_url: file.sha ? `${req.base}/${repo.fullName}/raw/${headName}/${file.path}` : null,
        contents_url: `${api}/contents/${file.path}?ref=${headName}`,
      })),
    },
  };
}

function releaseRoutes(req: RestRequest, repo: Repo, rest: string[]): RestResult {
  if (rest[0] === 'tags' && rest.length === 2) {
    if (req.method !== 'GET') return notFound();
    const tag = decodeURIComponent(rest[1]);
    const release = [...repo.releases.values()].find((item) => item.tagName === tag);
    return release ? { status: 200, body: releaseJson(repo, release) } : notFound();
  }
  if (rest.length === 0) {
    if (req.method === 'GET') {
      const all = [...repo.releases.values()].sort((a, b) => b.id - a.id);
      const { page, headers } = paginate(req, all, `/api/v3/repos/${repo.fullName}/releases`);
      return { status: 200, body: page.map((release) => releaseJson(repo, release)), headers };
    }
    if (req.method === 'POST') {
      const tagName = bodyString(req.body, 'tag_name');
      if (!tagName) {
        return unprocessable('Validation Failed', [{ resource: 'Release', code: 'missing_field', field: 'tag_name' }]);
      }
      if ([...repo.releases.values()].some((item) => item.tagName === tagName)) {
        return unprocessable('Validation Failed', [{ resource: 'Release', code: 'already_exists', field: 'tag_name' }]);
      }
      const targetCommitish = bodyString(req.body, 'target_commitish') ?? repo.defaultBranch;
      const ref = `refs/tags/${tagName}`;
      if (!repo.refs.has(ref)) {
        // GitHub creates the tag at the target when the release names a new one.
        const target = resolveCommit(repo, targetCommitish);
        const commit = target ? peelToCommit(repo.objects, target) : null;
        if (!commit) return unprocessable('Validation Failed', [{ resource: 'Release', code: 'invalid', field: 'target_commitish' }]);
        repo.refs.set(ref, commit);
        recordRefUpdate(forge, repo, ref, ZERO_OID, commit);
      }
      const draft = req.body?.draft === true;
      const now = nowDate();
      const release = {
        id: forge.newReleaseId(),
        tagName,
        targetCommitish,
        name: bodyString(req.body, 'name') ?? null,
        body: bodyString(req.body, 'body') ?? null,
        draft,
        prerelease: req.body?.prerelease === true,
        createdAt: now,
        publishedAt: draft ? null : now,
      };
      repo.releases.set(release.id, release);
      return { status: 201, body: releaseJson(repo, release) };
    }
    return notFound();
  }
  if (rest.length === 1) {
    const release = repo.releases.get(Number(rest[0]));
    if (!release) return notFound();
    if (req.method === 'GET') return { status: 200, body: releaseJson(repo, release) };
    if (req.method === 'PATCH') {
      const tagName = bodyString(req.body, 'tag_name');
      if (tagName !== undefined) release.tagName = tagName;
      const target = bodyString(req.body, 'target_commitish');
      if (target !== undefined) release.targetCommitish = target;
      if (req.body && 'name' in req.body) release.name = bodyString(req.body, 'name') ?? null;
      if (req.body && 'body' in req.body) release.body = bodyString(req.body, 'body') ?? null;
      if (typeof req.body?.draft === 'boolean') {
        release.draft = req.body.draft;
        if (!release.draft && release.publishedAt === null) release.publishedAt = nowDate();
      }
      if (typeof req.body?.prerelease === 'boolean') release.prerelease = req.body.prerelease;
      return { status: 200, body: releaseJson(repo, release) };
    }
    if (req.method === 'DELETE') {
      repo.releases.delete(release.id);
      return { status: 204 };
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
    if (req.method === 'GET') {
      // The read workload hammers this one route; the body is a pure function of the fields
      // fingerprinted here (plus the base and the repo's identity), so serve the memo.
      const key = [
        req.base,
        repo.fullName,
        issue.updatedAt.getTime(),
        issue.closedAt?.getTime() ?? 0,
        issue.state,
        issue.title,
        issue.body ?? '',
        issue.labels.join('\u0001'),
        issue.comments.length,
        issue.pull?.merged ? 1 : 0,
        issue.pull?.mergedAt?.getTime() ?? 0,
      ].join('|');
      if (issue.getMemo?.key === key) return { status: 200, raw: issue.getMemo.body };
      const raw = Buffer.from(`${JSON.stringify(issueJson(repo, issue))}\n`, 'utf8');
      issue.getMemo = { key, body: raw };
      return { status: 200, raw };
    }
    if (req.method === 'PATCH') {
      const labels = req.body && 'labels' in req.body ? labelNames(req.body) : undefined;
      if (labels) {
        const bad = checkLabels(repo, labels);
        if (bad) return bad;
        for (const name of labels) if (!issue.labels.includes(name)) recordIssueEvent(forge, repo, 'labeled', issue, name);
        for (const name of issue.labels) if (!labels.includes(name)) recordIssueEvent(forge, repo, 'unlabeled', issue, name);
        issue.labels = labels;
      }
      const title = bodyString(req.body, 'title');
      if (title !== undefined) issue.title = title;
      if (req.body && 'body' in req.body) issue.body = bodyString(req.body, 'body') ?? null;
      const state = bodyString(req.body, 'state');
      if (state === 'closed' || state === 'open') {
        const changed = state !== issue.state;
        issue.state = state;
        issue.closedAt = state === 'closed' ? nowDate() : null;
        if (changed) recordIssueEvent(forge, repo, state === 'closed' ? 'closed' : 'reopened', issue);
      }
      issue.updatedAt = nowDate();
      return { status: 200, body: issueJson(repo, issue) };
    }
    return notFound();
  }
  if (rest[1] === 'events' && rest.length === 2 && req.method === 'GET') {
    const mine = forge.events
      .filter((event) => event.repoFullName === repo.fullName && Number(event.payload.issueNumber ?? -1) === number)
      .reverse();
    const { page, headers } = paginate(req, mine, `/api/v3/repos/${repo.fullName}/issues/${number}/events`);
    return {
      status: 200,
      body: page.map((event) => issueEventJson(repo, event)).filter(Boolean),
      headers,
    };
  }
  if (rest[1] === 'comments') {
    if (rest.length === 2 && req.method === 'GET') {
      return { status: 200, body: issue.comments.map((comment) => commentJson(repo, issue, comment)) };
    }
    if (rest.length === 2 && req.method === 'POST') {
      const body = bodyString(req.body, 'body');
      if (body === undefined) return unprocessable('Validation Failed', [{ resource: 'IssueComment', code: 'missing_field', field: 'body' }]);
      const comment = addCommentRecord(forge, repo, issue, body);
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
      for (const name of labels) {
        if (!issue.labels.includes(name)) {
          issue.labels.push(name);
          recordIssueEvent(forge, repo, 'labeled', issue, name);
        }
      }
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
        const changed = state !== pr.state;
        pr.state = state;
        pr.closedAt = state === 'closed' ? nowDate() : null;
        if (changed) recordIssueEvent(forge, repo, state === 'closed' ? 'closed' : 'reopened', pr);
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
    const outcome = mergePull(forge, repo, pr);
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
