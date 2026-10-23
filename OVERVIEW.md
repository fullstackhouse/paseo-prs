PRs shows the pull requests for an agent's branch as pills in its composer, so you can see whether checks pass or a review is waiting without leaving the chat.

## What the pills show

- One pill per open PR on the agent's branch: `#123 · 2 failing`, `#123 · changes requested`, `#123 · draft`, `#123 · checks running`, `#123 · approved`, `#123 · checks pass`. The most urgent state wins.
- With no open PR, the latest merged or closed one: `#123 · merged`.
- More than three open PRs collapse into one `4 PRs · 1 failing` pill that lists them.
- A feature branch with commits but no PR gets **Create PR**, which asks the agent to open one. The default branch, a detached HEAD, or a branch with nothing to propose gets no pill.

Pressing a PR pill opens a menu: open it on GitHub, and, when they apply, ask the agent to fix failing checks or address the review. Buttons that prompt the agent are disabled while it is working, since a new prompt would interrupt its turn.

## Setup

Needs `git` and the GitHub CLI (`gh`), signed in, on the daemon machine. PRs are found with `gh pr list --head <branch>` in the agent's working directory, so only GitHub remotes are supported.

## Limits

- Status refreshes when an agent finishes a turn and otherwise about once a minute.
- A branch is matched by name, so a PR from a fork with the same branch name also shows up.
- Nothing is stored; the plugin only reads git and GitHub through `gh`.
