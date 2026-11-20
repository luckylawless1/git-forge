// GraphQL v4: a schema for the forge's core types, a small executor (aliases, fragments,
// variables, inline enum/object/list literals, batched operations), resolvers over the same store
// REST and MCP use, and introspection that describes the schema back.

import { ZERO_OID, flattenTree, parseCommit, parseTree, peelToCommit } from './git.ts';
import { diffTrees, planMerge } from './diff.ts';
import { recordIssueEvent, recordRefUpdate } from './events.ts';
import { parseGraphQL, valueOf, type SelectionNode } from './gqlparse.ts';
import { addCommentRecord, createIssueRecord, createPullRecord, mergePull } from './ops.ts';
import {
  VIEWER_LOGIN,
  decodeNodeId,
  forge,
  isoOf,
  nodeId,
  nowDate,
  type IssueRec,
  type LabelRec,
  type ReleaseRec,
  type Repo,
} from './store.ts';

// --------------------------------------------------------------------------- type references

type TypeRef =
  | { kind: 'named'; name: string }
  | { kind: 'list'; of: TypeRef }
  | { kind: 'nonNull'; of: TypeRef };

function typeRef(text: string): TypeRef {
  let i = 0;
  const parse = (): TypeRef => {
    let ref: TypeRef;
    if (text[i] === '[') {
      i += 1;
      const inner = parse();
      i += 1; // ]
      ref = { kind: 'list', of: inner };
    } else {
      const start = i;
      while (i < text.length && /[A-Za-z0-9_]/.test(text[i])) i += 1;
      ref = { kind: 'named', name: text.slice(start, i) };
    }
    if (text[i] === '!') {
      i += 1;
      return { kind: 'nonNull', of: ref };
    }
    return ref;
  };
  return parse();
}

function namedOf(ref: TypeRef): string {
  return ref.kind === 'named' ? ref.name : namedOf(ref.of);
}

// --------------------------------------------------------------------------- schema

interface FieldDef {
  type: string;
  args?: Record<string, { type: string; default?: unknown }>;
}

interface TypeDef {
  kind: 'OBJECT' | 'INTERFACE' | 'ENUM' | 'SCALAR' | 'INPUT_OBJECT';
  fields?: Record<string, FieldDef>;
  values?: string[];
  inputFields?: Record<string, { type: string }>;
}

const connArgs = {
  first: { type: 'Int' },
  after: { type: 'String' },
  last: { type: 'Int' },
  before: { type: 'String' },
};

const SCHEMA: Record<string, TypeDef> = {
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Float: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  ID: { kind: 'SCALAR' },
  DateTime: { kind: 'SCALAR' },
  URI: { kind: 'SCALAR' },
  GitObjectID: { kind: 'SCALAR' },
  Base64String: { kind: 'SCALAR' },
  HTML: { kind: 'SCALAR' },
  IssueState: { kind: 'ENUM', values: ['OPEN', 'CLOSED'] },
  IssueStateReason: { kind: 'ENUM', values: ['COMPLETED', 'NOT_PLANNED', 'REOPENED', 'DUPLICATE'] },
  ReleaseOrderField: { kind: 'ENUM', values: ['CREATED_AT', 'NAME'] },
  PullRequestState: { kind: 'ENUM', values: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', values: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  MergeStateStatus: { kind: 'ENUM', values: ['BEHIND', 'BLOCKED', 'CLEAN', 'DIRTY', 'DRAFT', 'HAS_HOOKS', 'UNKNOWN', 'UNSTABLE'] },
  PullRequestMergeMethod: { kind: 'ENUM', values: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', values: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  SearchType: { kind: 'ENUM', values: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  IssueOrderField: { kind: 'ENUM', values: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  PullRequestOrderField: { kind: 'ENUM', values: ['CREATED_AT', 'UPDATED_AT'] },
  OrderDirection: { kind: 'ENUM', values: ['ASC', 'DESC'] },
  RefOrderField: { kind: 'ENUM', values: ['ALPHABETICAL', 'TAG_COMMIT_DATE'] },
  LabelOrderField: { kind: 'ENUM', values: ['NAME', 'CREATED_AT'] },
  IssueCommentOrderField: { kind: 'ENUM', values: ['CREATED_AT', 'UPDATED_AT'] },
  ChangeType: { kind: 'ENUM', values: ['ADDED', 'DELETED', 'MODIFIED', 'RENAMED', 'COPIED', 'CHANGED'] },
  IssueOrder: { kind: 'INPUT_OBJECT', inputFields: { field: { type: 'IssueOrderField!' }, direction: { type: 'OrderDirection!' } } },
  PullRequestOrder: { kind: 'INPUT_OBJECT', inputFields: { field: { type: 'PullRequestOrderField!' }, direction: { type: 'OrderDirection!' } } },
  RefOrder: { kind: 'INPUT_OBJECT', inputFields: { field: { type: 'RefOrderField!' }, direction: { type: 'OrderDirection!' } } },
  LabelOrder: { kind: 'INPUT_OBJECT', inputFields: { field: { type: 'LabelOrderField!' }, direction: { type: 'OrderDirection!' } } },
  IssueCommentOrder: { kind: 'INPUT_OBJECT', inputFields: { field: { type: 'IssueCommentOrderField!' }, direction: { type: 'OrderDirection!' } } },
  ReleaseOrder: { kind: 'INPUT_OBJECT', inputFields: { field: { type: 'ReleaseOrderField!' }, direction: { type: 'OrderDirection!' } } },
  CreateIssueInput: {
    kind: 'INPUT_OBJECT',
    inputFields: {
      repositoryId: { type: 'ID!' }, title: { type: 'String!' }, body: { type: 'String' },
      labelIds: { type: '[ID!]' }, assigneeIds: { type: '[ID!]' }, milestoneId: { type: 'ID' },
      clientMutationId: { type: 'String' },
    },
  },
  CloseIssueInput: { kind: 'INPUT_OBJECT', inputFields: { issueId: { type: 'ID!' }, stateReason: { type: 'String' }, clientMutationId: { type: 'String' } } },
  ReopenIssueInput: { kind: 'INPUT_OBJECT', inputFields: { issueId: { type: 'ID!' }, clientMutationId: { type: 'String' } } },
  CreatePullRequestInput: {
    kind: 'INPUT_OBJECT',
    inputFields: {
      repositoryId: { type: 'ID!' }, baseRefName: { type: 'String!' }, headRefName: { type: 'String!' },
      title: { type: 'String!' }, body: { type: 'String' }, draft: { type: 'Boolean' }, clientMutationId: { type: 'String' },
    },
  },
  MergePullRequestInput: {
    kind: 'INPUT_OBJECT',
    inputFields: {
      pullRequestId: { type: 'ID!' }, mergeMethod: { type: 'PullRequestMergeMethod' },
      commitHeadline: { type: 'String' }, commitBody: { type: 'String' }, expectedHeadOid: { type: 'GitObjectID' },
      authorEmail: { type: 'String' }, clientMutationId: { type: 'String' },
    },
  },
  AddCommentInput: { kind: 'INPUT_OBJECT', inputFields: { subjectId: { type: 'ID!' }, body: { type: 'String!' }, clientMutationId: { type: 'String' } } },
  UpdateIssueInput: {
    kind: 'INPUT_OBJECT',
    inputFields: {
      id: { type: 'ID!' }, title: { type: 'String' }, body: { type: 'String' },
      state: { type: 'IssueState' }, labelIds: { type: '[ID!]' }, clientMutationId: { type: 'String' },
    },
  },
  ClosePullRequestInput: { kind: 'INPUT_OBJECT', inputFields: { pullRequestId: { type: 'ID!' }, clientMutationId: { type: 'String' } } },
  ReopenPullRequestInput: { kind: 'INPUT_OBJECT', inputFields: { pullRequestId: { type: 'ID!' }, clientMutationId: { type: 'String' } } },
  AddLabelsToLabelableInput: { kind: 'INPUT_OBJECT', inputFields: { labelableId: { type: 'ID!' }, labelIds: { type: '[ID!]!' }, clientMutationId: { type: 'String' } } },
  RemoveLabelsFromLabelableInput: { kind: 'INPUT_OBJECT', inputFields: { labelableId: { type: 'ID!' }, labelIds: { type: '[ID!]!' }, clientMutationId: { type: 'String' } } },
  CreateRefInput: { kind: 'INPUT_OBJECT', inputFields: { repositoryId: { type: 'ID!' }, name: { type: 'String!' }, oid: { type: 'GitObjectID!' }, clientMutationId: { type: 'String' } } },
  DeleteRefInput: { kind: 'INPUT_OBJECT', inputFields: { refId: { type: 'ID!' }, clientMutationId: { type: 'String' } } },
  UpdateIssueCommentInput: { kind: 'INPUT_OBJECT', inputFields: { id: { type: 'ID!' }, body: { type: 'String!' }, clientMutationId: { type: 'String' } } },
  DeleteIssueCommentInput: { kind: 'INPUT_OBJECT', inputFields: { id: { type: 'ID!' }, clientMutationId: { type: 'String' } } },
  Query: {
    kind: 'OBJECT',
    fields: {
      viewer: { type: 'User!' },
      repository: { type: 'Repository', args: { owner: { type: 'String!' }, name: { type: 'String!' } } },
      repositoryOwner: { type: 'RepositoryOwner', args: { login: { type: 'String!' } } },
      node: { type: 'Node', args: { id: { type: 'ID!' } } },
      nodes: { type: '[Node]!', args: { ids: { type: '[ID!]!' } } },
      user: { type: 'User', args: { login: { type: 'String!' } } },
      search: {
        type: 'SearchResultItemConnection!',
        args: { query: { type: 'String!' }, type: { type: 'SearchType!' }, ...connArgs },
      },
      rateLimit: { type: 'RateLimit', args: { dryRun: { type: 'Boolean' } } },
    },
  },
  Mutation: {
    kind: 'OBJECT',
    fields: {
      createIssue: { type: 'CreateIssuePayload', args: { input: { type: 'CreateIssueInput!' } } },
      closeIssue: { type: 'CloseIssuePayload', args: { input: { type: 'CloseIssueInput!' } } },
      reopenIssue: { type: 'ReopenIssuePayload', args: { input: { type: 'ReopenIssueInput!' } } },
      createPullRequest: { type: 'CreatePullRequestPayload', args: { input: { type: 'CreatePullRequestInput!' } } },
      mergePullRequest: { type: 'MergePullRequestPayload', args: { input: { type: 'MergePullRequestInput!' } } },
      addComment: { type: 'AddCommentPayload', args: { input: { type: 'AddCommentInput!' } } },
      updateIssue: { type: 'UpdateIssuePayload', args: { input: { type: 'UpdateIssueInput!' } } },
      closePullRequest: { type: 'ClosePullRequestPayload', args: { input: { type: 'ClosePullRequestInput!' } } },
      reopenPullRequest: { type: 'ReopenPullRequestPayload', args: { input: { type: 'ReopenPullRequestInput!' } } },
      addLabelsToLabelable: { type: 'AddLabelsToLabelablePayload', args: { input: { type: 'AddLabelsToLabelableInput!' } } },
      removeLabelsFromLabelable: { type: 'RemoveLabelsFromLabelablePayload', args: { input: { type: 'RemoveLabelsFromLabelableInput!' } } },
      createRef: { type: 'CreateRefPayload', args: { input: { type: 'CreateRefInput!' } } },
      deleteRef: { type: 'DeleteRefPayload', args: { input: { type: 'DeleteRefInput!' } } },
      updateIssueComment: { type: 'UpdateIssueCommentPayload', args: { input: { type: 'UpdateIssueCommentInput!' } } },
      deleteIssueComment: { type: 'DeleteIssueCommentPayload', args: { input: { type: 'DeleteIssueCommentInput!' } } },
    },
  },
  Node: { kind: 'INTERFACE', fields: { id: { type: 'ID!' } } },
  Actor: { kind: 'INTERFACE', fields: { login: { type: 'String!' }, id: { type: 'ID!' }, url: { type: 'URI!' }, avatarUrl: { type: 'URI!', args: { size: { type: 'Int' } } } } },
  RepositoryOwner: { kind: 'INTERFACE', fields: { login: { type: 'String!' }, id: { type: 'ID!' }, url: { type: 'URI!' }, avatarUrl: { type: 'URI!', args: { size: { type: 'Int' } } } } },
  User: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      login: { type: 'String!' },
      name: { type: 'String' },
      email: { type: 'String' },
      url: { type: 'URI!' },
      avatarUrl: { type: 'URI!', args: { size: { type: 'Int' } } },
      databaseId: { type: 'Int' },
      createdAt: { type: 'DateTime!' },
      updatedAt: { type: 'DateTime!' },
      isViewer: { type: 'Boolean!' },
      bio: { type: 'String' },
      location: { type: 'String' },
      websiteUrl: { type: 'URI' },
      repositories: { type: 'RepositoryConnection!', args: { ...connArgs, orderBy: { type: 'RefOrder' } } },
    },
  },
  Repository: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      databaseId: { type: 'Int' },
      name: { type: 'String!' },
      nameWithOwner: { type: 'String!' },
      owner: { type: 'RepositoryOwner!' },
      description: { type: 'String' },
      isPrivate: { type: 'Boolean!' },
      isEmpty: { type: 'Boolean!' },
      isFork: { type: 'Boolean!' },
      isArchived: { type: 'Boolean!' },
      isTemplate: { type: 'Boolean!' },
      createdAt: { type: 'DateTime!' },
      updatedAt: { type: 'DateTime!' },
      pushedAt: { type: 'DateTime' },
      url: { type: 'URI!' },
      sshUrl: { type: 'URI!' },
      homepageUrl: { type: 'URI' },
      defaultBranchRef: { type: 'Ref' },
      viewerPermission: { type: 'RepositoryPermission' },
      viewerCanAdminister: { type: 'Boolean!' },
      hasIssuesEnabled: { type: 'Boolean!' },
      hasPullRequestsEnabled: { type: 'Boolean!' },
      hasWikiEnabled: { type: 'Boolean!' },
      stargazerCount: { type: 'Int!' },
      forkCount: { type: 'Int!' },
      issue: { type: 'Issue', args: { number: { type: 'Int!' } } },
      issues: {
        type: 'IssueConnection!',
        args: { ...connArgs, states: { type: '[IssueState!]' }, orderBy: { type: 'IssueOrder' }, labels: { type: '[String!]' } },
      },
      pullRequest: { type: 'PullRequest', args: { number: { type: 'Int!' } } },
      pullRequests: {
        type: 'PullRequestConnection!',
        args: { ...connArgs, states: { type: '[PullRequestState!]' }, orderBy: { type: 'PullRequestOrder' }, baseRefName: { type: 'String' }, headRefName: { type: 'String' } },
      },
      label: { type: 'Label', args: { name: { type: 'String!' } } },
      labels: { type: 'LabelConnection!', args: { ...connArgs, orderBy: { type: 'LabelOrder' }, query: { type: 'String' } } },
      release: { type: 'Release', args: { tagName: { type: 'String!' } } },
      releases: { type: 'ReleaseConnection!', args: { ...connArgs, orderBy: { type: 'ReleaseOrder' } } },
      ref: { type: 'Ref', args: { qualifiedName: { type: 'String!' } } },
      refs: { type: 'RefConnection!', args: { ...connArgs, refPrefix: { type: 'String!' }, orderBy: { type: 'RefOrder' }, query: { type: 'String' } } },
      object: { type: 'GitObject', args: { expression: { type: 'String' }, oid: { type: 'GitObjectID' } } },
    },
  },
  Issue: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      databaseId: { type: 'Int' },
      number: { type: 'Int!' },
      title: { type: 'String!' },
      body: { type: 'String' },
      bodyText: { type: 'String' },
      bodyHTML: { type: 'HTML' },
      state: { type: 'IssueState!' },
      stateReason: { type: 'IssueStateReason' },
      locked: { type: 'Boolean!' },
      closed: { type: 'Boolean!' },
      closedAt: { type: 'DateTime' },
      createdAt: { type: 'DateTime!' },
      updatedAt: { type: 'DateTime!' },
      publishedAt: { type: 'DateTime' },
      url: { type: 'URI!' },
      repository: { type: 'Repository!' },
      author: { type: 'Actor' },
      authorAssociation: { type: 'String!' },
      labels: { type: 'LabelConnection!', args: { ...connArgs, orderBy: { type: 'LabelOrder' } } },
      comments: { type: 'IssueCommentConnection!', args: { ...connArgs, orderBy: { type: 'IssueCommentOrder' } } },
      assignees: { type: 'UserConnection!', args: { ...connArgs } },
    },
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      databaseId: { type: 'Int' },
      number: { type: 'Int!' },
      title: { type: 'String!' },
      body: { type: 'String' },
      bodyText: { type: 'String' },
      state: { type: 'PullRequestState!' },
      merged: { type: 'Boolean!' },
      mergedAt: { type: 'DateTime' },
      mergedBy: { type: 'Actor' },
      closed: { type: 'Boolean!' },
      closedAt: { type: 'DateTime' },
      createdAt: { type: 'DateTime!' },
      updatedAt: { type: 'DateTime!' },
      url: { type: 'URI!' },
      author: { type: 'Actor' },
      authorAssociation: { type: 'String!' },
      repository: { type: 'Repository!' },
      baseRepository: { type: 'Repository!' },
      headRepository: { type: 'Repository' },
      baseRefName: { type: 'String!' },
      headRefName: { type: 'String!' },
      baseRef: { type: 'Ref' },
      headRef: { type: 'Ref' },
      baseRefOid: { type: 'GitObjectID!' },
      headRefOid: { type: 'GitObjectID!' },
      mergeable: { type: 'MergeableState!' },
      mergeStateStatus: { type: 'MergeStateStatus!' },
      isDraft: { type: 'Boolean!' },
      additions: { type: 'Int!' },
      deletions: { type: 'Int!' },
      changedFiles: { type: 'Int!' },
      mergeCommit: { type: 'Commit' },
      commits: { type: 'PullRequestCommitConnection!', args: { ...connArgs } },
      files: { type: 'PullRequestChangedFileConnection!', args: { ...connArgs } },
      comments: { type: 'IssueCommentConnection!', args: { ...connArgs } },
      labels: { type: 'LabelConnection!', args: { ...connArgs } },
      assignees: { type: 'UserConnection!', args: { ...connArgs } },
    },
  },
  IssueComment: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      databaseId: { type: 'Int' },
      body: { type: 'String!' },
      bodyText: { type: 'String!' },
      createdAt: { type: 'DateTime!' },
      updatedAt: { type: 'DateTime!' },
      publishedAt: { type: 'DateTime' },
      author: { type: 'Actor' },
      authorAssociation: { type: 'String!' },
      url: { type: 'URI!' },
      issue: { type: 'Issue!' },
      pullRequest: { type: 'PullRequest' },
      repository: { type: 'Repository!' },
    },
  },
  Label: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      name: { type: 'String!' },
      color: { type: 'String!' },
      description: { type: 'String' },
      isDefault: { type: 'Boolean!' },
      createdAt: { type: 'DateTime!' },
      updatedAt: { type: 'DateTime!' },
      url: { type: 'URI!' },
      repository: { type: 'Repository!' },
    },
  },
  Release: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      databaseId: { type: 'Int' },
      name: { type: 'String' },
      tagName: { type: 'String!' },
      targetCommitish: { type: 'String' },
      isDraft: { type: 'Boolean!' },
      isPrerelease: { type: 'Boolean!' },
      isLatest: { type: 'Boolean!' },
      createdAt: { type: 'DateTime!' },
      publishedAt: { type: 'DateTime' },
      updatedAt: { type: 'DateTime!' },
      url: { type: 'URI!' },
      description: { type: 'String' },
      descriptionHTML: { type: 'HTML' },
      author: { type: 'Actor' },
      repository: { type: 'Repository!' },
      tag: { type: 'Ref' },
    },
  },
  Ref: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      name: { type: 'String!' },
      prefix: { type: 'String!' },
      qualifiedName: { type: 'String!' },
      repository: { type: 'Repository!' },
      target: { type: 'GitObject' },
    },
  },
  GitObject: {
    kind: 'INTERFACE',
    fields: {
      id: { type: 'ID!' },
      oid: { type: 'GitObjectID!' },
      abbreviatedOid: { type: 'String!' },
      repository: { type: 'Repository!' },
    },
  },
  Commit: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      oid: { type: 'GitObjectID!' },
      abbreviatedOid: { type: 'String!' },
      message: { type: 'String!' },
      messageHeadline: { type: 'String!' },
      messageBody: { type: 'String!' },
      committedDate: { type: 'DateTime!' },
      authoredDate: { type: 'DateTime!' },
      author: { type: 'GitActor' },
      committer: { type: 'GitActor' },
      tree: { type: 'Tree!' },
      treeOid: { type: 'GitObjectID!' },
      parents: { type: 'CommitConnection!', args: { ...connArgs } },
      history: {
        type: 'CommitHistoryConnection!',
        args: { ...connArgs, path: { type: 'String' }, since: { type: 'DateTime' }, until: { type: 'DateTime' } },
      },
      url: { type: 'URI!' },
      repository: { type: 'Repository!' },
      additions: { type: 'Int' },
      deletions: { type: 'Int' },
      changedFiles: { type: 'Int' },
    },
  },
  Tree: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      oid: { type: 'GitObjectID!' },
      abbreviatedOid: { type: 'String!' },
      entries: { type: '[TreeEntry!]!' },
      repository: { type: 'Repository!' },
    },
  },
  TreeEntry: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String!' },
      path: { type: 'String!' },
      type: { type: 'String!' },
      mode: { type: 'Int!' },
      object: { type: 'GitObject' },
      extension: { type: 'String' },
    },
  },
  Blob: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      oid: { type: 'GitObjectID!' },
      abbreviatedOid: { type: 'String!' },
      byteSize: { type: 'Int!' },
      text: { type: 'String' },
      isBinary: { type: 'Boolean!' },
      isTruncated: { type: 'Boolean!' },
      repository: { type: 'Repository!' },
    },
  },
  GitActor: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String' },
      email: { type: 'String' },
      date: { type: 'DateTime' },
      avatarUrl: { type: 'URI!', args: { size: { type: 'Int' } } },
      user: { type: 'User' },
    },
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: {
      hasNextPage: { type: 'Boolean!' },
      hasPreviousPage: { type: 'Boolean!' },
      startCursor: { type: 'String' },
      endCursor: { type: 'String' },
    },
  },
  RateLimit: {
    kind: 'OBJECT',
    fields: {
      limit: { type: 'Int!' },
      cost: { type: 'Int!' },
      remaining: { type: 'Int!' },
      used: { type: 'Int!' },
      nodeCount: { type: 'Int!' },
      resetAt: { type: 'DateTime!' },
    },
  },
  CreateIssuePayload: { kind: 'OBJECT', fields: { clientMutationId: { type: 'String' }, issue: { type: 'Issue' } } },
  CloseIssuePayload: { kind: 'OBJECT', fields: { clientMutationId: { type: 'String' }, issue: { type: 'Issue' } } },
  ReopenIssuePayload: { kind: 'OBJECT', fields: { clientMutationId: { type: 'String' }, issue: { type: 'Issue' } } },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: { clientMutationId: { type: 'String' }, pullRequest: { type: 'PullRequest' } } },
  MergePullRequestPayload: { kind: 'OBJECT', fields: { clientMutationId: { type: 'String' }, pullRequest: { type: 'PullRequest' } } },
  AddCommentPayload: { kind: 'OBJECT', fields: { clientMutationId: { type: 'String' }, commentEdge: { type: 'IssueCommentEdge' }, subject: { type: 'Node' } } },
  UpdateIssuePayload: { kind: 'OBJECT', fields: { clientMutationId: { type: 'String' }, issue: { type: 'Issue' } } },
  ClosePullRequestPayload: { kind: 'OBJECT', fields: { clientMutationId: { type: 'String' }, pullRequest: { type: 'PullRequest' } } },
  ReopenPullRequestPayload: { kind: 'OBJECT', fields: { clientMutationId: { type: 'String' }, pullRequest: { type: 'PullRequest' } } },
  AddLabelsToLabelablePayload: { kind: 'OBJECT', fields: { clientMutationId: { type: 'String' }, labelable: { type: 'Labelable' } } },
  RemoveLabelsFromLabelablePayload: { kind: 'OBJECT', fields: { clientMutationId: { type: 'String' }, labelable: { type: 'Labelable' } } },
  CreateRefPayload: { kind: 'OBJECT', fields: { clientMutationId: { type: 'String' }, ref: { type: 'Ref' } } },
  DeleteRefPayload: { kind: 'OBJECT', fields: { clientMutationId: { type: 'String' }, deletedRefId: { type: 'ID' } } },
  UpdateIssueCommentPayload: { kind: 'OBJECT', fields: { clientMutationId: { type: 'String' }, issueComment: { type: 'IssueComment' } } },
  DeleteIssueCommentPayload: { kind: 'OBJECT', fields: { clientMutationId: { type: 'String' }, deletedCommentId: { type: 'ID' } } },
  Labelable: { kind: 'INTERFACE', fields: { id: { type: 'ID!' } } },
};

// Connection and edge types, generated for each node type they carry.
const CONNECTION_OF: Record<string, string> = {
  IssueConnection: 'Issue',
  PullRequestConnection: 'PullRequest',
  LabelConnection: 'Label',
  RefConnection: 'Ref',
  UserConnection: 'User',
  RepositoryConnection: 'Repository',
  IssueCommentConnection: 'IssueComment',
  CommitConnection: 'Commit',
  CommitHistoryConnection: 'Commit',
  ReleaseConnection: 'Release',
  PullRequestCommitConnection: 'PullRequestCommit',
  PullRequestChangedFileConnection: 'PullRequestChangedFile',
  SearchResultItemConnection: 'SearchResultItem',
};
for (const [connection, node] of Object.entries(CONNECTION_OF)) {
  const edge = connection.replace(/Connection$/, 'Edge');
  SCHEMA[connection] = {
    kind: 'OBJECT',
    fields: {
      nodes: { type: `[${node}]` },
      edges: { type: `[${edge}]` },
      pageInfo: { type: 'PageInfo!' },
      totalCount: { type: 'Int!' },
      ...(connection === 'SearchResultItemConnection'
        ? { issueCount: { type: 'Int!' }, repositoryCount: { type: 'Int!' }, userCount: { type: 'Int!' }, discussionCount: { type: 'Int!' } }
        : {}),
    },
  };
  SCHEMA[edge] = { kind: 'OBJECT', fields: { cursor: { type: 'String!' }, node: { type: node } } };
}
SCHEMA.PullRequestCommit = {
  kind: 'OBJECT',
  fields: { commit: { type: 'Commit!' }, resourcePath: { type: 'URI!' }, url: { type: 'URI!' } },
};
SCHEMA.PullRequestChangedFile = {
  kind: 'OBJECT',
  fields: {
    path: { type: 'String!' },
    additions: { type: 'Int!' },
    deletions: { type: 'Int!' },
    changeType: { type: 'ChangeType!' },
  },
};
SCHEMA.SearchResultItem = { kind: 'OBJECT', fields: { id: { type: 'ID!' } } };
SCHEMA.Tag = {
  kind: 'OBJECT',
  fields: {
    id: { type: 'ID!' },
    oid: { type: 'GitObjectID!' },
    name: { type: 'String!' },
    target: { type: 'GitObject' },
    repository: { type: 'Repository!' },
  },
};

// The introspection types themselves, so __type/__schema queries resolve through the executor.
SCHEMA.__TypeKind = { kind: 'ENUM', values: ['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL'] };
SCHEMA.__DirectiveLocation = { kind: 'ENUM', values: ['QUERY', 'MUTATION', 'SUBSCRIPTION', 'FIELD', 'FRAGMENT_DEFINITION', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT', 'SCHEMA'] };
SCHEMA.__Type = {
  kind: 'OBJECT',
  fields: {
    kind: { type: '__TypeKind!' },
    name: { type: 'String' },
    description: { type: 'String' },
    fields: { type: '[__Field!]', args: { includeDeprecated: { type: 'Boolean', default: false } } },
    inputFields: { type: '[__InputValue!]', args: { includeDeprecated: { type: 'Boolean', default: false } } },
    interfaces: { type: '[__Type!]' },
    enumValues: { type: '[__EnumValue!]', args: { includeDeprecated: { type: 'Boolean', default: false } } },
    possibleTypes: { type: '[__Type!]' },
    ofType: { type: '__Type' },
    specifiedByURL: { type: 'String' },
    isOneOf: { type: 'Boolean!' },
  },
};
SCHEMA.__Field = {
  kind: 'OBJECT',
  fields: {
    name: { type: 'String!' },
    description: { type: 'String' },
    args: { type: '[__InputValue!]!', args: { includeDeprecated: { type: 'Boolean', default: false } } },
    type: { type: '__Type!' },
    isDeprecated: { type: 'Boolean!' },
    deprecationReason: { type: 'String' },
  },
};
SCHEMA.__InputValue = {
  kind: 'OBJECT',
  fields: {
    name: { type: 'String!' },
    description: { type: 'String' },
    type: { type: '__Type!' },
    defaultValue: { type: 'String' },
    isDeprecated: { type: 'Boolean!' },
    deprecationReason: { type: 'String' },
  },
};
SCHEMA.__EnumValue = {
  kind: 'OBJECT',
  fields: {
    name: { type: 'String!' },
    description: { type: 'String' },
    isDeprecated: { type: 'Boolean!' },
    deprecationReason: { type: 'String' },
  },
};
SCHEMA.__Schema = {
  kind: 'OBJECT',
  fields: {
    description: { type: 'String' },
    types: { type: '[__Type!]!' },
    queryType: { type: '__Type!' },
    mutationType: { type: '__Type' },
    subscriptionType: { type: '__Type' },
    directives: { type: '[__Directive!]!' },
  },
};
SCHEMA.__Directive = {
  kind: 'OBJECT',
  fields: {
    name: { type: 'String!' },
    description: { type: 'String' },
    locations: { type: '[__DirectiveLocation!]!' },
    args: { type: '[__InputValue!]!' },
    isRepeatable: { type: 'Boolean!' },
  },
};

// --------------------------------------------------------------------------- values

type Value = Record<string, unknown> & { __typename: string };

const userValue = (login: string): Value => ({ __typename: 'User', login });
const repoValue = (repo: Repo): Value => ({ __typename: 'Repository', repo });
const issueValue = (repo: Repo, rec: IssueRec): Value => ({ __typename: 'Issue', repo, rec });
const prValue = (repo: Repo, rec: IssueRec): Value => ({ __typename: 'PullRequest', repo, rec });
const labelValue = (repo: Repo, label: LabelRec): Value => ({ __typename: 'Label', repo, label });
const releaseValue = (repo: Repo, release: ReleaseRec): Value => ({ __typename: 'Release', repo, release });
const refValue = (repo: Repo, ref: string): Value => ({ __typename: 'Ref', repo, ref });
const commitValue = (repo: Repo, oid: string): Value => ({ __typename: 'Commit', repo, oid });
const treeValue = (repo: Repo, oid: string): Value => ({ __typename: 'Tree', repo, oid });
const blobValue = (repo: Repo, oid: string): Value => ({ __typename: 'Blob', repo, oid });
const commentValue = (repo: Repo, rec: IssueRec, comment: IssueRec['comments'][number]): Value => ({
  __typename: 'IssueComment',
  repo,
  rec,
  comment,
});

function objectValue(repo: Repo, oid: string): Value | null {
  const object = repo.objects.get(oid);
  if (!object) return null;
  if (object.type === 'commit') return commitValue(repo, oid);
  if (object.type === 'tree') return treeValue(repo, oid);
  if (object.type === 'blob') return blobValue(repo, oid);
  const peeled = peelToCommit(repo.objects, oid);
  return peeled ? commitValue(repo, peeled) : null;
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexOfCursor(cursor: unknown): number {
  if (typeof cursor !== 'string') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : -1;
  } catch {
    return -1;
  }
}

interface PageArgs {
  first?: number | null;
  after?: string | null;
  last?: number | null;
  before?: string | null;
}

function connectionValue(connectionType: string, items: Value[], args: PageArgs, extra?: Record<string, unknown>): Value {
  let start = 0;
  let end = items.length;
  const afterIndex = indexOfCursor(args.after);
  if (afterIndex >= 0) start = afterIndex + 1;
  const beforeIndex = indexOfCursor(args.before);
  if (beforeIndex >= 0) end = Math.min(end, beforeIndex);
  let slice = items.slice(start, end);
  let sliceStart = start;
  if (typeof args.first === 'number') slice = slice.slice(0, Math.max(0, args.first));
  if (typeof args.last === 'number' && slice.length > args.last) {
    sliceStart += slice.length - args.last;
    slice = slice.slice(slice.length - args.last);
  }
  const edgeType = connectionType.replace(/Connection$/, 'Edge');
  const edges = slice.map((node, i) => ({ __typename: edgeType, __node: node, __cursor: cursorFor(sliceStart + i) }));
  return {
    __typename: connectionType,
    __nodes: slice,
    __edges: edges,
    __total: items.length,
    __pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: sliceStart + slice.length < items.length,
      hasPreviousPage: sliceStart > 0,
      startCursor: slice.length ? cursorFor(sliceStart) : null,
      endCursor: slice.length ? cursorFor(sliceStart + slice.length - 1) : null,
    },
    ...extra,
  };
}

// --------------------------------------------------------------------------- resolvers

type Resolver = (source: Value, args: Record<string, unknown>) => unknown;

const R: Record<string, Record<string, Resolver>> = {};

function def(type: string, fields: Record<string, Resolver>): void {
  R[type] = { ...(R[type] ?? {}), ...fields };
}

const isoDate = (date: Date | null | undefined): string | null => (date ? isoOf(date) : null);
const prState = (rec: IssueRec): string => (rec.pull?.merged ? 'MERGED' : rec.state === 'open' ? 'OPEN' : 'CLOSED');

function orderRecords(records: IssueRec[], orderBy: unknown, fallbackField = 'CREATED_AT'): IssueRec[] {
  const order = (orderBy ?? {}) as { field?: string; direction?: string };
  const field = order.field ?? fallbackField;
  const direction = order.direction ?? 'DESC';
  const key = (rec: IssueRec): number =>
    field === 'UPDATED_AT' ? rec.updatedAt.getTime() : field === 'COMMENTS' ? rec.comments.length : rec.createdAt.getTime();
  const sorted = [...records].sort((a, b) => key(a) - key(b) || a.number - b.number);
  return direction === 'ASC' ? sorted : sorted.reverse();
}

function issueConnection(repo: Repo, args: Record<string, unknown>): Value {
  let records = [...repo.issues.values()].filter((rec) => rec.pull === null);
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length) {
    records = records.filter((rec) => states.includes(rec.state.toUpperCase()));
  }
  const labels = args.labels as string[] | undefined;
  if (Array.isArray(labels) && labels.length) {
    records = records.filter((rec) => labels.every((name) => rec.labels.includes(name)));
  }
  return connectionValue('IssueConnection', orderRecords(records, args.orderBy).map((rec) => issueValue(repo, rec)), args as PageArgs);
}

function prConnection(repo: Repo, args: Record<string, unknown>): Value {
  let records = [...repo.issues.values()].filter((rec) => rec.pull !== null);
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length) records = records.filter((rec) => states.includes(prState(rec)));
  if (typeof args.baseRefName === 'string') records = records.filter((rec) => rec.pull?.baseRef === args.baseRefName);
  if (typeof args.headRefName === 'string') records = records.filter((rec) => rec.pull?.headRef === args.headRefName);
  return connectionValue('PullRequestConnection', orderRecords(records, args.orderBy).map((rec) => prValue(repo, rec)), args as PageArgs);
}

function labelConnection(repo: Repo, labels: LabelRec[], args: Record<string, unknown>): Value {
  const order = (args.orderBy ?? {}) as { field?: string; direction?: string };
  const sorted = [...labels].sort((a, b) => (a.name < b.name ? -1 : 1));
  if (order.direction === 'DESC') sorted.reverse();
  return connectionValue('LabelConnection', sorted.map((label) => labelValue(repo, label)), args as PageArgs);
}

function nodeForId(id: string): Value | null {
  const decoded = decodeNodeId(id);
  if (!decoded) return null;
  if (decoded.kind === 'Repository') {
    const repo = forge.reposById.get(Number(decoded.key));
    return repo ? repoValue(repo) : null;
  }
  if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
    const [repoId, number] = decoded.key.split(':');
    const repo = forge.reposById.get(Number(repoId));
    const rec = repo?.issues.get(Number(number));
    if (!repo || !rec) return null;
    return rec.pull ? prValue(repo, rec) : issueValue(repo, rec);
  }
  if (decoded.kind === 'User') return userValue(decoded.key);
  if (decoded.kind === 'IssueComment') {
    for (const repo of forge.listRepos()) {
      for (const rec of repo.issues.values()) {
        const comment = rec.comments.find((item) => item.id === Number(decoded.key));
        if (comment) return commentValue(repo, rec, comment);
      }
    }
  }
  if (decoded.kind === 'Release') {
    for (const repo of forge.listRepos()) {
      const release = repo.releases.get(Number(decoded.key));
      if (release) return releaseValue(repo, release);
    }
  }
  if (decoded.kind === 'Label') {
    const [repoId, ...rest] = decoded.key.split(':');
    const repo = forge.reposById.get(Number(repoId));
    const label = repo?.labels.get(rest.join(':'));
    if (repo && label) return labelValue(repo, label);
  }
  if (decoded.kind === 'Ref') {
    const [repoId, ...rest] = decoded.key.split(':');
    const repo = forge.reposById.get(Number(repoId));
    const ref = rest.join(':');
    if (repo && repo.refs.has(ref)) return refValue(repo, ref);
  }
  if (decoded.kind === 'Commit') {
    for (const repo of forge.listRepos()) {
      const object = repo.objects.get(decoded.key);
      if (object && object.type === 'commit') return commitValue(repo, decoded.key);
    }
  }
  return null;
}

def('Query', {
  viewer: () => userValue(VIEWER_LOGIN),
  repository: (_s, args) => {
    const repo = forge.getRepo(String(args.owner), String(args.name));
    return repo ? repoValue(repo) : null;
  },
  repositoryOwner: (_s, args) => (args.login === VIEWER_LOGIN ? userValue(VIEWER_LOGIN) : null),
  node: (_s, args) => nodeForId(String(args.id)),
  nodes: (_s, args) => (Array.isArray(args.ids) ? args.ids.map((id) => nodeForId(String(id))) : []),
  user: (_s, args) => (args.login === VIEWER_LOGIN ? userValue(VIEWER_LOGIN) : null),
  rateLimit: () => ({
    __typename: 'RateLimit',
    limit: 5000,
    cost: 1,
    remaining: 4999,
    used: 1,
    nodeCount: 0,
    resetAt: isoOf(new Date(Date.now() + 3_600_000)),
  }),
  search: (_s, args) => {
    const query = String(args.query ?? '').toLowerCase();
    const type = String(args.type ?? 'ISSUE');
    const items: Value[] = [];
    if (type === 'ISSUE') {
      for (const repo of forge.listRepos()) {
        for (const rec of orderRecords([...repo.issues.values()], null)) {
          if (query === '' || rec.title.toLowerCase().includes(query)) {
            items.push(rec.pull ? prValue(repo, rec) : issueValue(repo, rec));
          }
        }
      }
    } else if (type === 'REPOSITORY') {
      for (const repo of forge.listRepos()) {
        if (query === '' || repo.name.toLowerCase().includes(query)) items.push(repoValue(repo));
      }
    } else if (type === 'USER') {
      if (VIEWER_LOGIN.includes(query)) items.push(userValue(VIEWER_LOGIN));
    }
    return connectionValue('SearchResultItemConnection', items, args as PageArgs, {
      issueCount: type === 'ISSUE' ? items.length : 0,
      repositoryCount: type === 'REPOSITORY' ? items.length : 0,
      userCount: type === 'USER' ? items.length : 0,
      discussionCount: 0,
    });
  },
});

def('Mutation', {
  createIssue: (_s, args) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = decodeNodeId(String(input.repositoryId ?? ''));
    const repo = decoded ? forge.reposById.get(Number(decoded.key)) : undefined;
    if (!repo) throw new Error('the repositoryId does not name a repository');
    const labels: string[] = [];
    if (Array.isArray(input.labelIds)) {
      for (const labelId of input.labelIds) {
        const labelDecoded = decodeNodeId(String(labelId));
        const name = labelDecoded?.key.split(':').slice(1).join(':');
        if (name && repo.labels.has(name)) labels.push(name);
      }
    }
    const rec = createIssueRecord(forge, repo, {
      title: String(input.title ?? ''),
      body: typeof input.body === 'string' ? input.body : null,
      labels,
    });
    return { __typename: 'CreateIssuePayload', clientMutationId: (input.clientMutationId as string) ?? null, issue: issueValue(repo, rec) };
  },
  closeIssue: (_s, args) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const value = nodeForId(String(input.issueId ?? ''));
    if (!value || (value.__typename !== 'Issue' && value.__typename !== 'PullRequest')) throw new Error('the issueId does not name an issue');
    const repo = value.repo as Repo;
    const rec = value.rec as IssueRec;
    if (rec.state !== 'closed') {
      rec.state = 'closed';
      rec.closedAt = nowDate();
      recordIssueEvent(forge, repo, 'closed', rec);
    }
    rec.updatedAt = nowDate();
    return { __typename: 'CloseIssuePayload', clientMutationId: (input.clientMutationId as string) ?? null, issue: issueValue(repo, rec) };
  },
  reopenIssue: (_s, args) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const value = nodeForId(String(input.issueId ?? ''));
    if (!value) throw new Error('the issueId does not name an issue');
    const repo = value.repo as Repo;
    const rec = value.rec as IssueRec;
    if (rec.state !== 'open') {
      rec.state = 'open';
      rec.closedAt = null;
      recordIssueEvent(forge, repo, 'reopened', rec);
    }
    rec.updatedAt = nowDate();
    return { __typename: 'ReopenIssuePayload', clientMutationId: (input.clientMutationId as string) ?? null, issue: issueValue(repo, rec) };
  },
  createPullRequest: (_s, args) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = decodeNodeId(String(input.repositoryId ?? ''));
    const repo = decoded ? forge.reposById.get(Number(decoded.key)) : undefined;
    if (!repo) throw new Error('the repositoryId does not name a repository');
    const head = String(input.headRefName ?? '');
    const base = String(input.baseRefName ?? '');
    if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) {
      throw new Error('the head or base branch does not exist');
    }
    const rec = createPullRecord(forge, repo, {
      title: String(input.title ?? ''),
      body: typeof input.body === 'string' ? input.body : null,
      head,
      base,
    });
    return { __typename: 'CreatePullRequestPayload', clientMutationId: (input.clientMutationId as string) ?? null, pullRequest: prValue(repo, rec) };
  },
  mergePullRequest: (_s, args) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const value = nodeForId(String(input.pullRequestId ?? ''));
    if (!value || value.__typename !== 'PullRequest') throw new Error('the pullRequestId does not name a pull request');
    const repo = value.repo as Repo;
    const rec = value.rec as IssueRec;
    const outcome = mergePull(forge, repo, rec);
    if (!outcome.ok && outcome.reason === 'conflict') throw new Error('the pull request is not mergeable: its branch conflicts with the base');
    return { __typename: 'MergePullRequestPayload', clientMutationId: (input.clientMutationId as string) ?? null, pullRequest: prValue(repo, rec) };
  },
  addComment: (_s, args) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const value = nodeForId(String(input.subjectId ?? ''));
    if (!value || (value.__typename !== 'Issue' && value.__typename !== 'PullRequest')) throw new Error('the subjectId does not name an issue or pull request');
    const repo = value.repo as Repo;
    const rec = value.rec as IssueRec;
    const comment = addCommentRecord(forge, repo, rec, String(input.body ?? ''));
    return {
      __typename: 'AddCommentPayload',
      clientMutationId: (input.clientMutationId as string) ?? null,
      commentEdge: { __typename: 'IssueCommentEdge', __node: commentValue(repo, rec, comment), __cursor: cursorFor(rec.comments.length - 1) },
      subject: value,
    };
  },
  updateIssue: (_s, args) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const value = nodeForId(String(input.id ?? ''));
    if (!value || (value.__typename !== 'Issue' && value.__typename !== 'PullRequest')) throw new Error('the id does not name an issue');
    const repo = value.repo as Repo;
    const rec = value.rec as IssueRec;
    if (typeof input.title === 'string') rec.title = input.title;
    if (typeof input.body === 'string') rec.body = input.body;
    if (Array.isArray(input.labelIds)) {
      const next: string[] = [];
      for (const labelId of input.labelIds) {
        const labelDecoded = decodeNodeId(String(labelId));
        const name = labelDecoded?.key.split(':').slice(1).join(':');
        if (name && repo.labels.has(name) && !next.includes(name)) next.push(name);
      }
      for (const name of next) if (!rec.labels.includes(name)) recordIssueEvent(forge, repo, 'labeled', rec, name);
      for (const name of rec.labels) if (!next.includes(name)) recordIssueEvent(forge, repo, 'unlabeled', rec, name);
      rec.labels = next;
    }
    if (input.state === 'CLOSED' && rec.state !== 'closed') {
      rec.state = 'closed';
      rec.closedAt = nowDate();
      recordIssueEvent(forge, repo, 'closed', rec);
    } else if (input.state === 'OPEN' && rec.state !== 'open') {
      rec.state = 'open';
      rec.closedAt = null;
      recordIssueEvent(forge, repo, 'reopened', rec);
    }
    rec.updatedAt = nowDate();
    return { __typename: 'UpdateIssuePayload', clientMutationId: (input.clientMutationId as string) ?? null, issue: issueValue(repo, rec) };
  },
  closePullRequest: (_s, args) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const value = nodeForId(String(input.pullRequestId ?? ''));
    if (!value || value.__typename !== 'PullRequest') throw new Error('the pullRequestId does not name a pull request');
    const repo = value.repo as Repo;
    const rec = value.rec as IssueRec;
    if (rec.state !== 'closed') {
      rec.state = 'closed';
      rec.closedAt = nowDate();
      recordIssueEvent(forge, repo, 'closed', rec);
    }
    rec.updatedAt = nowDate();
    return { __typename: 'ClosePullRequestPayload', clientMutationId: (input.clientMutationId as string) ?? null, pullRequest: prValue(repo, rec) };
  },
  reopenPullRequest: (_s, args) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const value = nodeForId(String(input.pullRequestId ?? ''));
    if (!value || value.__typename !== 'PullRequest') throw new Error('the pullRequestId does not name a pull request');
    const repo = value.repo as Repo;
    const rec = value.rec as IssueRec;
    if ((rec.pull as IssueRec['pull'])?.merged) throw new Error('the pull request was merged and cannot be reopened');
    if (rec.state !== 'open') {
      rec.state = 'open';
      rec.closedAt = null;
      recordIssueEvent(forge, repo, 'reopened', rec);
    }
    rec.updatedAt = nowDate();
    return { __typename: 'ReopenPullRequestPayload', clientMutationId: (input.clientMutationId as string) ?? null, pullRequest: prValue(repo, rec) };
  },
  addLabelsToLabelable: (_s, args) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const value = nodeForId(String(input.labelableId ?? ''));
    if (!value || (value.__typename !== 'Issue' && value.__typename !== 'PullRequest')) throw new Error('the labelableId does not name an issue or pull request');
    const repo = value.repo as Repo;
    const rec = value.rec as IssueRec;
    if (Array.isArray(input.labelIds)) {
      for (const labelId of input.labelIds) {
        const labelDecoded = decodeNodeId(String(labelId));
        const name = labelDecoded?.key.split(':').slice(1).join(':');
        if (name && repo.labels.has(name) && !rec.labels.includes(name)) {
          rec.labels.push(name);
          recordIssueEvent(forge, repo, 'labeled', rec, name);
        }
      }
    }
    rec.updatedAt = nowDate();
    return { __typename: 'AddLabelsToLabelablePayload', clientMutationId: (input.clientMutationId as string) ?? null, labelable: value };
  },
  removeLabelsFromLabelable: (_s, args) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const value = nodeForId(String(input.labelableId ?? ''));
    if (!value || (value.__typename !== 'Issue' && value.__typename !== 'PullRequest')) throw new Error('the labelableId does not name an issue or pull request');
    const repo = value.repo as Repo;
    const rec = value.rec as IssueRec;
    if (Array.isArray(input.labelIds)) {
      for (const labelId of input.labelIds) {
        const labelDecoded = decodeNodeId(String(labelId));
        const name = labelDecoded?.key.split(':').slice(1).join(':');
        if (name && rec.labels.includes(name)) {
          rec.labels = rec.labels.filter((item) => item !== name);
          recordIssueEvent(forge, repo, 'unlabeled', rec, name);
        }
      }
    }
    rec.updatedAt = nowDate();
    return { __typename: 'RemoveLabelsFromLabelablePayload', clientMutationId: (input.clientMutationId as string) ?? null, labelable: value };
  },
  createRef: (_s, args) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = decodeNodeId(String(input.repositoryId ?? ''));
    const repo = decoded ? forge.reposById.get(Number(decoded.key)) : undefined;
    if (!repo) throw new Error('the repositoryId does not name a repository');
    const name = String(input.name ?? '');
    const oid = String(input.oid ?? '');
    if (!name.startsWith('refs/')) throw new Error('the ref name must be fully qualified');
    if (!repo.objects.has(oid)) throw new Error('the oid does not name an object in the repository');
    if (repo.refs.has(name)) throw new Error('the ref already exists');
    repo.refs.set(name, oid);
    recordRefUpdate(forge, repo, name, ZERO_OID, oid);
    return { __typename: 'CreateRefPayload', clientMutationId: (input.clientMutationId as string) ?? null, ref: refValue(repo, name) };
  },
  deleteRef: (_s, args) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const value = nodeForId(String(input.refId ?? ''));
    if (!value || value.__typename !== 'Ref') throw new Error('the refId does not name a ref');
    const repo = value.repo as Repo;
    const ref = value.ref as string;
    const current = repo.refs.get(ref);
    if (current) {
      repo.refs.delete(ref);
      recordRefUpdate(forge, repo, ref, current, ZERO_OID);
    }
    return { __typename: 'DeleteRefPayload', clientMutationId: (input.clientMutationId as string) ?? null, deletedRefId: String(input.refId) };
  },
  updateIssueComment: (_s, args) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const value = nodeForId(String(input.id ?? ''));
    if (!value || value.__typename !== 'IssueComment') throw new Error('the id does not name a comment');
    const repo = value.repo as Repo;
    const rec = value.rec as IssueRec;
    const comment = value.comment as IssueRec['comments'][number];
    comment.body = String(input.body ?? '');
    comment.updatedAt = nowDate();
    rec.updatedAt = nowDate();
    return { __typename: 'UpdateIssueCommentPayload', clientMutationId: (input.clientMutationId as string) ?? null, issueComment: commentValue(repo, rec, comment) };
  },
  deleteIssueComment: (_s, args) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const value = nodeForId(String(input.id ?? ''));
    if (!value || value.__typename !== 'IssueComment') throw new Error('the id does not name a comment');
    const rec = value.rec as IssueRec;
    const comment = value.comment as IssueRec['comments'][number];
    rec.comments = rec.comments.filter((item) => item.id !== comment.id);
    rec.updatedAt = nowDate();
    return { __typename: 'DeleteIssueCommentPayload', clientMutationId: (input.clientMutationId as string) ?? null, deletedCommentId: String(input.id) };
  },
});

def('User', {
  id: (s) => nodeId('User', s.login as string),
  name: (s) => (s.login === VIEWER_LOGIN ? 'ada iversen' : null),
  email: () => null,
  url: (s) => `/${s.login as string}`,
  avatarUrl: (s) => `https://avatars.githubusercontent.com/u/${s.login === VIEWER_LOGIN ? 1000 : 0}?v=4`,
  databaseId: (s) => (s.login === VIEWER_LOGIN ? 1000 : null),
  createdAt: () => isoOf(new Date('2020-01-01T00:00:00Z')),
  updatedAt: () => isoOf(new Date()),
  isViewer: (s) => s.login === VIEWER_LOGIN,
  bio: () => null,
  location: () => null,
  websiteUrl: () => null,
  repositories: (_s, args) => connectionValue('RepositoryConnection', forge.listRepos().map(repoValue), args as PageArgs),
});

def('Repository', {
  id: (s) => nodeId('Repository', (s.repo as Repo).id),
  databaseId: (s) => (s.repo as Repo).id,
  name: (s) => (s.repo as Repo).name,
  nameWithOwner: (s) => (s.repo as Repo).fullName,
  owner: (s) => userValue((s.repo as Repo).owner),
  description: (s) => (s.repo as Repo).description || null,
  isPrivate: (s) => (s.repo as Repo).isPrivate,
  isEmpty: (s) => (s.repo as Repo).refs.size === 0,
  isFork: () => false,
  isArchived: () => false,
  isTemplate: () => false,
  createdAt: (s) => isoDate((s.repo as Repo).createdAt),
  updatedAt: (s) => isoDate((s.repo as Repo).updatedAt),
  pushedAt: (s) => isoDate((s.repo as Repo).updatedAt),
  url: (s) => `/${(s.repo as Repo).fullName}`,
  sshUrl: (s) => `git@forge.invalid:${(s.repo as Repo).fullName}.git`,
  homepageUrl: () => null,
  defaultBranchRef: (s) => {
    const repo = s.repo as Repo;
    return repo.refs.has(repo.headRef) ? refValue(repo, repo.headRef) : null;
  },
  viewerPermission: () => 'ADMIN',
  viewerCanAdminister: () => true,
  hasIssuesEnabled: () => true,
  hasPullRequestsEnabled: () => true,
  hasWikiEnabled: () => true,
  stargazerCount: () => 0,
  forkCount: () => 0,
  issue: (s, args) => {
    const repo = s.repo as Repo;
    const rec = repo.issues.get(Number(args.number));
    return rec && !rec.pull ? issueValue(repo, rec) : null;
  },
  issues: (s, args) => issueConnection(s.repo as Repo, args),
  pullRequest: (s, args) => {
    const repo = s.repo as Repo;
    const rec = repo.issues.get(Number(args.number));
    return rec?.pull ? prValue(repo, rec) : null;
  },
  pullRequests: (s, args) => prConnection(s.repo as Repo, args),
  release: (s, args) => {
    const repo = s.repo as Repo;
    const release = [...repo.releases.values()].find((item) => item.tagName === String(args.tagName));
    return release ? releaseValue(repo, release) : null;
  },
  releases: (s, args) => {
    const repo = s.repo as Repo;
    const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
    const all = [...repo.releases.values()];
    if (orderBy.field === 'NAME') all.sort((a, b) => (a.tagName < b.tagName ? -1 : 1));
    else all.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id);
    if (orderBy.direction !== 'ASC') all.reverse();
    return connectionValue('ReleaseConnection', all.map((release) => releaseValue(repo, release)), args as PageArgs);
  },
  label: (s, args) => {
    const repo = s.repo as Repo;
    const label = repo.labels.get(String(args.name));
    return label ? labelValue(repo, label) : null;
  },
  labels: (s, args) => labelConnection(s.repo as Repo, [...(s.repo as Repo).labels.values()], args),
  ref: (s, args) => {
    const repo = s.repo as Repo;
    const qualified = String(args.qualifiedName);
    return repo.refs.has(qualified) ? refValue(repo, qualified) : null;
  },
  refs: (s, args) => {
    const repo = s.repo as Repo;
    const prefix = String(args.refPrefix ?? '');
    const names = [...repo.refs.keys()].filter((ref) => ref.startsWith(prefix)).sort();
    return connectionValue('RefConnection', names.map((ref) => refValue(repo, ref)), args as PageArgs);
  },
  object: (s, args) => {
    const repo = s.repo as Repo;
    if (typeof args.oid === 'string' && args.oid) return objectValue(repo, args.oid);
    const expression = String(args.expression ?? '');
    const colon = expression.indexOf(':');
    const refName = colon >= 0 ? expression.slice(0, colon) : expression;
    const path = colon >= 0 ? expression.slice(colon + 1) : '';
    let oid = repo.refs.get(refName) ?? repo.refs.get(`refs/heads/${refName}`) ?? (repo.objects.has(refName) ? refName : null);
    if (!oid) return null;
    const peeled = peelToCommit(repo.objects, oid);
    if (peeled) oid = peeled;
    if (!path) return objectValue(repo, oid);
    const commitObj = repo.objects.get(oid);
    if (!commitObj || commitObj.type !== 'commit') return null;
    let tree: string | null = parseCommit(commitObj.data).tree;
    for (const part of path.split('/').filter(Boolean)) {
      if (!tree) return null;
      const entries = parseTree(repo.objects.get(tree)?.data ?? Buffer.alloc(0));
      const next: { oid: string; mode: string } | undefined = entries.find((entry) => entry.name === part);
      if (!next) return null;
      if (next.mode === '40000') tree = next.oid;
      else return objectValue(repo, next.oid);
    }
    return tree ? objectValue(repo, tree) : null;
  },
});

def('Issue', {
  id: (s) => nodeId('Issue', `${(s.repo as Repo).id}:${(s.rec as IssueRec).number}`),
  databaseId: (s) => (s.rec as IssueRec).id,
  number: (s) => (s.rec as IssueRec).number,
  title: (s) => (s.rec as IssueRec).title,
  body: (s) => (s.rec as IssueRec).body ?? '',
  bodyText: (s) => (s.rec as IssueRec).body ?? '',
  bodyHTML: (s) => (s.rec as IssueRec).body ?? '',
  state: (s) => ((s.rec as IssueRec).state === 'open' ? 'OPEN' : 'CLOSED'),
  stateReason: (s) => ((s.rec as IssueRec).state === 'closed' ? 'COMPLETED' : null),
  locked: () => false,
  closed: (s) => (s.rec as IssueRec).state === 'closed',
  closedAt: (s) => isoDate((s.rec as IssueRec).closedAt),
  createdAt: (s) => isoDate((s.rec as IssueRec).createdAt),
  updatedAt: (s) => isoDate((s.rec as IssueRec).updatedAt),
  publishedAt: (s) => isoDate((s.rec as IssueRec).createdAt),
  url: (s) => `/${(s.repo as Repo).fullName}/issues/${(s.rec as IssueRec).number}`,
  repository: (s) => repoValue(s.repo as Repo),
  author: (s) => userValue((s.rec as IssueRec).userLogin),
  authorAssociation: () => 'OWNER',
  labels: (s, args) => {
    const repo = s.repo as Repo;
    const labels = (s.rec as IssueRec).labels.map((name) => repo.labels.get(name)).filter((label): label is LabelRec => Boolean(label));
    return labelConnection(repo, labels, args);
  },
  comments: (s, args) => {
    const repo = s.repo as Repo;
    const rec = s.rec as IssueRec;
    return connectionValue('IssueCommentConnection', rec.comments.map((comment) => commentValue(repo, rec, comment)), args as PageArgs);
  },
  assignees: (_s, args) => connectionValue('UserConnection', [], args as PageArgs),
});

function prFiles(repo: Repo, rec: IssueRec) {
  if (!rec.pull) return [];
  const plan = planMerge(repo, rec.pull.headRef, rec.pull.baseRef);
  if (!plan.base || !plan.headTip) return [];
  const baseTree = treeOidOf(repo, plan.base);
  const headTree = treeOidOf(repo, plan.headTip);
  return diffTrees(repo.objects, baseTree, headTree);
}

function treeOidOf(repo: Repo, commitOid: string | null): string | null {
  if (!commitOid) return null;
  const object = repo.objects.get(commitOid);
  return object && object.type === 'commit' ? parseCommit(object.data).tree : null;
}

def('PullRequest', {
  id: (s) => nodeId('PullRequest', `${(s.repo as Repo).id}:${(s.rec as IssueRec).number}`),
  databaseId: (s) => (s.rec as IssueRec).id,
  number: (s) => (s.rec as IssueRec).number,
  title: (s) => (s.rec as IssueRec).title,
  body: (s) => (s.rec as IssueRec).body ?? '',
  bodyText: (s) => (s.rec as IssueRec).body ?? '',
  state: (s) => prState(s.rec as IssueRec),
  merged: (s) => Boolean((s.rec as IssueRec).pull?.merged),
  mergedAt: (s) => isoDate((s.rec as IssueRec).pull?.mergedAt ?? null),
  mergedBy: (s) => ((s.rec as IssueRec).pull?.merged ? userValue(VIEWER_LOGIN) : null),
  closed: (s) => (s.rec as IssueRec).state === 'closed',
  closedAt: (s) => isoDate((s.rec as IssueRec).closedAt),
  createdAt: (s) => isoDate((s.rec as IssueRec).createdAt),
  updatedAt: (s) => isoDate((s.rec as IssueRec).updatedAt),
  url: (s) => `/${(s.repo as Repo).fullName}/pull/${(s.rec as IssueRec).number}`,
  author: (s) => userValue((s.rec as IssueRec).userLogin),
  authorAssociation: () => 'OWNER',
  repository: (s) => repoValue(s.repo as Repo),
  baseRepository: (s) => repoValue(s.repo as Repo),
  headRepository: (s) => repoValue(s.repo as Repo),
  baseRefName: (s) => (s.rec as IssueRec).pull?.baseRef ?? '',
  headRefName: (s) => (s.rec as IssueRec).pull?.headRef ?? '',
  baseRef: (s) => {
    const repo = s.repo as Repo;
    const ref = `refs/heads/${(s.rec as IssueRec).pull?.baseRef ?? ''}`;
    return repo.refs.has(ref) ? refValue(repo, ref) : null;
  },
  headRef: (s) => {
    const repo = s.repo as Repo;
    const ref = `refs/heads/${(s.rec as IssueRec).pull?.headRef ?? ''}`;
    return repo.refs.has(ref) ? refValue(repo, ref) : null;
  },
  baseRefOid: (s) => (s.repo as Repo).refs.get(`refs/heads/${(s.rec as IssueRec).pull?.baseRef ?? ''}`) ?? '',
  headRefOid: (s) => (s.repo as Repo).refs.get(`refs/heads/${(s.rec as IssueRec).pull?.headRef ?? ''}`) ?? '',
  mergeable: (s) => {
    const rec = s.rec as IssueRec;
    if (rec.pull?.merged) return 'MERGEABLE';
    return planMerge(s.repo as Repo, rec.pull?.headRef ?? '', rec.pull?.baseRef ?? '').mergeable ? 'MERGEABLE' : 'CONFLICTING';
  },
  mergeStateStatus: (s) => {
    const rec = s.rec as IssueRec;
    if (rec.pull?.merged) return 'CLEAN';
    return planMerge(s.repo as Repo, rec.pull?.headRef ?? '', rec.pull?.baseRef ?? '').mergeable ? 'CLEAN' : 'DIRTY';
  },
  isDraft: () => false,
  additions: (s) => prFiles(s.repo as Repo, s.rec as IssueRec).reduce((sum, file) => sum + file.additions, 0),
  deletions: (s) => prFiles(s.repo as Repo, s.rec as IssueRec).reduce((sum, file) => sum + file.deletions, 0),
  changedFiles: (s) => prFiles(s.repo as Repo, s.rec as IssueRec).length,
  mergeCommit: (s) => {
    const sha = (s.rec as IssueRec).pull?.mergeCommitSha;
    return sha ? commitValue(s.repo as Repo, sha) : null;
  },
  commits: (s, args) => {
    const repo = s.repo as Repo;
    const rec = s.rec as IssueRec;
    const headTip = rec.pull ? repo.refs.get(`refs/heads/${rec.pull.headRef}`) : undefined;
    const baseTip = rec.pull ? repo.refs.get(`refs/heads/${rec.pull.baseRef}`) : undefined;
    if (!headTip) return connectionValue('PullRequestCommitConnection', [], args as PageArgs);
    const baseSet = new Set(baseTip ? repo.listCommits(baseTip, 1000) : []);
    const items = repo
      .listCommits(headTip, 250)
      .filter((oid) => !baseSet.has(oid))
      .map((oid) => ({ __typename: 'PullRequestCommit', repo, oid }));
    return connectionValue('PullRequestCommitConnection', items as Value[], args as PageArgs);
  },
  files: (s, args) => {
    const items = prFiles(s.repo as Repo, s.rec as IssueRec).map((file) => ({
      __typename: 'PullRequestChangedFile',
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
      changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
    }));
    return connectionValue('PullRequestChangedFileConnection', items as Value[], args as PageArgs);
  },
  comments: (s, args) => {
    const repo = s.repo as Repo;
    const rec = s.rec as IssueRec;
    return connectionValue('IssueCommentConnection', rec.comments.map((comment) => commentValue(repo, rec, comment)), args as PageArgs);
  },
  labels: (s, args) => {
    const repo = s.repo as Repo;
    const labels = (s.rec as IssueRec).labels.map((name) => repo.labels.get(name)).filter((label): label is LabelRec => Boolean(label));
    return labelConnection(repo, labels, args);
  },
  assignees: (_s, args) => connectionValue('UserConnection', [], args as PageArgs),
});

def('IssueComment', {
  id: (s) => nodeId('IssueComment', (s.comment as IssueRec['comments'][number]).id),
  databaseId: (s) => (s.comment as IssueRec['comments'][number]).id,
  body: (s) => (s.comment as IssueRec['comments'][number]).body,
  bodyText: (s) => (s.comment as IssueRec['comments'][number]).body,
  createdAt: (s) => isoDate((s.comment as IssueRec['comments'][number]).createdAt),
  updatedAt: (s) => isoDate((s.comment as IssueRec['comments'][number]).updatedAt),
  publishedAt: (s) => isoDate((s.comment as IssueRec['comments'][number]).createdAt),
  author: (s) => userValue((s.comment as IssueRec['comments'][number]).userLogin),
  authorAssociation: () => 'OWNER',
  url: (s) => `/${(s.repo as Repo).fullName}/issues/${(s.rec as IssueRec).number}#issuecomment-${(s.comment as IssueRec['comments'][number]).id}`,
  issue: (s) => issueValue(s.repo as Repo, s.rec as IssueRec),
  pullRequest: (s) => ((s.rec as IssueRec).pull ? prValue(s.repo as Repo, s.rec as IssueRec) : null),
  repository: (s) => repoValue(s.repo as Repo),
});

def('Label', {
  id: (s) => nodeId('Label', `${(s.repo as Repo).id}:${(s.label as LabelRec).name}`),
  name: (s) => (s.label as LabelRec).name,
  color: (s) => (s.label as LabelRec).color,
  description: (s) => (s.label as LabelRec).description,
  isDefault: () => false,
  createdAt: () => isoOf(new Date()),
  updatedAt: () => isoOf(new Date()),
  url: (s) => `/${(s.repo as Repo).fullName}/labels/${encodeURIComponent((s.label as LabelRec).name)}`,
  repository: (s) => repoValue(s.repo as Repo),
});

def('Release', {
  id: (s) => nodeId('Release', (s.release as ReleaseRec).id),
  databaseId: (s) => (s.release as ReleaseRec).id,
  name: (s) => (s.release as ReleaseRec).name,
  tagName: (s) => (s.release as ReleaseRec).tagName,
  targetCommitish: (s) => (s.release as ReleaseRec).targetCommitish,
  isDraft: (s) => (s.release as ReleaseRec).draft,
  isPrerelease: (s) => (s.release as ReleaseRec).prerelease,
  isLatest: (s) => {
    const repo = s.repo as Repo;
    const me = s.release as ReleaseRec;
    if (me.draft || me.prerelease) return false;
    const published = [...repo.releases.values()].filter((item) => !item.draft && !item.prerelease);
    published.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id);
    return published.length > 0 && published[published.length - 1].id === me.id;
  },
  createdAt: (s) => isoDate((s.release as ReleaseRec).createdAt),
  publishedAt: (s) => isoDate((s.release as ReleaseRec).publishedAt),
  updatedAt: (s) => isoDate((s.release as ReleaseRec).publishedAt ?? (s.release as ReleaseRec).createdAt),
  url: (s) => `/${(s.repo as Repo).fullName}/releases/tag/${encodeURIComponent((s.release as ReleaseRec).tagName)}`,
  description: (s) => (s.release as ReleaseRec).body,
  descriptionHTML: (s) => (s.release as ReleaseRec).body ?? '',
  author: (s) => userValue((s.repo as Repo).owner),
  repository: (s) => repoValue(s.repo as Repo),
  tag: (s) => {
    const repo = s.repo as Repo;
    const ref = `refs/tags/${(s.release as ReleaseRec).tagName}`;
    return repo.refs.has(ref) ? refValue(repo, ref) : null;
  },
});

def('Ref', {
  id: (s) => nodeId('Ref', `${(s.repo as Repo).id}:${s.ref as string}`),
  name: (s) => {
    const ref = s.ref as string;
    return ref.startsWith('refs/heads/') ? ref.slice(11) : ref.startsWith('refs/tags/') ? ref.slice(10) : ref;
  },
  prefix: (s) => {
    const ref = s.ref as string;
    return ref.startsWith('refs/heads/') ? 'refs/heads/' : ref.startsWith('refs/tags/') ? 'refs/tags/' : 'refs/';
  },
  qualifiedName: (s) => s.ref as string,
  repository: (s) => repoValue(s.repo as Repo),
  target: (s) => {
    const repo = s.repo as Repo;
    const oid = repo.refs.get(s.ref as string);
    return oid ? objectValue(repo, oid) : null;
  },
});

def('Commit', {
  id: (s) => nodeId('Commit', s.oid as string),
  oid: (s) => s.oid as string,
  abbreviatedOid: (s) => (s.oid as string).slice(0, 7),
  message: (s) => commitOf(s).message,
  messageHeadline: (s) => commitOf(s).message.split('\n')[0],
  messageBody: (s) => commitOf(s).message.split('\n').slice(1).join('\n').trim(),
  committedDate: (s) => isoOf(new Date(commitOf(s).committerEpoch * 1000)),
  authoredDate: (s) => isoOf(new Date(commitOf(s).authorEpoch * 1000)),
  author: (s) => {
    const commit = commitOf(s);
    return actorOf({ name: commit.authorName, email: commit.authorEmail, epoch: commit.authorEpoch });
  },
  committer: (s) => {
    const commit = commitOf(s);
    return actorOf({ name: commit.committerName, email: commit.committerEmail, epoch: commit.committerEpoch });
  },
  tree: (s) => treeValue(s.repo as Repo, commitOf(s).tree),
  treeOid: (s) => commitOf(s).tree,
  parents: (s, args) => {
    const repo = s.repo as Repo;
    return connectionValue('CommitConnection', commitOf(s).parents.map((oid) => commitValue(repo, oid)), args as PageArgs);
  },
  history: (s, args) => {
    const repo = s.repo as Repo;
    let oids = repo.listCommits(s.oid as string, 1000);
    const since = typeof args.since === 'string' ? Date.parse(args.since) / 1000 : null;
    const until = typeof args.until === 'string' ? Date.parse(args.until) / 1000 : null;
    if (since !== null || until !== null) {
      oids = oids.filter((oid) => {
        const object = repo.objects.get(oid);
        if (!object || object.type !== 'commit') return false;
        const epoch = parseCommit(object.data).committerEpoch;
        return (since === null || epoch >= since) && (until === null || epoch <= until);
      });
    }
    if (typeof args.path === 'string' && args.path !== '') {
      // A commit is in a path's history when the path's content differs from its first
      // parent's (or the commit is a root that has the path at all).
      const path = args.path.replace(/^\.\//, '');
      const filesOf = (oid: string): Map<string, string> => {
        const object = repo.objects.get(oid);
        if (!object || object.type !== 'commit') return new Map();
        return flattenTree(repo.objects, parseCommit(object.data).tree);
      };
      oids = oids.filter((oid) => {
        const object = repo.objects.get(oid);
        if (!object || object.type !== 'commit') return false;
        const parents = parseCommit(object.data).parents;
        const mine = filesOf(oid).get(path);
        if (parents.length === 0) return mine !== undefined;
        return mine !== filesOf(parents[0]).get(path);
      });
    }
    return connectionValue('CommitHistoryConnection', oids.map((oid) => commitValue(repo, oid)), args as PageArgs);
  },
  url: (s) => `/${(s.repo as Repo).fullName}/commit/${s.oid as string}`,
  repository: (s) => repoValue(s.repo as Repo),
  additions: (s) => commitDiff(s).additions,
  deletions: (s) => commitDiff(s).deletions,
  changedFiles: (s) => commitDiff(s).changedFiles,
});

function commitOf(s: Value) {
  const repo = s.repo as Repo;
  const object = repo.objects.get(s.oid as string);
  if (!object || object.type !== 'commit') throw new Error('commit not found');
  return parseCommit(object.data);
}

function actorOf(ident: { name: string; email: string; epoch: number }): Value {
  return {
    __typename: 'GitActor',
    name: ident.name,
    email: ident.email,
    date: isoOf(new Date(ident.epoch * 1000)),
  };
}

function commitDiff(s: Value): { additions: number; deletions: number; changedFiles: number } {
  const repo = s.repo as Repo;
  const commit = commitOf(s);
  const parentTree = commit.parents.length ? treeOidOf(repo, commit.parents[0]) : null;
  const files = diffTrees(repo.objects, parentTree, commit.tree);
  return {
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    changedFiles: files.length,
  };
}

def('Tree', {
  id: (s) => nodeId('Tree', s.oid as string),
  oid: (s) => s.oid as string,
  abbreviatedOid: (s) => (s.oid as string).slice(0, 7),
  repository: (s) => repoValue(s.repo as Repo),
  entries: (s) => {
    const repo = s.repo as Repo;
    const object = repo.objects.get(s.oid as string);
    if (!object || object.type !== 'tree') return [];
    return parseTree(object.data).map((entry) => ({
      __typename: 'TreeEntry',
      repo,
      name: entry.name,
      path: entry.name,
      type: entry.mode === '40000' ? 'tree' : 'blob',
      mode: parseInt(entry.mode, 10),
      __objectOid: entry.oid,
    }));
  },
});

def('TreeEntry', {
  object: (s) => objectValue(s.repo as Repo, s.__objectOid as string),
  extension: (s) => {
    const name = s.name as string;
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? name.slice(dot) : '';
  },
});

def('Blob', {
  id: (s) => nodeId('Blob', s.oid as string),
  oid: (s) => s.oid as string,
  abbreviatedOid: (s) => (s.oid as string).slice(0, 7),
  repository: (s) => repoValue(s.repo as Repo),
  byteSize: (s) => (s.repo as Repo).objects.get(s.oid as string)?.data.length ?? 0,
  text: (s) => {
    const data = (s.repo as Repo).objects.get(s.oid as string)?.data;
    return data ? data.toString('utf8') : null;
  },
  isBinary: (s) => {
    const data = (s.repo as Repo).objects.get(s.oid as string)?.data;
    return data ? data.includes(0) : false;
  },
  isTruncated: () => false,
});

def('GitActor', {
  user: (s) => (s.name === 'ada iversen' ? userValue(VIEWER_LOGIN) : null),
  avatarUrl: () => 'https://avatars.githubusercontent.com/u/1000?v=4',
});

def('PullRequestCommit', {
  commit: (s) => commitValue(s.repo as Repo, s.oid as string),
  resourcePath: (s) => `/${(s.repo as Repo).fullName}/pull/0/commits/${s.oid as string}`,
  url: (s) => `/${(s.repo as Repo).fullName}/pull/0/commits/${s.oid as string}`,
});

for (const connectionType of Object.keys(CONNECTION_OF)) {
  def(connectionType, {
    nodes: (s) => s.__nodes as Value[],
    edges: (s) => s.__edges as Value[],
    pageInfo: (s) => s.__pageInfo as Value,
    totalCount: (s) => s.__total as number,
    issueCount: (s) => (s.issueCount as number) ?? 0,
    repositoryCount: (s) => (s.repositoryCount as number) ?? 0,
    userCount: (s) => (s.userCount as number) ?? 0,
    discussionCount: (s) => (s.discussionCount as number) ?? 0,
  });
  const edgeType = connectionType.replace(/Connection$/, 'Edge');
  def(edgeType, {
    node: (s) => s.__node as Value,
    cursor: (s) => s.__cursor as string,
  });
}

// --------------------------------------------------------------------------- introspection

function typeValue(name: string): Value | null {
  const def = SCHEMA[name];
  if (!def) return null;
  return { __typename: '__Type', __name: name, __kind: def.kind, __ref: null };
}

function refTypeValue(ref: TypeRef): Value {
  if (ref.kind === 'named') return typeValue(ref.name) ?? { __typename: '__Type', __name: ref.name, __kind: 'SCALAR', __ref: null };
  return {
    __typename: '__Type',
    __name: null,
    __kind: ref.kind === 'list' ? 'LIST' : 'NON_NULL',
    __ref: ref.of,
  };
}

def('__Type', {
  kind: (s) => s.__kind as string,
  name: (s) => s.__name as string | null,
  description: () => null,
  specifiedByURL: () => null,
  fields: (s) => {
    const def = s.__name ? SCHEMA[s.__name as string] : undefined;
    if (!def?.fields) return null;
    return Object.entries(def.fields).map(([name, field]) => ({
      __typename: '__Field',
      __name: name,
      __typeText: field.type,
      __args: field.args ?? {},
    }));
  },
  inputFields: (s) => {
    const def = s.__name ? SCHEMA[s.__name as string] : undefined;
    if (!def?.inputFields) return null;
    return Object.entries(def.inputFields).map(([name, field]) => ({
      __typename: '__InputValue',
      __name: name,
      __typeText: field.type,
      __default: null,
    }));
  },
  interfaces: () => [],
  enumValues: (s) => {
    const def = s.__name ? SCHEMA[s.__name as string] : undefined;
    if (!def?.values) return null;
    return def.values.map((name) => ({ __typename: '__EnumValue', __name: name }));
  },
  possibleTypes: (s) => {
    const name = s.__name as string;
    if (name === 'Node') return ['Repository', 'Issue', 'PullRequest', 'User', 'IssueComment', 'Label', 'Ref', 'Commit', 'Tree', 'Blob'].map(typeValue);
    if (name === 'GitObject') return ['Commit', 'Tree', 'Blob', 'Tag'].map((t) => typeValue(t) ?? { __typename: '__Type', __name: t, __kind: 'OBJECT', __ref: null });
    if (name === 'Actor' || name === 'RepositoryOwner') return [typeValue('User')];
    if (name === 'SearchResultItem') return ['Issue', 'PullRequest', 'Repository', 'User'].map(typeValue);
    return null;
  },
  ofType: (s) => {
    const ref = s.__ref as TypeRef | null;
    return ref ? refTypeValue(ref) : null;
  },
});

def('__Field', {
  name: (s) => s.__name as string,
  description: () => null,
  args: (s) =>
    Object.entries((s.__args as Record<string, { type: string; default?: unknown }>) ?? {}).map(([name, arg]) => ({
      __typename: '__InputValue',
      __name: name,
      __typeText: arg.type,
      __default: arg.default === undefined ? null : JSON.stringify(arg.default),
    })),
  type: (s) => refTypeValue(typeRef(s.__typeText as string)),
  isDeprecated: () => false,
  deprecationReason: () => null,
});

def('__InputValue', {
  name: (s) => s.__name as string,
  description: () => null,
  type: (s) => refTypeValue(typeRef(s.__typeText as string)),
  defaultValue: (s) => s.__default as string | null,
  isDeprecated: () => false,
  deprecationReason: () => null,
});

def('__EnumValue', {
  name: (s) => s.__name as string,
  description: () => null,
  isDeprecated: () => false,
  deprecationReason: () => null,
});

def('__Schema', {
  types: () => Object.keys(SCHEMA).map((name) => typeValue(name)),
  queryType: () => typeValue('Query'),
  mutationType: () => typeValue('Mutation'),
  subscriptionType: () => null,
  directives: () => [],
});

// --------------------------------------------------------------------------- executor

interface ExecError {
  message: string;
  path?: unknown[];
}

interface Ctx {
  variables: Record<string, unknown>;
  fragments: Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>;
  errors: ExecError[];
}

function fieldDefOf(typeName: string, fieldName: string): FieldDef | null {
  if (fieldName === '__typename') return { type: 'String!' };
  if (typeName === 'Query' && fieldName === '__type') return { type: '__Type', args: { name: { type: 'String!' } } };
  if (typeName === 'Query' && fieldName === '__schema') return { type: '__Schema' };
  return SCHEMA[typeName]?.fields?.[fieldName] ?? null;
}

function executeSelectionSet(typeName: string, source: Value, selections: SelectionNode[], ctx: Ctx, path: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const visit = (selection: SelectionNode, currentType: string, currentSource: Value): void => {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment) {
        const condition = fragment.typeCondition;
        const matches =
          !condition ||
          condition === currentSource.__typename ||
          condition === 'Node' ||
          condition === 'GitObject' ||
          condition === 'Actor' ||
          condition === 'RepositoryOwner' ||
          condition === 'SearchResultItem';
        if (matches) for (const inner of fragment.selectionSet) visit(inner, currentType, currentSource);
      }
      return;
    }
    if (selection.kind === 'inline') {
      const condition = selection.typeCondition;
      const matches =
        !condition ||
        condition === currentSource.__typename ||
        condition === 'Node' ||
        condition === 'GitObject' ||
        condition === 'Actor' ||
        condition === 'RepositoryOwner' ||
        condition === 'SearchResultItem';
      if (matches) for (const inner of selection.selectionSet) visit(inner, currentType, currentSource);
      return;
    }
    const key = selection.alias ?? selection.name;
    const def = fieldDefOf(currentType, selection.name);
    if (!def) {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${currentType}'`, path: [...path, key] });
      out[key] = null;
      return;
    }
    const args: Record<string, unknown> = {};
    for (const [argName, argDef] of Object.entries(def.args ?? {})) {
      if (argDef.default !== undefined) args[argName] = argDef.default;
    }
    for (const [argName, node] of Object.entries(selection.args)) {
      args[argName] = valueOf(node, ctx.variables);
    }
    let raw: unknown;
    try {
      if (selection.name === '__typename') raw = currentSource.__typename;
      else if (selection.name === '__type') raw = typeValue(String(args.name));
      else if (selection.name === '__schema') raw = { __typename: '__Schema' };
      else {
        const resolver = R[currentType]?.[selection.name];
        raw = resolver ? resolver(currentSource, args) : (currentSource as Record<string, unknown>)[selection.name];
      }
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err), path: [...path, key] });
      out[key] = null;
      return;
    }
    out[key] = completeValue(typeRef(def.type), raw, selection.selectionSet, ctx, [...path, key]);
  };
  for (const selection of selections) visit(selection, typeName, source);
  return out;
}

function completeValue(ref: TypeRef, value: unknown, selectionSet: SelectionNode[] | null, ctx: Ctx, path: unknown[]): unknown {
  if (ref.kind === 'nonNull') return completeValue(ref.of, value, selectionSet, ctx, path);
  if (value === null || value === undefined) return null;
  if (ref.kind === 'list') {
    const items = Array.isArray(value) ? value : [value];
    return items.map((item, index) => completeValue(ref.of, item, selectionSet, ctx, [...path, index]));
  }
  const def = SCHEMA[ref.name];
  if (!def || def.kind === 'SCALAR' || def.kind === 'ENUM') {
    return ref.name === 'ID' || ref.name === 'GitObjectID' ? String(value) : value;
  }
  const objectValue = value as Value;
  const typeName = objectValue.__typename ?? ref.name;
  if (!selectionSet) return {};
  return executeSelectionSet(typeName, objectValue, selectionSet, ctx, path);
}

// --------------------------------------------------------------------------- HTTP surface

export interface GraphQLResult {
  data?: unknown;
  errors?: ExecError[];
}

function runOperation(queryText: string, variables: Record<string, unknown>, operationName: string | null, onlyOperation?: number): GraphQLResult[] {
  const document = parseGraphQL(queryText);
  const operations = document.operations;
  const chosen =
    onlyOperation !== undefined
      ? [operations[onlyOperation]].filter(Boolean)
      : operationName
        ? operations.filter((op) => op.name === operationName)
        : operations;
  return chosen.map((op) => {
    const ctx: Ctx = { variables, fragments: document.fragments, errors: [] };
    const rootType = op.type === 'mutation' ? 'Mutation' : 'Query';
    const root: Value = { __typename: rootType };
    const data = executeSelectionSet(rootType, root, op.selectionSet, ctx, []);
    const result: GraphQLResult = { data };
    if (ctx.errors.length) result.errors = ctx.errors;
    return result;
  });
}

/** Handle one POST /api/graphql body (single operation object or a batch array). */
export function handleGraphQL(body: unknown): unknown {
  if (Array.isArray(body)) {
    const out: unknown[] = [];
    for (const item of body) {
      const results = runOne(item);
      if (Array.isArray(results)) out.push(...results);
      else out.push(results);
    }
    return out;
  }
  return runOne(body);
}

function runOne(item: unknown): unknown {
  if (!item || typeof item !== 'object') return { errors: [{ message: 'the request body must be an object with a query' }] };
  const record = item as Record<string, unknown>;
  const query = typeof record.query === 'string' ? record.query : '';
  const variables = (record.variables && typeof record.variables === 'object' ? record.variables : {}) as Record<string, unknown>;
  const operationName = typeof record.operationName === 'string' ? record.operationName : null;
  if (!query) return { errors: [{ message: 'the request body must carry a query string' }] };
  try {
    const results = runOperation(query, variables, operationName);
    if (results.length === 1 && !operationName) {
      // A single-operation document answers a single result object; several operations in one
      // document answer one result per operation, in order.
      const document = parseGraphQL(query);
      if (document.operations.length <= 1) return results[0];
      return results;
    }
    if (results.length === 1) return results[0];
    return results;
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}
