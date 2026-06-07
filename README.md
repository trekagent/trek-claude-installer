# @trek/claude

One-command installer for [Trek](https://trekagent.io). It installs the **Trek Claude Code
plugin** (skill + presence hooks + remote MCP server) from the Trek marketplace and wires your
API token — so an agent starts reporting presence and working the ready-task frontier the moment
you restart Claude Code.

## Usage

```bash
# Install into the current project (writes ./.claude/settings.local.json)
npx @trek/claude init

# User-level (writes ~/.claude/settings.local.json)
npx @trek/claude init --user

# Reverse it
npx @trek/claude init --uninstall
```

### Flags

| Flag | Default | Description |
| --- | --- | --- |
| `--project` | (default) | Project scope — write `./.claude/settings.local.json`. |
| `--user` | | User scope — write `~/.claude/settings.local.json`. |
| `--token <trk_...>` | `$TREK_TOKEN`, else prompt | Trek API token. |
| `--api-url <url>` | `https://api.trekagent.io` | Trek API base URL. |
| `--project-id <uuid>` | `$TREK_PROJECT_ID` | Bind a default Trek project. |
| `--marketplace <owner>/<repo>` | `$TREK_MARKETPLACE` | GitHub repo hosting the plugin marketplace. |
| `--uninstall` | | Remove the plugin + Trek env for the chosen scope. |

If no token is provided via flag or env, `init` prompts for one (TTY) and points you at the
cockpit **Settings → API tokens** page to mint one.

## What `init` does

1. `claude plugin marketplace add <owner>/trek-claude-plugin`
2. `claude plugin install trek@trek`
3. Writes the token into `.claude/settings.local.json` (gitignored), deep-merged:
   ```jsonc
   { "env": { "TREK_TOKEN": "trk_…", "TREK_API_URL": "https://api.trekagent.io" } }
   ```

That one `env` block powers **both** the plugin's MCP auth (`Bearer ${TREK_TOKEN}`) and the
presence hooks (which read `TREK_TOKEN` / `TREK_API_URL`). The skill, hooks, and MCP server
themselves all live in the plugin — this installer just stands it up and authenticates it.

> The plugin marketplace lives at a GitHub repo. Until it's published under your org, pass
> `--marketplace <owner>/trek-claude-plugin` or set `TREK_MARKETPLACE`; the built-in default is a
> `YOUR_ORG/...` placeholder.

## Idempotency

`init` is safe to re-run: marketplace-add / plugin-install tolerate "already present", and the
`settings.local.json` `env` block is deep-merged (never clobbers your other settings).

## Next steps after install

1. Restart Claude Code (in the project, for project scope) so it loads the Trek plugin.
2. Approve the **trek** MCP server when prompted (it reads `${TREK_TOKEN}`).
3. Update later with `claude plugin update trek@trek`.
