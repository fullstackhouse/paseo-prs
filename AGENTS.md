# paseo-prs

Paseo plugin: composer pills per agent for the PRs on its branch; Create PR when none.

## Layout

- `shared/prs.ts`: Zod schemas, the `prs.list` RPC, `parsePrs` (gh JSON → `Pr`), `summarizeChecks` (CheckRun + StatusContext rollup), `visiblePrs` (open, else latest closed/merged), `pillsFor` (pure: branch → pill specs), agent prompts. All logic worth testing lives here.
- `server/github.ts`: `readBranch(cwd)` via `git` + `gh pr list --head`; `BranchCache` (per cwd, 30 s TTL, `force` bypass, errors logged and treated as "no branch").
- `client/pills.ts`: subscribes to agents, keeps pills keyed by spec key in sync (`update` in place, `remove` gone ones). Forced refresh when an agent goes running → idle; 60 s poll otherwise. Prompt buttons are disabled while the agent runs (`send()` interrupts a turn).

## Load-bearing facts (Paseo 0.12)

- Composer pills are imperative registrations from the client entry, not components; `client.rpc` is available there.
- Pill menus are flat here: nested menus in a menu item are untested on the host.
- `tsconfig.json` needs `"react-native"` in `types` for `setInterval`/`AbortController`/`console` in a `.ts` client file.
- The plugin subprocess may lack the shell PATH; `server/github.ts` appends Homebrew paths.

## Commands

- `npm run typecheck`, `npm test`.
- After edits: `paseo plugin reload paseo-prs`, then `paseo plugin ls` must say `running`; logs via `paseo plugin logs paseo-prs`. Never restart the daemon.
