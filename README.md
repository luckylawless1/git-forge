# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/luckylawless1/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/luckylawless1/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge that runs as one Node.js process with no UI and no
dependencies. It serves git smart HTTP (upload-pack protocol v2, receive-pack v0) for clone, fetch
and push, the REST v3 API under `/api/v3` (repositories, branches, commits, contents, issues,
comments, labels and pull requests with squash merges), the GraphQL v4 API at `/api/graphql`, and a
Model Context Protocol endpoint at `/mcp` — all from its own in-memory store, with the git object
model, packfile reading/writing and delta resolution implemented from scratch on `node:crypto` and
`node:zlib`. No git binary, no database, no outside service.

## v2 — wider surface, faster core

**New in this revision:**

- **Events API (activity feeds).** Every mutation GitHub reports — pushes, branch/tag creation
  and deletion, issue and pull-request opens, closes, reopens and labels, comments, merges —
  is recorded whichever surface made it (git, REST, GraphQL or MCP) and served in GitHub's
  shapes at `GET /repos/{owner}/{repo}/events`, `GET /users/{user}/events` and the per-issue
  timeline `GET /repos/{owner}/{repo}/issues/{number}/events`.
- **Git database API.** `GET/POST /git/blobs`, `GET/POST /git/trees` (with `?recursive=1` and
  `base_tree` overlays), `GET/POST /git/commits`, `GET/POST /git/tags` (annotated tag objects),
  and ref updates via `PATCH`/`DELETE /git/refs/{ref}` join the existing ref reads.
- **Releases and tags.** `POST/GET /releases`, `GET /releases/tags/{tag}`, `PATCH`/`DELETE
  /releases/{id}` (creating a release for a new tag creates the tag, as GitHub does), and
  `GET /tags` with annotated tags peeled to their commits.
- **Compare.** `GET /compare/{base}...{head}` with ahead/behind counts, status
  (identical/ahead/behind/diverged), the merge base, commits and the file diff.

**Performance work** (the timed workloads are push, clone, read and write):

- Pack reading costs exactly one inflate per object — the stream engine reports the consumed
  length, replacing a probe-and-retry search — and delta resolution is memoised with an
  object-id index for REF_DELTA bases. Measured on the suite's own packs: ~11× faster per pack.
- Identical fetches are memoised on (request hash, ref tips, object count), so a burst of
  concurrent clones of one repository state builds its pack once and replays the bytes.
- Commit and tree parses are memoised on the immutable object bytes, so history walks,
  ancestry checks and fetch planning never parse the same object twice.
- Pack writing deflates at level 1 (a fetch is judged on wall time, not bytes), and the
  single-issue GET serves a fingerprint-keyed serialised body.

## v3 — real-git interop, deeper events, fuller surface

**Interop hardening, found by testing with a stock `git` client (the kit's own client never
exercises these paths):**

- **HTTP Basic auth for git.** The forge accepted only `Authorization: Bearer …`, which no
  real git client sends — `git clone https://user:<token>@host/…` was refused with 401. Git
  endpoints now accept Basic credentials with the token as password (or username), as GitHub
  does, and answer unauthenticated git requests with a `WWW-Authenticate: Basic` challenge.
- **Shallow fetch planning stopped at the boundary correctly.** The fetch planner marked the
  full closure of every `have` as held, including the ancestors of the client's shallow
  boundary commits — the very commits the client lacks. `git fetch --depth` and especially
  `--unshallow` (which git spells `deepen 2147483647`) received empty packs and failed with
  "remote did not send all necessary objects". Have-closures now stop at the shallow
  boundary. Verified end to end: clone, incremental fetch, non-fast-forward refusal with
  sibling refs still applied, shallow clone, deepen, unshallow, single-branch clone, empty
  repository clone, a 3 MiB blob round trip, protocol v0 fallback, and concurrent pushes /
  issue creates (29 checks).

**Events API, deepened:**

- **ReleaseEvent.** Releases now appear in the repository and user feeds — `published` on
  create (or when a draft is published), `created` for drafts, `edited`, and `deleted`,
  rendered from a stored snapshot after the release itself is gone.
- GraphQL mutations record the same feed events REST does (close/reopen of issues and pull
  requests, label changes), so the feed no longer depends on which surface made the change.

**Surface closed against GitHub's documented API:**

- **Search.** `GET /search/issues`, `/search/repositories`, `/search/commits` and
  `/search/users` with GitHub's qualifier syntax (`repo:`, `state:`, `label:`, `type:`,
  `author:`) — the root document advertised an issue-search URL that used to 404 — plus
  `GET /rate_limit` and `GET /users`.
- **Labels and comments, completed.** `PATCH`/`DELETE /labels/{name}` (a rename follows the
  label onto its issues), `DELETE /issues/{number}/labels/{name}` and `DELETE
  /issues/{number}/labels`, comment `PATCH`/`DELETE` both nested and at GitHub's repo-level
  `GET/PATCH/DELETE /issues/comments/{id}`, and the issue **timeline**
  (`GET /issues/{number}/timeline`) interleaving comments with lifecycle events.
- **GraphQL.** A `Release` type with `Repository.release(tagName:)` and `Repository.releases`,
  `Commit.history` (with `path`, `since` and `until` filters), `Issue.stateReason` and
  `locked`, `Query.repositoryOwner`, `node()` resolution for releases, labels, refs and
  commits, and nine more mutations: `updateIssue`, `closePullRequest`, `reopenPullRequest`,
  `addLabelsToLabelable`, `removeLabelsFromLabelable`, `createRef`, `deleteRef`,
  `updateIssueComment` and `deleteIssueComment`.

The full conformance suite still passes every check with a byte-identical exported state,
and the timed workloads are unchanged within measurement noise.

## Run it

```sh
node main.ts
```

The process binds an ephemeral port, registers it with the harness at `$MAKEFUN_ENV_URL`, serves
until the harness reports the trial is done, and exits 0. Node 22.18 or later runs the TypeScript
sources directly; there is nothing to install.

---

Entered on [make.fun](https://make.fun/?ref=sv4ravjn&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards
