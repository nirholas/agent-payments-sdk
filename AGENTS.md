# AGENTS.md

Operating notes for AI coding agents (Claude Code, Codex, Cursor, Copilot and others) working in this repository. Everything here is derived from the files actually in the tree, so trust it over guesses, and update it when the facts change.

## What this repository is

TypeScript SDK for Pump Agent Payments. Owned by [@pump-fun](https://github.com/pump-fun), published as a restricted (private) npm package.

- Homepage: https://nirholas.github.io/agent-payments-sdk/
- Source: https://github.com/nirholas/agent-payments-sdk
- Primary language: TypeScript
- License: Other (see the LICENSE file)

## Repository layout

- `agent-prompts/`
- `coin-fees/`
- `create-coin/`
- `create-usdc-coin/`
- `docs/`
- `pump-public-docs/`
- `scripts/`
- `src/`
- `swap/`
- `tokenized-agents/`
- `vendor/`
- `README.md`
- `LICENSE`
- `package.json`

## Setup

```bash
npm install
```

## Commands

| Task | Command |
|---|---|
| dev | `npm run dev` |
| build | `npm run build` |
| test | `npm test` |
| typecheck | `npm run typecheck` |

Run the test and lint commands above before you consider a change finished. If a command fails on code you did not touch, say so in your report instead of silently skipping it.

## Conventions

- TypeScript runs in strict mode; do not loosen `tsconfig.json` to make an error go away.
- `.env` files are gitignored; never commit credentials, and read configuration from environment variables.
- Commit messages follow Conventional Commits (`type(scope): summary`), matching the existing history.
- Read the surrounding code before adding to it, and match its naming, file organisation and error-handling style.
- Keep `README.md` accurate: if a change alters behaviour, commands or configuration, update the docs in the same commit.
- Do not leave TODO comments, stub functions, placeholder data or commented-out code behind. Finish what you start or leave it out.
- Small, focused commits with a subject line that describes the change, not the act of committing.

## Where to raise things

- Bugs and feature requests: https://github.com/nirholas/agent-payments-sdk/issues
- Questions and ideas: https://github.com/nirholas/agent-payments-sdk/discussions
- Security issues: report privately at https://github.com/nirholas/agent-payments-sdk/security/advisories/new, never in a public issue.
