#!/usr/bin/env node
// @trek/claude — install Trek into Claude Code in one command.
//
// Installs the Trek plugin (skill + presence hooks + remote MCP server) from the Trek
// marketplace, then wires your API token so the MCP server and hooks authenticate.
//
//   npx @trek/claude init                       # project scope (writes ./.claude/settings.local.json)
//   npx @trek/claude init --user                # user scope  (writes ~/.claude/settings.local.json)
//   npx @trek/claude init --token trk_... --api-url https://api.trekagent.io
//   npx @trek/claude init --marketplace owner/repo   # override the marketplace source
//   npx @trek/claude init --uninstall
//
// Pure Node, no deps. Idempotent: re-running never duplicates or clobbers your other settings.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';

// --- defaults --------------------------------------------------------------
const DEFAULT_API_URL = 'https://api.trekagent.io';
const COCKPIT_SETTINGS_URL = 'https://console.trekagent.io/settings';
const PLUGIN = 'trek';
const MARKETPLACE = 'trek'; // the `name` in the marketplace's marketplace.json
// GitHub org/repo hosting the plugin marketplace. TODO: set this to your org once the
// repo exists (or pass --marketplace owner/repo / set TREK_MARKETPLACE).
const DEFAULT_MARKETPLACE_REPO = process.env.TREK_MARKETPLACE || 'YOUR_ORG/trek-claude-plugin';

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
  const bools = new Set(['user', 'project', 'uninstall', 'help', 'force']);
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
async function resolveToken(flags) {
  if (typeof flags.token === 'string' && flags.token) return flags.token;
  if (process.env.TREK_TOKEN) { skip('using TREK_TOKEN from environment'); return process.env.TREK_TOKEN; }
  log();
  log(`Trek needs an API token (${c.cyan('trk_...')}).`);
  log(`Mint one in the cockpit: ${c.cyan(COCKPIT_SETTINGS_URL)} (Settings → API tokens).`);
  log();
  if (!process.stdin.isTTY) throw new Error('No token provided. Pass --token <trk_...> or set TREK_TOKEN.');
  const tok = await prompt('Paste your Trek token (or press Enter to skip): ');
  if (!tok) { warn('No token entered — writing config with a placeholder. Set TREK_TOKEN later.'); return 'trk_REPLACE_ME'; }
  return tok;
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
  if (marketplaceRepo.includes('YOUR_ORG')) {
    warn(`marketplace repo not set — using placeholder "${marketplaceRepo}".`);
    log(`       Pass ${c.cyan('--marketplace <owner>/trek-claude-plugin')} or set ${c.cyan('TREK_MARKETPLACE')}.`);
  }
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
  const projectId = typeof flags['project-id'] === 'string' ? flags['project-id'] : process.env.TREK_PROJECT_ID || '';
  const marketplaceRepo = (typeof flags.marketplace === 'string' && flags.marketplace) || DEFAULT_MARKETPLACE_REPO;

  log(c.bold(`\nTrek installer — ${userScope ? 'user' : 'project'} scope`));
  log(c.dim(`api: ${apiUrl}`));

  const bin = whichClaude();
  if (!bin) {
    warn('`claude` CLI not found. Install Claude Code first: https://docs.claude.com/claude-code');
    log('Then re-run `npx @trek/claude init`. Or install the plugin manually:');
    log(`       claude plugin marketplace add ${marketplaceRepo}`);
    log(`       claude plugin install ${PLUGIN}@${MARKETPLACE}`);
  } else {
    installPlugin(bin, marketplaceRepo);
  }

  const token = await resolveToken(flags);
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
const HELP = `${c.bold('@trek/claude')} — install Trek into Claude Code.

${c.bold('Usage')}
  npx @trek/claude init [options]

${c.bold('Options')}
  --project              Project scope: write ./.claude/settings.local.json (default)
  --user                 User scope: write ~/.claude/settings.local.json
  --token <trk_...>      Trek API token (else $TREK_TOKEN, else prompt)
  --api-url <url>        Trek API base URL (default ${DEFAULT_API_URL})
  --project-id <uuid>    Bind a default Trek project (sets TREK_PROJECT_ID)
  --marketplace <o/r>    GitHub owner/repo of the plugin marketplace (else $TREK_MARKETPLACE)
  --uninstall            Remove the plugin + Trek env for the chosen scope
  -h, --help             Show this help

${c.bold('What init does')}
  1. claude plugin marketplace add <owner>/trek-claude-plugin
  2. claude plugin install ${PLUGIN}@${MARKETPLACE}
  3. writes TREK_TOKEN / TREK_API_URL into .claude/settings.local.json (gitignored)

The plugin ships the skill, presence hooks, and the remote MCP server; the token in
settings.local.json is what makes them authenticate. Re-running is safe.
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
