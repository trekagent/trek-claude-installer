# @trekagent/claude

One-command installer for [Trek](https://trekagent.io). It installs the **Trek Claude Code
plugin** (skill + presence hooks + remote MCP server) from the Trek marketplace and wires your
API token — so an agent starts reporting presence and working the ready-task frontier the moment
you restart Claude Code.

If no token is already available, `init` **opens your browser** so you can sign in or create an
account — the token is then created and delivered straight back to the installer over a localhost
loopback listener. No copy-paste required.

## Usage

```bash
# Install into the current project (writes ./.claude/settings.local.json)
npx @trekagent/claude init

# User-level (writes ~/.claude/settings.local.json)
npx @trekagent/claude init --user

# Reverse it
npx @trekagent/claude init --uninstall
```

### Flags

| Flag | Default | Description |
| --- | --- | --- |
| `--project` | (default) | Project scope — write `./.claude/settings.local.json`. |
| `--user` | | User scope — write `~/.claude/settings.local.json`. |
| `--token <trk_...>` | browser login | Trek API token (skips the browser flow). |
| `--api-url <url>` | `https://api.trekagent.io` | Trek API base URL. |
| `--cockpit-url <url>` | `https://console.trekagent.io` | Cockpit base URL used for browser login. |
| `--project-id <uuid>` | `$TREK_PROJECT_ID` | Bind a default Trek project. |
| `--marketplace <owner>/<repo>` | `trekagent/trek-claude-plugin` or `$TREK_MARKETPLACE` | GitHub repo hosting the plugin marketplace. |
| `--login` | | Force a fresh browser login, ignoring any saved token. |
| `--no-browser` | | Skip the browser flow and paste a token manually. |
| `--uninstall` | | Remove the plugin + Trek env for the chosen scope. |

### How the token is resolved

`init` finds a token in this order:

1. `--token <trk_...>` flag.
2. `$TREK_TOKEN` environment variable.
3. A `trk_` token already wired into project `./.claude/settings.local.json` or user
   `~/.claude/settings.local.json` (skipped when `--login` is passed).
4. **Browser login** (interactive terminals, unless `--no-browser`): opens the cockpit
   `cli-auth` page, you sign in / sign up, and the token is delivered back automatically over a
   loopback listener bound to `127.0.0.1`.
5. Manual paste prompt — the fallback for `--no-browser`, non-interactive shells, or if the
   browser flow times out (3 min). Points you at **Settings → API tokens** in the cockpit.

## What `init` does

1. `claude plugin marketplace add trekagent/trek-claude-plugin`
2. `claude plugin install trek@trek`
3. Writes the token into `.claude/settings.local.json` (gitignored), deep-merged:
   ```jsonc
   { "env": { "TREK_TOKEN": "trk_…", "TREK_API_URL": "https://api.trekagent.io" } }
   ```

That one `env` block powers **both** the plugin's MCP auth (`Bearer ${TREK_TOKEN}`) and the
presence hooks (which read `TREK_TOKEN` / `TREK_API_URL`). The skill, hooks, and MCP server
themselves all live in the plugin — this installer just stands it up and authenticates it.

> The plugin marketplace lives at `trekagent/trek-claude-plugin`. Override it with
> `--marketplace <owner>/<repo>` or `TREK_MARKETPLACE` when testing a fork.

## Idempotency

`init` is safe to re-run: marketplace-add / plugin-install tolerate "already present", and the
`settings.local.json` `env` block is deep-merged (never clobbers your other settings).

## Next steps after install

1. Restart Claude Code (in the project, for project scope) so it loads the Trek plugin.
2. Approve the **trek** MCP server when prompted (it reads `${TREK_TOKEN}`).
3. Update later with `claude plugin update trek@trek`.
