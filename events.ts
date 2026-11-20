// The recording side of the Events API: every mutation that GitHub reports in its activity
// feeds — pushes, ref creations and deletions, issue and pull-request opens, closes and
// labels, comments — appends one entry to the forge's log here, whichever surface made it
// (git, REST, GraphQL or MCP all funnel through ops.ts and gitserver.ts). The serializers in
// serialize.ts expand the stored references into GitHub's event shapes at read time.

import { ZERO_OID, parseCommit } from './git.ts';
import type { Forge, IssueRec, Repo } from './store.ts';

/** GitHub's ref_type for a full ref name. */
export function refTypeOf(ref: string): 'branch' | 'tag' {
  return ref.startsWith('refs/tags/') ? 'tag' : 'branch';
}

/** The short name of a ref (what CreateEvent/DeleteEvent payloads carry). */
export function shortRefOf(ref: string): string {
  return ref.replace(/^refs\/(heads|tags)\//, '');
}

/** How many commits a PushEvent lists, as GitHub caps its feed payloads. */
const PUSH_EVENT_COMMIT_CAP = 20;

/**
 * Record what one ref update means for the feed: a CreateEvent when the ref appears, a
 * DeleteEvent when it goes away, and a PushEvent otherwise, carrying the commits the update
 * brought (first-parent walk from the new tip back to the old one, capped). A no-op update
 * records nothing.
 */
export function recordRefUpdate(forge: Forge, repo: Repo, ref: string, before: string, after: string): void {
  if (before === after) return;
  if (before === ZERO_OID) {
    forge.recordEvent('CreateEvent', repo, {
      ref: shortRefOf(ref),
      ref_type: refTypeOf(ref),
      master_branch: repo.defaultBranch,
      description: null,
      pusher_type: 'user',
    });
    return;
  }
  if (after === ZERO_OID) {
    forge.recordEvent('DeleteEvent', repo, {
      ref: shortRefOf(ref),
      ref_type: refTypeOf(ref),
      pusher_type: 'user',
    });
    return;
  }
  const commits: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  let cursor: string | null = after;
  while (cursor !== null && cursor !== before && !seen.has(cursor)) {
    seen.add(cursor);
    const object = repo.objects.get(cursor);
    if (!object || object.type !== 'commit') break;
    const info = parseCommit(object.data);
    if (commits.length < PUSH_EVENT_COMMIT_CAP) {
      commits.push({
        sha: cursor,
        message: info.message,
        authorName: info.authorName,
        authorEmail: info.authorEmail,
        distinct: true,
      });
    }
    cursor = info.parents[0] ?? null;
  }
  forge.recordEvent('PushEvent', repo, {
    ref,
    before,
    after,
    head: after,
    size: seen.size,
    distinct_size: commits.length,
    commits,
  });
}

/** Record an issue or pull-request lifecycle action (opened, closed, reopened, labeled, …). */
export function recordIssueEvent(forge: Forge, repo: Repo, action: string, issue: IssueRec, label?: string): void {
  forge.recordEvent(issue.pull ? 'PullRequestEvent' : 'IssuesEvent', repo, {
    action,
    issueNumber: issue.number,
    ...(label !== undefined ? { label } : {}),
  });
}

/** Record a new comment on an issue or pull request. */
export function recordCommentEvent(forge: Forge, repo: Repo, issue: IssueRec, commentId: number): void {
  forge.recordEvent('IssueCommentEvent', repo, {
    action: 'created',
    issueNumber: issue.number,
    commentId,
  });
}
