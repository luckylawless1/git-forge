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

## Run it

```sh
node main.ts
```

The process binds an ephemeral port, registers it with the harness at `$MAKEFUN_ENV_URL`, serves
until the harness reports the trial is done, and exits 0. Node 22.18 or later runs the TypeScript
sources directly; there is nothing to install.

---

Entered on [make.fun](https://make.fun/?ref=sv4ravjn&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards
