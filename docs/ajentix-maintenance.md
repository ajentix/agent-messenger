# ajentix organization fork maintenance

This repository is the organization-owned integration fork for `agent-messenger`.

- Fork: https://github.com/ajentix/agent-messenger
- Upstream: https://github.com/agent-messenger/agent-messenger
- `upstream-main` follows upstream `main` with fast-forward updates.
- `main` contains upstream updates that pass the fork test suite and organization changes that are safe to publish.

Keep personal authentication, Teams messages, customer data, send ledgers and environment values outside this public repository. Keep reusable code, tests and documentation here.

## Updating upstream

```bash
git fetch upstream
git switch upstream-main
git merge --ff-only upstream/main
git push origin upstream-main
git switch main
git merge --no-ff upstream-main
npm ci --ignore-scripts --omit=optional --no-audit --no-fund
npm test
git push origin main
```

General fixes should continue to the upstream project through an existing or new pull request. Workbench-specific approval, identity and send-ledger behavior stays in the Workbench wrapper.
