#!/usr/bin/env node
// @trekagent/claude — install Trek into Claude Code in one command.
//
// Installs the Trek plugin (skill + presence hooks + remote MCP server) from the Trek
// marketplace, then wires your API token so the MCP server and hooks authenticate.
//
// By default, if no token is already available, init opens your browser to sign in and
// the token is created + delivered back automatically over a localhost loopback listener.
//
//   npx @trekagent/claude init                       # project scope (writes ./.claude/settings.local.json)
//   npx @trekagent/claude init --user                # user scope  (writes ~/.claude/settings.local.json)
//   npx @trekagent/claude init --token trk_... --api-url https://api.trekagent.io
//   npx @trekagent/claude init --login               # force a fresh browser login
//   npx @trekagent/claude init --no-browser          # skip browser, paste a token manually
//   npx @trekagent/claude init --marketplace owner/repo   # override the marketplace source
//   npx @trekagent/claude init --uninstall
//
// Pure Node, no deps. Idempotent: re-running never duplicates or clobbers your other settings.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, hostname } from 'node:os';
import { createInterface } from 'node:readline';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

// --- defaults --------------------------------------------------------------
const DEFAULT_API_URL = 'https://api.trekagent.io';
const DEFAULT_COCKPIT_URL = 'https://console.trekagent.io';
const COCKPIT_SETTINGS_URL = `${DEFAULT_COCKPIT_URL}/settings`;
const LOGIN_TIMEOUT_MS = 180000; // 3 min to authorize in the browser
const PLUGIN = 'trek';
const MARKETPLACE = 'trek'; // the `name` in the marketplace's marketplace.json
// GitHub org/repo hosting the plugin marketplace.
const DEFAULT_MARKETPLACE_REPO = process.env.TREK_MARKETPLACE || 'trekagent/trek-claude-plugin';

// --- console helpers -------------------------------------------------------
const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};
const log = (s = '') => process.stdout.write(s + '\n');
const ok = (s) => log(`  ${c.green('ok')}  ${s}`);
const skip = (s) => log(`  ${c.dim('--')}  ${s}`);
const warn = (s) => log(`  ${c.yellow('!!')}  ${s}`);

// --- arg parsing -----------------------------------------------------------
function parseArgs(argv) {
  const args = { _: [], flags: {} };
  const bools = new Set(['user', 'project', 'uninstall', 'help', 'force', 'no-browser', 'login']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { args.flags.help = true; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (bools.has(key)) args.flags[key] = true;
      else if (next !== undefined && !next.startsWith('--')) { args.flags[key] = next; i++; }
      else args.flags[key] = true;
    } else args._.push(a);
  }
  return args;
}

// --- fs / json helpers -----------------------------------------------------
function readJson(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`Could not parse JSON at ${path} — fix or remove it and re-run.`); }
}
function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
}
function prompt(question) {
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (ans) => { rl.close(); res(ans.trim()); });
  });
}
const CWD = process.cwd();
const rel = (p) => p.replace(CWD + '/', './').replace(homedir(), '~');

// --- claude CLI ------------------------------------------------------------
function whichClaude() {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim().split('\n')[0] : null;
}
function claude(bin, args) {
  return spawnSync(bin, args, { encoding: 'utf8' });
}

// --- token -----------------------------------------------------------------
const looksLikeToken = (t) => typeof t === 'string' && t.startsWith('trk_');

// Derive the cockpit base URL: explicit --cockpit-url wins, otherwise fall back
// to the default cockpit (used both for the default api base and any custom one).
function cockpitBase(flags) {
  if (typeof flags['cockpit-url'] === 'string' && flags['cockpit-url']) {
    return flags['cockpit-url'].replace(/\/+$/, '');
  }
  return DEFAULT_COCKPIT_URL;
}

// Reuse a token already wired into project or user settings.local.json.
function detectExistingToken() {
  const candidates = [
    join(CWD, '.claude', 'settings.local.json'),
    join(homedir(), '.claude', 'settings.local.json'),
  ];
  for (const path of candidates) {
    const cur = readJson(path);
    const tok = cur && cur.env && cur.env.TREK_TOKEN;
    if (looksLikeToken(tok)) return { token: tok, path };
  }
  return null;
}

// Open a URL in the user's default browser, cross-platform. Tolerates failure.
function openBrowser(url) {
  try {
    let cmd, args;
    if (process.platform === 'darwin') { cmd = 'open'; args = [url]; }
    else if (process.platform === 'win32') { cmd = 'cmd'; args = ['/c', 'start', '', url]; }
    else { cmd = 'xdg-open'; args = [url]; }
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch { return false; }
}

const SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Trek CLI connected</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0d10;color:#e8eaed;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{text-align:center;max-width:30rem;padding:2rem}h1{font-size:1.4rem}p{color:#9aa0a6}</style></head>
<body><div class="card"><h1>Trek CLI connected ✓</h1>
<p>You can close this tab and return to your terminal.</p></div></body></html>`;
const errorHtml = (msg) => `<!doctype html><html><head><meta charset="utf-8"><title>Trek CLI</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0d10;color:#e8eaed;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{text-align:center;max-width:30rem;padding:2rem}h1{font-size:1.4rem}p{color:#f28b82}</style></head>
<body><div class="card"><h1>Trek CLI</h1><p>${String(msg).replace(/[<>&]/g, '')}</p></div></body></html>`;

// Loopback browser-login flow. Resolves with { token, projectId } on success, or
// null if it could not complete (timeout / browser failure / user error) so the
// caller can fall back. The cockpit success callback contract is:
//   success: http://127.0.0.1:<port>/callback?token=<trk_...>&project=<projectId>&state=<nonce>
//   error:   http://127.0.0.1:<port>/callback?error=<msg>&state=<nonce>
// Project selection is mandatory in the cockpit, so `project` is normally present.
function browserLogin(flags) {
  return new Promise((resolve) => {
    const expectedState = randomUUID();
    let settled = false;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { server.close(); } catch {}
      resolve(result);
    };

    const server = createServer((req, res) => {
      let url;
      try { url = new URL(req.url, 'http://127.0.0.1'); }
      catch { res.writeHead(204).end(); return; }

      if (url.pathname !== '/callback') {
        // favicon.ico and any other path: ignore.
        res.writeHead(204).end();
        return;
      }

      const token = url.searchParams.get('token');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');
      const projectId = url.searchParams.get('project') || '';

      // A mismatched state must NOT resolve — keep waiting.
      if (state !== expectedState) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        res.end(errorHtml('Invalid state — this login request did not originate from this terminal.'));
        return;
      }

      if (error) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(errorHtml(`Login failed: ${error}`));
        warn(`browser login failed: ${error}`);
        finish(null);
        return;
      }

      if (looksLikeToken(token)) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(SUCCESS_HTML);
        finish({ token, projectId });
        return;
      }

      // Hit /callback with no usable token — show an error but keep waiting.
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(errorHtml('No token received.'));
    });

    server.on('error', (err) => {
      warn(`could not start local login listener: ${err.message}`);
      finish(null);
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const label = `Claude Code @ ${hostname()}`;
      const base = cockpitBase(flags);
      const authUrl = `${base}/cli-auth?port=${port}&state=${encodeURIComponent(expectedState)}&name=${encodeURIComponent(label)}`;

      log();
      log(`Opening your browser to sign in to Trek…`);
      const opened = openBrowser(authUrl);
      if (!opened) {
        log(`Could not open a browser automatically. Open this URL to continue:`);
        log(`  ${c.cyan(authUrl)}`);
      } else {
        log(c.dim(`  If it doesn't open, visit: ${authUrl}`));
      }
      log(`Waiting for you to authorize in the browser… ${c.dim('(Ctrl+C to cancel)')}`);

      timer = setTimeout(() => {
        warn('timed out waiting for browser login.');
        finish(null);
      }, LOGIN_TIMEOUT_MS);
    });
  });
}

// Manual paste fallback (also used for --no-browser and non-TTY).
async function pasteToken() {
  log();
  log(`Trek needs an API token (${c.cyan('trk_...')}).`);
  log(`Mint one in the cockpit: ${c.cyan(COCKPIT_SETTINGS_URL)} (Settings → API tokens).`);
  log();
  if (!process.stdin.isTTY) throw new Error('No token provided. Pass --token <trk_...> or set TREK_TOKEN.');
  const tok = await prompt('Paste your Trek token (or press Enter to skip): ');
  if (!tok) { warn('No token entered — writing config with a placeholder. Set TREK_TOKEN later.'); return 'trk_REPLACE_ME'; }
  return tok;
}

// Resolve a token (and, where available, a project id) following this precedence.
// Always returns { token, projectId }; projectId is '' for every path except a
// successful browser login, where the cockpit's mandatory project selection is
// delivered back over the loopback callback.
async function resolveToken(flags) {
  // 1. explicit flag
  if (typeof flags.token === 'string' && flags.token) return { token: flags.token, projectId: '' };
  // 2. environment
  if (process.env.TREK_TOKEN) { skip('using TREK_TOKEN from environment'); return { token: process.env.TREK_TOKEN, projectId: '' }; }
  // 3. reuse an existing token from settings (unless --login forces re-auth)
  if (!flags.login) {
    const existing = detectExistingToken();
    if (existing) { skip(`reusing TREK_TOKEN from ${rel(existing.path)}`); return { token: existing.token, projectId: '' }; }
  }
  // 4. browser login (interactive, unless --no-browser)
  if (process.stdin.isTTY && !flags['no-browser']) {
    const result = await browserLogin(flags);
    if (result && looksLikeToken(result.token)) { ok('signed in via browser'); return { token: result.token, projectId: result.projectId || '' }; }
    warn('falling back to manual token entry.');
  }
  // 5. manual paste fallback (also the --no-browser / non-TTY path)
  return { token: await pasteToken(), projectId: '' };
}

// --- settings.local.json: merge env block ----------------------------------
function writeTokenEnv(claudeDir, apiUrl, token, projectId) {
  const path = join(claudeDir, 'settings.local.json');
  const cur = readJson(path) || {};
  const env = { ...(cur.env || {}), TREK_TOKEN: token, TREK_API_URL: apiUrl };
  if (projectId) env.TREK_PROJECT_ID = projectId;
  const next = { ...cur, env };
  if (existsSync(path) && JSON.stringify(cur) === JSON.stringify(next)) {
    skip(`${rel(path)} already has TREK_TOKEN`);
    return path;
  }
  writeJson(path, next);
  ok(`${rel(path)} env wired (TREK_TOKEN, TREK_API_URL${projectId ? ', TREK_PROJECT_ID' : ''})`);
  return path;
}

// --- .gitignore ------------------------------------------------------------
function ensureGitignore(dir, entries) {
  const path = join(dir, '.gitignore');
  let lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [];
  const have = new Set(lines.map((l) => l.trim()));
  const toAdd = entries.filter((e) => !have.has(e));
  if (toAdd.length === 0) { skip('.gitignore already covers settings.local.json'); return; }
  if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
  if (!have.has('# Trek')) lines.push('# Trek');
  lines.push(...toAdd);
  writeFileSync(path, lines.join('\n').replace(/\n+$/, '\n'));
  ok(`.gitignore += ${toAdd.join(', ')}`);
}

// --- plugin install via marketplace ----------------------------------------
function installPlugin(bin, marketplaceRepo) {
  // Add marketplace (tolerate "already added").
  let r = claude(bin, ['plugin', 'marketplace', 'add', marketplaceRepo]);
  if (r.status === 0) ok(`marketplace added: ${marketplaceRepo}`);
  else if (/already|exists/i.test(`${r.stdout}${r.stderr}`)) skip(`marketplace ${marketplaceRepo} already added`);
  else { warn(`\`claude plugin marketplace add ${marketplaceRepo}\` failed:`); log(c.dim((r.stderr || r.stdout || '').trim())); return false; }

  // Install (tolerate "already installed").
  r = claude(bin, ['plugin', 'install', `${PLUGIN}@${MARKETPLACE}`]);
  if (r.status === 0) ok(`plugin installed: ${PLUGIN}@${MARKETPLACE}`);
  else if (/already|installed/i.test(`${r.stdout}${r.stderr}`)) skip(`plugin ${PLUGIN}@${MARKETPLACE} already installed`);
  else { warn(`\`claude plugin install ${PLUGIN}@${MARKETPLACE}\` failed:`); log(c.dim((r.stderr || r.stdout || '').trim())); return false; }
  return true;
}

// --- init ------------------------------------------------------------------
async function init(flags) {
  const userScope = !!flags.user;
  const apiUrl = (typeof flags['api-url'] === 'string' && flags['api-url']) || DEFAULT_API_URL;
  const flagProjectId = typeof flags['project-id'] === 'string' ? flags['project-id'] : process.env.TREK_PROJECT_ID || '';
  const marketplaceRepo = (typeof flags.marketplace === 'string' && flags.marketplace) || DEFAULT_MARKETPLACE_REPO;

  log(c.bold(`\nTrek installer — ${userScope ? 'user' : 'project'} scope`));
  log(c.dim(`api: ${apiUrl}`));

  const bin = whichClaude();
  if (!bin) {
    warn('`claude` CLI not found. Install Claude Code first: https://docs.claude.com/claude-code');
    log('Then re-run `npx @trekagent/claude init`. Or install the plugin manually:');
    log(`       claude plugin marketplace add ${marketplaceRepo}`);
    log(`       claude plugin install ${PLUGIN}@${MARKETPLACE}`);
  } else {
    installPlugin(bin, marketplaceRepo);
  }

  const { token, projectId: browserProjectId } = await resolveToken(flags);
  // The browser flow's mandatory project selection wins; otherwise fall back to
  // the explicit --project-id / $TREK_PROJECT_ID resolution.
  const projectId = browserProjectId || flagProjectId;
  const claudeDir = userScope ? join(homedir(), '.claude') : join(CWD, '.claude');
  writeTokenEnv(claudeDir, apiUrl, token, projectId);
  if (!userScope) ensureGitignore(CWD, ['.claude/settings.local.json']);

  log(c.bold(`\nDone (${userScope ? 'user' : 'project'} scope).`));
  log('Next steps:');
  log(`  1. Restart Claude Code${userScope ? '' : ' in this project'} so it loads the Trek plugin.`);
  log('  2. Approve the "trek" MCP server when prompted (it reads ${TREK_TOKEN}).');
  log(`  3. Update later with: ${c.cyan(`claude plugin update ${PLUGIN}@${MARKETPLACE}`)}`);
}

// --- uninstall -------------------------------------------------------------
async function uninstall(flags) {
  const userScope = !!flags.user;
  log(c.bold(`\nTrek uninstall — ${userScope ? 'user' : 'project'} scope`));
  const bin = whichClaude();
  if (bin) {
    const r = claude(bin, ['plugin', 'uninstall', `${PLUGIN}@${MARKETPLACE}`]);
    if (r.status === 0) ok(`plugin uninstalled: ${PLUGIN}@${MARKETPLACE}`);
    else skip('plugin not installed (or already removed)');
  } else {
    warn('`claude` CLI not found — remove the plugin manually with `claude plugin uninstall`.');
  }

  // Strip the Trek env keys from settings.local.json (leave the rest intact).
  const path = join(userScope ? homedir() : CWD, '.claude', 'settings.local.json');
  const cur = readJson(path);
  if (cur && cur.env) {
    for (const k of ['TREK_TOKEN', 'TREK_API_URL', 'TREK_PROJECT_ID']) delete cur.env[k];
    if (Object.keys(cur.env).length === 0) delete cur.env;
    writeJson(path, cur);
    ok(`${rel(path)} Trek env removed`);
  }
  log(c.bold('\nUninstalled.'));
}

// --- help / main -----------------------------------------------------------
const HELP = `${c.bold('@trekagent/claude')} — install Trek into Claude Code.

${c.bold('Usage')}
  npx @trekagent/claude init [options]

${c.bold('Options')}
  --project              Project scope: write ./.claude/settings.local.json (default)
  --user                 User scope: write ~/.claude/settings.local.json
  --token <trk_...>      Trek API token (skips browser login)
  --api-url <url>        Trek API base URL (default ${DEFAULT_API_URL})
  --cockpit-url <url>    Cockpit base URL for browser login (default ${DEFAULT_COCKPIT_URL})
  --project-id <uuid>    Bind a default Trek project (sets TREK_PROJECT_ID)
  --marketplace <o/r>    GitHub owner/repo of the plugin marketplace (else $TREK_MARKETPLACE)
  --login                Force a fresh browser login (ignore any saved token)
  --no-browser           Skip browser login; paste a token manually
  --uninstall            Remove the plugin + Trek env for the chosen scope
  -h, --help             Show this help

${c.bold('What init does')}
  1. claude plugin marketplace add trekagent/trek-claude-plugin
  2. claude plugin install ${PLUGIN}@${MARKETPLACE}
  3. resolves a token (flag → env → saved → browser login → manual paste)
  4. writes TREK_TOKEN / TREK_API_URL into .claude/settings.local.json (gitignored)

By default, if no token is already available init opens your browser to sign in /
create an account; the token is created and delivered back automatically over a
localhost listener. The plugin ships the skill, presence hooks, and the remote MCP
server; the token in settings.local.json is what makes them authenticate. Re-running is safe.
`;

async function main() {
  const argv = process.argv.slice(2);
  const { _, flags } = parseArgs(argv);
  const cmd = _[0];
  if (flags.help || (!cmd && argv.length === 0) || cmd === 'help') { log(HELP); return; }
  if (cmd !== 'init') { log(c.red(`Unknown command: ${cmd ?? '(none)'}`)); log(HELP); process.exitCode = 1; return; }
  try {
    if (flags.uninstall) await uninstall(flags);
    else await init(flags);
  } catch (err) {
    log('');
    log(c.red(`Error: ${err.message}`));
    process.exitCode = 1;
  }
}
main();
