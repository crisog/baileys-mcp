# baileys-mcp development guide

This file is for coding agents. `README.md` is for people running the server.

## Project

baileys-mcp is an MCP server that gives AI agents access to one WhatsApp account through Baileys. Clients connect over Streamable HTTP at `/mcp`. The server runs as one long-lived process, because a second Baileys connection with the same credentials disconnects the first.

- `SPEC.md` defines the tools, their schemas, and the server behavior behind them. Read it before you add or change a tool, and cite its `REQ-*` IDs in the change.
- Build the server and its tools with `@modelcontextprotocol/sdk`, and define every tool's input and output schema with `zod`.
- Node runs the TypeScript in `src` directly through its built-in type stripping, so there is no build step and no `dist`.

## Environment

Node and npm are pinned, and `.npmrc` sets `engine-strict`, so run `nvm use` before `npm ci` or any script.

## Checks

`npm run verify` is the complete gate: formatting, lint, typecheck, unused code, and the production dependency audit. CI runs the same command. The pre-commit hook runs lint-staged on the staged files.

Fix a failing check at its cause. Change a rule in `oxlint.config.ts` only when the rule itself is wrong for this project.

## Code

- Keep TypeScript strict. Type untrusted data as `unknown` and parse it with a `zod` schema at the boundary, including environment variables.
- Keep module imports free of side effects. Open network connections, including the Baileys socket, from `src/main.ts`.
- Never commit `.env` files, WhatsApp authentication state, or tokens. Never log credentials or message content.

Use Conventional Commits for commit subjects.
