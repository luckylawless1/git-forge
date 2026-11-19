// The forge's own store: one account (the login the trial token names), its repositories, and each
// repository's git objects, refs, labels, issues, comments and pull requests. Everything lives in
// memory in this one process; ids are stable for the life of the process and shared by every
// surface (git, REST, GraphQL, MCP), so an object created on one surface reads back identically on
// the others.

import { ObjectStore, ZERO_OID, parseCommit } from './git.ts';

/** The login the trial's bearer token names (the suite's seeded viewer in wire.ts). */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

let clockSeq = 0;
/** A timestamp for API objects: real time, nudged forward so creations never share a millisecond. */
export function nowDate(): Date {
  clockSeq += 1;
  return new Date(Date.now() + clockSeq);
}

export function isoOf(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** GitHub-style global node id: opaque base64 of "<Kind>:<key>", stable across reads. */
export function nodeId(kind: string, key: string | number): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function decodeNodeId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const at = text.indexOf(':');
    if (at <= 0) return null;
    return { kind: text.slice(0, at), key: text.slice(at + 1) };
  } catch {
    return null;
  }
}

export interface LabelRec {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  id: number;
  body: string;
  userLogin: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssueRec {
  /** Global numeric id (REST `id`, GraphQL `databaseId`). */
  id: number;
  /** Per-repository number, shared by issues and pull requests as on GitHub. */
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  userLogin: string;
  comments: CommentRec[];
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
  /** Pull-request fields; null for a plain issue. */
  pull: {
    headRef: string;
    baseRef: string;
    merged: boolean;
    mergedAt: Date | null;
    mergeCommitSha: string | null;
  } | null;
}

export class Repo {
  readonly objects = new ObjectStore();
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, LabelRec>();
  readonly issues = new Map<number, IssueRec>();
  nextNumber = 1;
  headRef: string;
  readonly id: number;
  readonly owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  readonly createdAt: Date;
  updatedAt: Date;

  constructor(
    id: number,
    owner: string,
    name: string,
    description: string,
    isPrivate: boolean,
    defaultBranch: string,
    createdAt: Date,
    updatedAt: Date,
  ) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.defaultBranch = defaultBranch;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
    this.headRef = `refs/heads/${defaultBranch}`;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  refTip(ref: string): string | null {
    return this.refs.get(ref) ?? null;
  }

  /** The default branch's tip commit oid, or null while the branch is unborn. */
  defaultTip(): string | null {
    return this.refs.get(this.headRef) ?? null;
  }

  /** Commit oids on a ref, newest first (DFS pre-order from the tip, deduplicated). */
  listCommits(refOrSha: string, limit = 100): string[] {
    const start = this.refs.get(refOrSha) ?? (this.objects.has(refOrSha) ? refOrSha : null);
    if (!start) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length && out.length < limit) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      seen.add(oid);
      out.push(oid);
      const parents = parseCommit(object.data).parents;
      for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]);
    }
    return out;
  }
}

export class Forge {
  readonly repos = new Map<string, Repo>();
  readonly reposById = new Map<number, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextCommentId = 1;
  private nextLabelId = 1;

  createRepo(name: string, description: string, isPrivate: boolean, defaultBranch = 'main'): Repo {
    const repo = new Repo(this.nextRepoId++, VIEWER_LOGIN, name, description, isPrivate, defaultBranch, nowDate(), nowDate());
    this.repos.set(repo.fullName, repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | null {
    if (owner !== VIEWER_LOGIN) return null;
    return this.repos.get(`${owner}/${name}`) ?? null;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(repo.fullName);
    this.reposById.delete(repo.id);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  newIssueId(): number {
    return this.nextIssueId++;
  }

  newCommentId(): number {
    return this.nextCommentId++;
  }

  newLabelId(): number {
    return this.nextLabelId++;
  }
}

/** The one forge instance every surface shares. */
export const forge = new Forge();
