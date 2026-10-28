PRs shows the pull requests related to a workspace as a pill in each agent's composer, so you can see whether checks pass or a review is waiting without leaving the chat.

## What counts as related

- The PRs on the workspace's branch: every open one, or with none open, the latest merged or closed one.
- The open PRs stacked with the branch's, found on their own: the PR it is based on, that one's base PR and so on down to the default branch, plus every PR built on top of it. A workspace anywhere in a 29-PR stack shows all 29 without linking anything.
- PRs linked to the workspace, from any repository, for anything else that belongs with the work.

Link a PR from the pill's popover (a PR URL, `owner/repo#123`, or `#123` in the workspace's repository), with `/link-pr <url or #123>` in the composer, or let the agent do it: agents get `prs_link`, `prs_unlink` and `prs_list` tools, allowed without a permission prompt. Unlink with the × on a row. PRs on the branch or in its stack need no linking.

## What the pill shows

- One PR: `#123 · 2 failing`, `#123 · changes requested`, `#123 · draft`, `#123 · checks running`, `#123 · approved`, `#123 · checks pass`, `#123 · merged`. The most urgent state wins.
- Several: `PRs · 29 · 2 failing`.
- A feature branch with commits and no PR gets **Create PR**. The default branch, a detached HEAD, or a branch with nothing to propose gets no pill until a PR is linked.

Pressing the pill opens a list: number, title, checks and review state per PR, open ones first. A row opens the PR on GitHub. **Fix** and **Address** ask the agent to fix failing checks or address a review; they, and **Ask agent to open a PR**, are disabled while the agent is working, since a new prompt would interrupt its turn.

## Setup

Needs `git` and the GitHub CLI (`gh`), signed in, on the daemon machine. Only GitHub is supported.

## Limits

- Status refreshes when an agent finishes a turn and otherwise about once a minute. Linked PRs are read in one GitHub GraphQL call per refresh, however many there are.
- A branch is matched by name, so a PR from a fork with the same branch name also shows up.
- Links are stored per workspace in `~/.paseo/plugin-data/prs/links.json` on the daemon machine. Agents created before the plugin was installed do not have the tools; use the popover or `/link-pr`.
