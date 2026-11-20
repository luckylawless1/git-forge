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
  type EventRec,
  type IssueRec,
  type LabelRec,
  type ReleaseRec,
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

export function releaseJson(repo: Repo, release: ReleaseRec): Json {
  const api = u(`/api/v3/repos/${repo.fullName}/releases/${release.id}`);
  return {
    url: api,
    assets_url: `${api}/assets`,
    upload_url: `${api}/assets{?name,label}`,
    html_url: u(`/${repo.fullName}/releases/tag/${encodeURIComponent(release.tagName)}`),
    id: release.id,
    node_id: nodeId('Release', release.id),
    tag_name: release.tagName,
    target_commitish: release.targetCommitish,
    name: release.name,
    draft: release.draft,
    author: userJson(repo.owner),
    prerelease: release.prerelease,
    created_at: isoOf(release.createdAt),
    published_at: release.publishedAt ? isoOf(release.publishedAt) : null,
    assets: [],
    tarball_url: u(`/api/v3/repos/${repo.fullName}/tarball/${encodeURIComponent(release.tagName)}`),
    zipball_url: u(`/api/v3/repos/${repo.fullName}/zipball/${encodeURIComponent(release.tagName)}`),
    body: release.body,
  };
}

/** One entry of GET /tags: a tag ref with the commit it names. */
export function tagRefJson(repo: Repo, name: string, sha: string): Json {
  const api = u(`/api/v3/repos/${repo.fullName}`);
  return {
    name,
    node_id: nodeId('Tag', `${repo.id}:${name}`),
    commit: { sha, url: `${api}/commits/${sha}` },
    zipball_url: `${api}/zipball/refs/tags/${encodeURIComponent(name)}`,
    tarball_url: `${api}/tarball/refs/tags/${encodeURIComponent(name)}`,
  };
}

/** The git-database commit shape (GET /git/commits/{sha}), distinct from the REST commit. */
export function gitCommitJson(repo: Repo, sha: string): Json | null {
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const api = u(`/api/v3/repos/${repo.fullName}`);
  const ident = (name: string, email: string, epoch: number): Json => ({
    name,
    email,
    date: isoOf(new Date(epoch * 1000)),
  });
  return {
    sha,
    node_id: nodeId('GitCommit', sha),
    url: `${api}/git/commits/${sha}`,
    author: ident(commit.authorName, commit.authorEmail, commit.authorEpoch),
    committer: ident(commit.committerName, commit.committerEmail, commit.committerEpoch),
    message: commit.message,
    tree: { sha: commit.tree, url: `${api}/git/trees/${commit.tree}` },
    parents: commit.parents.map((parent) => ({ sha: parent, url: `${api}/git/commits/${parent}` })),
    verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
  };
}

/** Expand one stored commit reference of a PushEvent payload into GitHub's commit shape. */
function pushCommitJson(repo: Repo, stored: Record<string, unknown>): Json {
  const sha = String(stored.sha ?? '');
  return {
    id: sha,
    sha,
    message: String(stored.message ?? ''),
    timestamp: null,
    url: u(`/api/v3/repos/${repo.fullName}/commits/${sha}`),
    author: {
      name: String(stored.authorName ?? ''),
      email: String(stored.authorEmail ?? ''),
      username: VIEWER_LOGIN,
    },
    distinct: stored.distinct !== false,
  };
}

/**
 * One activity event in the repository/user feed shape. The stored payload holds references
 * (issue numbers, comment ids, commit shas); they expand here against the repo's current
 * records, so the feed renders the same objects every other surface serves.
 */
export function eventJson(repo: Repo | null, event: EventRec): Json {
  const stored = event.payload;
  const payload: Json = {};
  if (event.type === 'PushEvent') {
    const commits = Array.isArray(stored.commits) ? (stored.commits as Array<Record<string, unknown>>) : [];
    payload.ref = stored.ref;
    payload.before = stored.before;
    payload.after = stored.after;
    payload.created = false;
    payload.deleted = false;
    payload.forced = false;
    payload.base_ref = null;
    payload.compare = repo ? u(`/${repo.fullName}/compare/${String(stored.before)}...${String(stored.after)}`) : null;
    payload.commits = repo ? commits.map((commit) => pushCommitJson(repo, commit)) : [];
    payload.head_commit = repo && commits.length > 0 ? pushCommitJson(repo, commits[0]) : null;
    payload.size = stored.size;
    payload.distinct_size = stored.distinct_size;
  } else if (event.type === 'IssuesEvent' || event.type === 'PullRequestEvent') {
    payload.action = stored.action;
    const number = Number(stored.issueNumber ?? 0);
    payload.number = number;
    const issue = repo?.issues.get(number);
    if (issue && repo) payload.issue = issueJson(repo, issue);
    if (typeof stored.label === 'string' && repo) {
      const label = repo.labels.get(stored.label);
      if (label) payload.label = labelJson(repo, label);
    }
  } else if (event.type === 'IssueCommentEvent') {
    payload.action = stored.action;
    const issue = repo?.issues.get(Number(stored.issueNumber ?? 0));
    if (issue && repo) {
      payload.issue = issueJson(repo, issue);
      const comment = issue.comments.find((item) => item.id === Number(stored.commentId ?? 0));
      if (comment) payload.comment = commentJson(repo, issue, comment);
    }
  } else if (event.type === 'ReleaseEvent') {
    payload.action = stored.action;
    const release = repo?.releases.get(Number(stored.releaseId ?? 0));
    if (release && repo) {
      payload.release = releaseJson(repo, release);
    } else {
      // The release is gone (its own deletion event, or the repo's): keep the feed entry
      // renderable from the snapshot the recorder stored.
      payload.release = {
        id: Number(stored.releaseId ?? 0),
        node_id: nodeId('Release', Number(stored.releaseId ?? 0)),
        tag_name: typeof stored.tagName === 'string' ? stored.tagName : null,
        name: typeof stored.releaseName === 'string' ? stored.releaseName : null,
      };
    }
  } else {
    Object.assign(payload, stored);
  }
  return {
    id: String(event.id),
    type: event.type,
    actor: userJson(event.actorLogin),
    repo: {
      id: event.repoId,
      name: event.repoFullName,
      url: u(`/api/v3/repos/${event.repoFullName}`),
    },
    payload,
    public: true,
    created_at: isoOf(event.createdAt),
  };
}

/**
 * One entry of an issue's own event timeline (GET /repos/{owner}/{repo}/issues/{number}/events):
 * the smaller per-issue shape, or null when the stored event is not part of that timeline.
 */
export function issueEventJson(repo: Repo, event: EventRec): Json | null {
  const stored = event.payload;
  let name: string | null = null;
  if (event.type === 'IssueCommentEvent') name = 'commented';
  else if (event.type === 'IssuesEvent') {
    if (stored.action === 'closed') name = 'closed';
    else if (stored.action === 'reopened') name = 'reopened';
    else if (stored.action === 'labeled') name = 'labeled';
    else if (stored.action === 'unlabeled') name = 'unlabeled';
  } else if (event.type === 'PullRequestEvent') {
    if (stored.action === 'closed') {
      const issue = repo.issues.get(Number(stored.issueNumber ?? 0));
      name = issue?.pull?.merged ? 'merged' : 'closed';
    } else if (stored.action === 'reopened') name = 'reopened';
    else if (stored.action === 'labeled') name = 'labeled';
    else if (stored.action === 'unlabeled') name = 'unlabeled';
  }
  if (name === null) return null;
  const out: Json = {
    id: event.id,
    node_id: nodeId('IssueEvent', `${repo.id}:${event.id}`),
    url: u(`/api/v3/repos/${repo.fullName}/issues/events/${event.id}`),
    actor: userJson(event.actorLogin),
    event: name,
    commit_id: null,
    commit_url: null,
    created_at: isoOf(event.createdAt),
  };
  if ((name === 'labeled' || name === 'unlabeled') && typeof stored.label === 'string') {
    const label = repo.labels.get(stored.label);
    if (label) out.label = labelJson(repo, label);
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
