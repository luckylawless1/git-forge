// Operations every surface shares — creating issues and pull requests, commenting, and merging —
// so an object made over REST is the same object GraphQL and MCP see, with the same ids.

import {
  buildCommit,
  buildTreeFromFiles,
  flattenTree,
  formatIdent,
  parseCommit,
} from './git.ts';
import { planMerge } from './diff.ts';
import {
  VIEWER_EMAIL,
  VIEWER_LOGIN,
  VIEWER_NAME,
  nowDate,
  type Forge,
  type IssueRec,
  type Repo,
} from './store.ts';

/** The viewer's ident line for REST/GraphQL/MCP-created commits, at the current time. */
export function viewerIdentLine(): string {
  return formatIdent(VIEWER_NAME, VIEWER_EMAIL, Math.floor(Date.now() / 1000));
}

/** Commit a whole file map onto a branch ref and return the new commit oid. */
export function commitFiles(repo: Repo, ref: string, files: Map<string, string>, message: string): string {
  const tree = buildTreeFromFiles(repo.objects, files);
  const tip = repo.refs.get(ref);
  const ident = viewerIdentLine();
  const data = buildCommit({ tree, parents: tip ? [tip] : [], author: ident, committer: ident, message });
  const sha = repo.objects.put('commit', data);
  repo.refs.set(ref, sha);
  repo.updatedAt = nowDate();
  return sha;
}

/** The branch tip's flattened files (empty map for an unborn branch). */
export function branchFiles(repo: Repo, ref: string): Map<string, string> {
  const tip = repo.refs.get(ref);
  if (!tip) return new Map();
  const object = repo.objects.get(tip);
  if (!object || object.type !== 'commit') return new Map();
  return flattenTree(repo.objects, parseCommit(object.data).tree);
}

export function createIssueRecord(
  forge: Forge,
  repo: Repo,
  input: { title: string; body?: string | null; labels?: string[] },
): IssueRec {
  const now = nowDate();
  const rec: IssueRec = {
    id: forge.newIssueId(),
    number: repo.nextNumber++,
    title: input.title,
    body: input.body ?? null,
    state: 'open',
    labels: [...(input.labels ?? [])],
    userLogin: VIEWER_LOGIN,
    comments: [],
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    pull: null,
  };
  repo.issues.set(rec.number, rec);
  return rec;
}

export function createPullRecord(
  forge: Forge,
  repo: Repo,
  input: { title: string; body?: string | null; head: string; base: string },
): IssueRec {
  const rec = createIssueRecord(forge, repo, input);
  rec.pull = { headRef: input.head, baseRef: input.base, merged: false, mergedAt: null, mergeCommitSha: null };
  return rec;
}

export function addCommentRecord(forge: Forge, issue: IssueRec, body: string): IssueRec['comments'][number] {
  const now = nowDate();
  const comment = { id: forge.newCommentId(), body, userLogin: VIEWER_LOGIN, createdAt: now, updatedAt: now };
  issue.comments.push(comment);
  issue.updatedAt = now;
  return comment;
}

export type MergeOutcome =
  | { ok: true; sha: string }
  | { ok: false; reason: 'conflict' | 'already-merged' | 'missing-ref' };

/** Squash-merge a pull request onto its base branch: one commit, the head's changes, base parent. */
export function mergePull(repo: Repo, pr: IssueRec): MergeOutcome {
  if (!pr.pull) return { ok: false, reason: 'missing-ref' };
  if (pr.pull.merged) return { ok: false, reason: 'already-merged' };
  const plan = planMerge(repo, pr.pull.headRef, pr.pull.baseRef);
  if (!plan.headTip || !plan.baseTip) return { ok: false, reason: 'missing-ref' };
  if (!plan.mergeable || !plan.treeFiles) return { ok: false, reason: 'conflict' };
  const tree = buildTreeFromFiles(repo.objects, plan.treeFiles);
  const ident = viewerIdentLine();
  const data = buildCommit({
    tree,
    parents: [plan.baseTip],
    author: ident,
    committer: ident,
    message: `${pr.title} (#${pr.number})`,
  });
  const sha = repo.objects.put('commit', data);
  repo.refs.set(`refs/heads/${pr.pull.baseRef}`, sha);
  repo.updatedAt = nowDate();
  const now = nowDate();
  pr.pull.merged = true;
  pr.pull.mergedAt = now;
  pr.pull.mergeCommitSha = sha;
  pr.state = 'closed';
  pr.closedAt = now;
  pr.updatedAt = now;
  return { ok: true, sha };
}
