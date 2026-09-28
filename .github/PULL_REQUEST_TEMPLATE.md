## What this changes

<!-- What changed in the product, and why. Link the issue it closes, if there is one. -->

## How it was tested

<!-- Which checks you ran, and anything you exercised by hand. If it touches generation, say whether you tested
     against a real provider or AI_MOCK_MODE. -->

## Upgrade notes

<!-- Anything a self-hoster has to do: a new or changed environment variable, a database migration, a re-login, a
     re-export. Write "None" if there are none. -->

## Checklist

- [ ] Commits are signed off (`git commit -s`) — see the Developer Certificate of Origin section in `CONTRIBUTING.md`
- [ ] Tests and typecheck pass: `bun test packages apps/api apps/worker apps/web` and
      `bunx tsc -p tsconfig.json --noEmit && bunx tsc -p apps/web/tsconfig.json --noEmit`
- [ ] `bunx biome check .` is clean
- [ ] Tests cover the change, or there is a reason below why they do not
- [ ] A schema change includes a generated migration, and a prompt change bumps the template version
- [ ] An MCP tool change regenerates `docs/MCP_TOOLS.md` (`bun scripts/mcp-docs.ts`)
- [ ] Documentation in `docs/` and `.env.example` updated if the change is visible to an operator
- [ ] The invariants in `AGENTS.md` still hold
