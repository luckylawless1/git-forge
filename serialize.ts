// GitHub-shaped JSON for the shared records. Every surface serializes through here so an object
// created over REST, git, GraphQL or MCP carries the same ids and fields everywhere. URL fields
// are absolute, built from the base the app sets once it knows its port.

import { parseCommit } from './git.ts';
import {
  VIEWER_ID,
  VIEWER_LOGIN,
  isoOf,
  nodeId,
  type CommentRec,
  type IssueRec,
  type LabelRec,
  type Repo,
} from './store.ts';

export type Json = Record<string, unknown>;

let base = '';
export function setBase(value: string): void {
  base = value;
}
function u(path: string): string {
  return `${base}${path}`;
}

export function userJson(login: string): Json {
  return {
    login,
    id: login === VIEWER_LOGIN ? VIEWER_ID : 0,
    node_id: nodeId('User', login),
    avatar_url: `https://avatars.githubusercontent.com/u/${login === VIEWER_LOGIN ? VIEWER_ID : 0}?v=4`,
    gravatar_id: '',
    url: u(`/api/v3/users/${login}`),
    html_url: u(`/${login}`),
    type: 'User',
    site_admin: false,
  };
}

export function viewerJson(): Json {
  return { ...userJson(VIEWER_LOGIN), name: 'ada iversen', email: null };
}

export function repoJson(repo: Repo): Json {
  const api = u(`/api/v3/repos/${repo.fullName}`);
  const openIssues = [...repo.issues.values()].filter((issue) => issue.state === 'open').length;
  return {
    id: repo.id,
    node_id: nodeId('Repository', repo.id),
    name: repo.name,
    full_name: repo.fullName,
    private: repo.isPrivate,
    owner: userJson(repo.owner),
    html_url: u(`/${repo.fullName}`),
    description: repo.description,
    fork: false,
    url: api,
    forks_url: `${api}/forks`,
    keys_url: `${api}/keys{/key_id}`,
    collaborators_url: `${api}/collaborators{/collaborator}`,
    teams_url: `${api}/teams`,
    hooks_url: `${api}/hooks`,
    issue_events_url: `${api}/issues/events{/number}`,
    events_url: `${api}/events`,
    assignees_url: `${api}/assignees{/user}`,
    branches_url: `${api}/branches{/branch}`,
    tags_url: `${api}/tags`,
    blobs_url: `${api}/git/blobs{/sha}`,
    git_tags_url: `${api}/git/tags{/sha}`,
    git_refs_url: `${api}/git/refs{/sha}`,
    trees_url: `${api}/git/trees{/sha}`,
    statuses_url: `${api}/statuses/{sha}`,
    languages_url: `${api}/languages`,
    stargazers_url: `${api}/stargazers`,
    contributors_url: `${api}/contributors`,
    subscribers_url: `${api}/subscribers`,
    subscription_url: `${api}/subscription`,
    commits_url: `${api}/commits{/sha}`,
    git_commits_url: `${api}/git/commits{/sha}`,
    comments_url: `${api}/comments{/number}`,
    issue_comment_url: `${api}/issues/comments{/number}`,
    contents_url: `${api}/contents/{+path}`,
    compare_url: `${api}/compare/{base}...{head}`,
    merges_url: `${api}/merges`,
    archive_url: `${api}/archive/{archive_format}{/ref}`,
    downloads_url: `${api}/downloads`,
    issues_url: `${api}/issues{/number}`,
    pulls_url: `${api}/pulls{/number}`,
    milestones_url: `${api}/milestones{/number}`,
    notifications_url: `${api}/notifications{?since,all,participating}`,
    labels_url: `${api}/labels{/name}`,
    releases_url: `${api}/releases{/id}`,
    deployments_url: `${api}/deployments`,
    created_at: isoOf(repo.createdAt),
    updated_at: isoOf(repo.updatedAt),
    pushed_at: isoOf(repo.updatedAt),
    git_url: `git://forge.invalid/${repo.fullName}.git`,
    ssh_url: `git@forge.invalid:${repo.fullName}.git`,
    clone_url: u(`/${repo.fullName}.git`),
    svn_url: u(`/${repo.fullName}`),
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    license: null,
    forks: 0,
    open_issues: openIssues,
    watchers: 0,
    default_branch: repo.defaultBranch,
    visibility: repo.isPrivate ? 'private' : 'public',
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

export function labelJson(repo: Repo, label: LabelRec): Json {
  return {
    id: label.id,
    node_id: nodeId('Label', `${repo.id}:${label.name}`),
    url: u(`/api/v3/repos/${repo.fullName}/labels/${encodeURIComponent(label.name)}`),
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

export function issueJson(repo: Repo, issue: IssueRec): Json {
  const api = u(`/api/v3/repos/${repo.fullName}`);
  const out: Json = {
    id: issue.id,
    node_id: nodeId(issue.pull ? 'PullRequest' : 'Issue', `${repo.id}:${issue.number}`),
    url: `${api}/issues/${issue.number}`,
    repository_url: api,
    labels_url: `${api}/issues/${issue.number}/labels{/name}`,
    comments_url: `${api}/issues/${issue.number}/comments`,
    events_url: `${api}/issues/${issue.number}/events`,
    html_url: u(`/${repo.fullName}/issues/${issue.number}`),
    number: issue.number,
    title: issue.title,
    user: userJson(issue.userLogin),
    labels: issue.labels
      .map((name) => repo.labels.get(name))
      .filter((label): label is LabelRec => Boolean(label))
      .map((label) => labelJson(repo, label)),
    state: issue.state,
    locked: false,
    assignees: [],
    assignee: null,
    milestone: null,
    comments: issue.comments.length,
    created_at: isoOf(issue.createdAt),
    updated_at: isoOf(issue.updatedAt),
    closed_at: issue.closedAt ? isoOf(issue.closedAt) : null,
    author_association: 'OWNER',
    body: issue.body,
  };
  if (issue.pull) {
    out.pull_request = {
      url: `${api}/pulls/${issue.number}`,
      html_url: u(`/${repo.fullName}/pull/${issue.number}`),
      diff_url: u(`/${repo.fullName}/pull/${issue.number}.diff`),
      patch_url: u(`/${repo.fullName}/pull/${issue.number}.patch`),
      merged_at: issue.pull.mergedAt ? isoOf(issue.pull.mergedAt) : null,
    };
  }
  return out;
}

export function commentJson(repo: Repo, issue: IssueRec, comment: CommentRec): Json {
  return {
    id: comment.id,
    node_id: nodeId('IssueComment', comment.id),
    url: u(`/api/v3/repos/${repo.fullName}/issues/comments/${comment.id}`),
    html_url: u(`/${repo.fullName}/issues/${issue.number}#issuecomment-${comment.id}`),
    issue_url: u(`/api/v3/repos/${repo.fullName}/issues/${issue.number}`),
    user: userJson(comment.userLogin),
    created_at: isoOf(comment.createdAt),
    updated_at: isoOf(comment.updatedAt),
    author_association: 'OWNER',
    body: comment.body,
  };
}

export function commitJson(repo: Repo, sha: string): Json | null {
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const api = u(`/api/v3/repos/${repo.fullName}`);
  return {
    sha,
    node_id: nodeId('Commit', sha),
    commit: {
      author: { name: commit.authorName, email: commit.authorEmail, date: isoOf(new Date(commit.authorEpoch * 1000)) },
      committer: { name: commit.committerName, email: commit.committerEmail, date: isoOf(new Date(commit.committerEpoch * 1000)) },
      message: commit.message,
      tree: { sha: commit.tree, url: `${api}/git/trees/${commit.tree}` },
      url: `${api}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `${api}/commits/${sha}`,
    html_url: u(`/${repo.fullName}/commit/${sha}`),
    comments_url: `${api}/comments/${sha}`,
    author: userJson(VIEWER_LOGIN),
    committer: userJson(VIEWER_LOGIN),
    parents: commit.parents.map((parent) => ({
      sha: parent,
      url: `${api}/commits/${parent}`,
      html_url: u(`/${repo.fullName}/commit/${parent}`),
    })),
  };
}
