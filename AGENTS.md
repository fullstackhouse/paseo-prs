# paseo-prs

Paseo plugin: one composer pill per agent for the PRs related to its workspace (branch PRs ∪ their stack ∪ linked PRs); Create PR when none.

## Layout

- `shared/prs.ts`: Zod schemas, RPCs (`prs.list`, `prs.link`, `prs.unlink`), `parsePrs` (gh JSON → `Pr`), `summarizeChecks`, `parsePrRef` (URL / `o/r#1` / `#1`), `parseRemote`, `stackOf` (base/head walk down and up), `relatedPrs` (merge by URL), `pillFor` (pure: branch + linked → one pill spec), `rowDetail`, agent prompts. All logic worth testing lives here or in pure server modules.
- `server/github.ts`: `readBranch(cwd)` via `git` + `gh pr list --head`, and the stack from one `gh pr list --state open` (number/head/base only) + one GraphQL batch; `BranchCache` (per cwd, 30 s TTL); `PrCache` (linked PRs by URL, 30 s TTL, fetches only stale ones). `server/graphql.ts`: one aliased `gh api graphql` query for any number of PRs across repos.
- `server/store.ts`: `LinkStore`, `links.json` in `~/.paseo/plugin-data/prs` (`PASEO_PRS_DIR` overrides). `server/links.ts`: link/unlink/list shared by RPCs and MCP; links only PRs GitHub returns, under GitHub's repo spelling.
- `server/fork.ts`: `forkIntoPr` (agent create with `worktree: checkout-pr`, source config, `github_pr` + `chat_history` attachments, labels `prs.forkedFrom`/`prs.pr`, no `parent`); `chatHistoryText` rebuilds core's chat history from the timeline because `buildAgentForkContext` is not on the plugin SDK's `PaseoApi`. `shared/prs.ts` `prAgentFor` (Open instead of a duplicate fork) and `canFork`.
- `server/reports.ts`: a fork's report to its main chat. `Reports.start` (the Done button, RPC `prs.report`) records a pending report with the prompt it sends; `turnEnded` refetches the fork's timeline and forwards `replyTo` (the reply after that prompt, since it was sent) via `send(…, { sourceAgentId, activeTurnBehavior: "steer" })`. Nothing else messages the main agent. `ReportStore`: `reports.json`, exposed by `prs.reports`. `shared/prs.ts`: `reportPrompt`, `reportMessage`, `reportPillFor`, `reportButton`. `client/ReportPopover.tsx`: the fork's popover.
- `server/bridge.ts` + `server/listener.ts` (copied from paseo-asks): stdio MCP script → localhost HTTP. `server/tools.ts`: `prs_link`/`prs_unlink`/`prs_list`, `pickCaller` (Codex has no `PASEO_AGENT_ID`), permission matcher.
- `client/pills.ts`: subscribes to agents, one pill per agent (`update` only the face; a new `behavior` closes an open popover). Forced refresh when an agent goes running → idle; 60 s poll otherwise. `client/PrsPopover.tsx`: the list, link field, unlink ×, prompt buttons (disabled while the agent runs; `send()` interrupts a turn). `client/OpenAgentScreen.tsx`: popovers get no `navigation`, so Open/Fork go through this screen, which calls `navigation.openAgent`. `index.client.tsx`: `/link-pr`, the screen.

## Load-bearing facts (Paseo 0.12)

- Composer pills are imperative registrations from the client entry, not components; `client.rpc` is available there. Popover content gets no `navigation`.
- Menus can't hold inputs, hence the popover.
- `tsconfig.json` needs `"react-native"` in `types` for `setInterval`/`AbortController`/`console` in a `.ts` client file.
- The plugin subprocess may lack the shell PATH; `server/github.ts` appends Homebrew paths.
- MCP tools are injected in `before("agent.create")` with `toolPolicy.preapproved`; plan mode and Codex still prompt, so `agent.permission_requested` allows `mcp__prs__*`.
- checkout-pr worktrees get a local branch that may differ from the PR head (`feat/x-1` tracking `origin/feat/x`); `readBranch` lists PRs by the upstream branch.
- Fork with the resolved model (`runtimeInfo.model`, e.g. `claude-haiku-5-5`), not the snapshot's alias (`haiku`), or the new agent loses its thinking options.
- Agent-to-agent messages are core's: a plugin `send` with `sourceAgentId` gets the same envelope and queue as `send_agent_prompt`. Omitting `activeTurnBehavior` interrupts a running turn. Forks have no `parent`: core would report every finished turn of a child to it.
- `agent.turn_ended` can arrive with an empty `timeline`, even for the turn that answered; refetch the timeline, and match the reply to the prompt and its send time (an identical earlier prompt has a stale reply).
- `gh api graphql` exits non-zero when one alias fails (deleted PR) but prints the rest; use its stdout.

## Commands

- `npm run typecheck`, `npm test`.
- After edits: `paseo plugin reload paseo-prs`, then `paseo plugin ls` must say `running`; logs via `paseo plugin logs paseo-prs`. Never restart the daemon.
- UI check without the daemon password: run a sandbox daemon (`paseo daemon run --home /tmp/x`, `config.json` with `pluginsEnabled: true` and `daemon.cors.allowedOrigins: ["http://127.0.0.1:6767"]`), install the plugin with `--home`, then direct-connect the web app at `http://127.0.0.1:6767` to it.
