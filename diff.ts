// Tree diffs and pull-request merge math, shared by the REST and GraphQL surfaces: file change
// lists with line counts, three-way conflict detection from the merge base, and the tree a squash
// merge produces.

import {
  buildTreeFromFiles,
  flattenTree,
  isAncestor,
  mergeBase,
  parseCommit,
  peelToCommit,
  type ObjectStore,
} from './git.ts';
import type { Repo } from './store.ts';

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  /** Blob oid on the head side (null when removed). */
  sha: string | null;
  additions: number;
  deletions: number;
  changes: number;
}

/** Line-level diff counts via a longest-common-subsequence over lines (files here are small). */
export function lineCounts(oldText: string | null, newText: string | null): { additions: number; deletions: number } {
  const oldLines = oldText === null ? [] : oldText.split('\n');
  const newLines = newText === null ? [] : newText.split('\n');
  // A trailing newline produces a final empty element that is not a line of content change.
  if (oldLines.length && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length && newLines[newLines.length - 1] === '') newLines.pop();
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[] = new Array((m + 1) * (n + 1)).fill(0);
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i * (n + 1) + j] = oldLines[i] === newLines[j] ? dp[(i + 1) * (n + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (n + 1) + j], dp[i * (n + 1) + j + 1]);
    }
  }
  const common = dp[0];
  return { additions: n - common, deletions: m - common };
}

function blobText(store: ObjectStore, oid: string | undefined): string | null {
  if (!oid) return null;
  const object = store.get(oid);
  if (!object || object.type !== 'blob') return null;
  return object.data.toString('utf8');
}

/** The file changes between two trees (either may be null for an empty tree). */
export function diffTrees(store: ObjectStore, fromTree: string | null, toTree: string | null): FileChange[] {
  const from = fromTree ? flattenTree(store, fromTree) : new Map<string, string>();
  const to = toTree ? flattenTree(store, toTree) : new Map<string, string>();
  const paths = [...new Set([...from.keys(), ...to.keys()])].sort();
  const out: FileChange[] = [];
  for (const path of paths) {
    const before = from.get(path);
    const after = to.get(path);
    if (before === after) continue;
    const counts = lineCounts(blobText(store, before), blobText(store, after));
    out.push({
      path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      sha: after ?? null,
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
    });
  }
  return out;
}

export interface MergePlan {
  baseTip: string | null;
  headTip: string | null;
  base: string | null;
  /** True when the head's changes apply cleanly onto the base tip. */
  mergeable: boolean;
  /** The tree the squash commit would carry, when mergeable. */
  treeFiles: Map<string, string> | null;
}

/**
 * Three-way view of a pull request: changes the head made since the merge base, applied onto the
 * current base tip. A path both sides changed differently (or one deleted and the other modified)
 * conflicts.
 */
export function planMerge(repo: Repo, headRef: string, baseRef: string): MergePlan {
  const store = repo.objects;
  const headRaw = repo.refs.get(`refs/heads/${headRef}`);
  const baseRaw = repo.refs.get(`refs/heads/${baseRef}`);
  const headTip = headRaw ? peelToCommit(store, headRaw) : null;
  const baseTip = baseRaw ? peelToCommit(store, baseRaw) : null;
  if (!headTip || !store.get(headTip)) return { baseTip, headTip, base: null, mergeable: false, treeFiles: null };
  const base = baseTip ? mergeBase(store, baseTip, headTip) : null;
  const baseFiles = baseTip ? flattenTree(store, parseCommit((store.get(baseTip) as { data: Buffer }).data).tree) : new Map<string, string>();
  const mbFiles = base ? flattenTree(store, parseCommit((store.get(base) as { data: Buffer }).data).tree) : new Map<string, string>();
  const headFiles = flattenTree(store, parseCommit((store.get(headTip) as { data: Buffer }).data).tree);
  const merged = new Map(baseFiles);
  let conflict = false;
  const paths = new Set([...mbFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const mb = mbFiles.get(path);
    const head = headFiles.get(path);
    if (mb === head) continue; // the head did not change this path
    const onBase = baseFiles.get(path);
    if (onBase !== mb && onBase !== head) {
      conflict = true; // both sides changed it differently (incl. delete vs modify)
      break;
    }
    if (head === undefined) merged.delete(path);
    else merged.set(path, head);
  }
  return { baseTip, headTip, base, mergeable: !conflict, treeFiles: conflict ? null : merged };
}

/** Build (and store) the tree a squash merge of the planned files produces. */
export function buildMergedTree(repo: Repo, files: Map<string, string>): string {
  return buildTreeFromFiles(repo.objects, files);
}

export { isAncestor };
