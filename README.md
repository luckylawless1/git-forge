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

## Run it

```sh
node main.ts
```

The process binds an ephemeral port, registers it with the harness at `$MAKEFUN_ENV_URL`, serves
until the harness reports the trial is done, and exits 0. Node 22.18 or later runs the TypeScript
sources directly; there is nothing to install.

---

Entered on [make.fun](https://make.fun/?ref=sv4ravjn&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards
