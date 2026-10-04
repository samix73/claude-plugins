# samix-plugins

A Claude Code plugin marketplace.

## Install

```
claude plugin marketplace add samix73/claude-plugins
claude plugin install pr-review-guide@samix-plugins
```

Run `/reload-plugins` or start a new session to load it.

## Plugins

### pr-review-guide

Guided PR review. It groups a diff into related hunks and adds notes on how to review each one. The guide opens in a pane in Claude Code.

Usage:

```
/guided-pr-review [number|url]
/guided-pr-review local [base]
```

- `[number|url]`: review a GitHub PR. This needs the `gh` CLI. Without an argument, it uses the PR of the current branch.
- `local [base]`: review your local changes against `base`. The diff includes staged and unstaged changes to tracked files and the commits on your branch. Untracked files are not included. If you give no `base`, the plugin tries `origin/HEAD`, `origin/main`, `origin/master`, `main`, then `master`.

Press `Esc` or choose **Close** to close the pane.

## Update

```
claude plugin marketplace update samix-plugins
```

Then run `/reload-plugins`.
