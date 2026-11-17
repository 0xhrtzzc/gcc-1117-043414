# gcc-1117-043414

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/0xhrtzzc/gcc-1117-043414/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/0xhrtzzc/gcc-1117-043414/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node 22 process and no dependencies: git smart HTTP
(upload-pack protocol v2 and receive-pack v0, packs spoken by hand), the REST v3 API under /api/v3,
GraphQL v4 at /api/graphql and a Model Context Protocol endpoint at /mcp, all served from its own
in-memory store with no git binary and no outside service.

## Run it

```sh
MAKEFUN_ENV_URL=http://store:8080 MAKEFUN_SHOP_TOKEN=<the trial's token> node main.ts
```

The program binds an ephemeral port, POSTs `{"port": <n>}` to `$MAKEFUN_ENV_URL/register`, then polls
`GET $MAKEFUN_ENV_URL/done` and exits 0 when the trial is over. Set `MAKEFUN_PORT` instead to serve on
a fixed port without an env (a local run).

---

<sub>Entered on [make.fun](https://make.fun/?ref=bcem1q6j&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
