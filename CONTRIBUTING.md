# Contributing to RelayCore

## Local checks

Before opening a pull request, run:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

## Contribution rules

- Keep changes focused and covered by tests.
- Do not access `process.env` outside `src/config/env.ts`.
- Update documentation when behavior or configuration changes.
