const { existsSync } = require('node:fs');
const { homedir } = require('node:os');
const { delimiter, join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const rootDir = resolve(__dirname, '../..');
const localDir = join(rootDir, '.xerj');
const stateDir = join(localDir, 'shared-state');
const endpoint = process.env.XERJ_URL || 'http://127.0.0.1:9200';
const dataDir =
  process.env.XERJ_DATA_DIR ||
  (process.platform === 'win32' && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'xerj', 'data')
    : join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'xerj'));
const mcpName = 'xerj-local';

function executableCandidates(name) {
  const names = process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  const pathCandidates = (process.env.PATH || '')
    .split(delimiter)
    .filter(Boolean)
    .flatMap((entry) => names.map((candidate) => join(entry, candidate)));

  if (name === 'xerj') {
    pathCandidates.push(
      join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'xerj.exe' : 'xerj'),
    );
    if (process.env.LOCALAPPDATA) {
      pathCandidates.push(join(process.env.LOCALAPPDATA, 'Programs', 'xerj', 'xerj.exe'));
    }
  }

  return pathCandidates;
}

function findExecutable(name, override) {
  if (override) {
    const candidate = resolve(override);
    if (existsSync(candidate)) return candidate;
    throw new Error(`${name} was not found at ${candidate}`);
  }

  return executableCandidates(name).find(existsSync);
}

function requireXerj() {
  const executable = findExecutable('xerj', process.env.XERJ_BIN);
  if (executable) return executable;

  throw new Error(
    'XERJ is not installed. Follow https://xerj.org/docs/install, then rerun this command.',
  );
}

function run(command, args, acceptedExitCodes = [0]) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    env: { ...process.env, XERJ_DISABLE_FEEDBACK: 'true' },
    stdio: 'inherit',
  });

  if (result.error) throw result.error;
  if (!acceptedExitCodes.includes(result.status)) process.exit(result.status ?? 1);
}

function printHelp() {
  console.log(`FloCafe XERJ code search

Usage: node scripts/dev/xerj.cjs <command>

Commands:
  doctor           Check the local XERJ installation, server, and Codex registration
  serve            Run a loopback-only XERJ server in the foreground
  index            Index non-ignored FloCafe code and documentation
  map              Show the indexed FloCafe datasets
  query <text>     Search the FloCafe index for relevant passages
  def <symbol>     Find an exact symbol definition in the FloCafe index
  configure-codex  Register the local XERJ MCP server in Codex user configuration

The server and index are optional developer tools. Local data is stored under .xerj/.
See docs/guides/code-search.md for installation and usage.`);
}

function doctor() {
  const xerj = requireXerj();
  console.log(`XERJ binary: ${xerj}`);
  run(xerj, ['--version']);

  const probe = spawnSync(
    xerj,
    ['autoindex', 'map', '--url', endpoint, '--limit', '1', '--json', '--disable-feedback'],
    {
      cwd: rootDir,
      env: { ...process.env, XERJ_DISABLE_FEEDBACK: 'true' },
      stdio: 'ignore',
    },
  );
  if (probe.status === 0) {
    console.log(`XERJ server: reachable at ${endpoint}`);
  } else {
    console.log(`XERJ server: not reachable at ${endpoint}; run npm run search:serve`);
  }

  const codex = findExecutable('codex', process.env.CODEX_BIN);
  if (!codex) {
    console.log('Codex MCP: Codex CLI not found; skip registration or install Codex first');
    return;
  }

  const registration = spawnSync(codex, ['mcp', 'get', mcpName], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  console.log(
    registration.status === 0
      ? `Codex MCP: ${mcpName} is registered`
      : 'Codex MCP: not registered; run npm run search:configure-codex',
  );
}

function serve() {
  const xerj = requireXerj();
  console.log(`Starting a loopback-only XERJ server at ${endpoint}`);
  console.log('Keep this terminal open while using indexed search.');
  run(xerj, ['--insecure', '--data-dir', dataDir, '--disable-feedback']);
}

function index() {
  const xerj = requireXerj();
  run(
    xerj,
    [
      'autoindex',
      rootDir,
      '--url',
      endpoint,
      '--prefix',
      'flocafe',
      '--state-dir',
      stateDir,
      '--plan',
      'code-and-docs-no-vectors',
      '--code-analyzer',
      'code',
      '--no-graph',
      '--progress',
      'plain',
      '--disable-feedback',
    ],
    [0, 3],
  );
}

function map() {
  const xerj = requireXerj();
  run(xerj, ['autoindex', 'map', '--url', endpoint, '--prefix', 'flocafe', '--disable-feedback']);
}

function query() {
  const text = process.argv.slice(3).join(' ').trim();
  if (!text) throw new Error('Provide a plain-language search query.');

  const xerj = requireXerj();
  run(xerj, ['search', '--url', endpoint, '--prefix', 'flocafe', '-k', '5', '--full', '800', text]);
}

function findDefinition() {
  const symbol = process.argv.slice(3).join(' ').trim();
  if (!symbol) throw new Error('Provide an exact symbol name.');

  const xerj = requireXerj();
  run(xerj, ['def', '--url', endpoint, '--prefix', 'flocafe', symbol]);
}

function configureCodex() {
  const xerj = requireXerj();
  const codex = findExecutable('codex', process.env.CODEX_BIN);
  if (!codex) throw new Error('Codex CLI was not found on PATH.');

  const existing = spawnSync(codex, ['mcp', 'get', mcpName], {
    cwd: rootDir,
    stdio: 'ignore',
  });
  if (existing.status === 0) {
    console.log(`Codex MCP server ${mcpName} is already registered; no changes made.`);
    return;
  }

  run(codex, [
    'mcp',
    'add',
    mcpName,
    '--env',
    `XERJ_URL=${endpoint}`,
    '--env',
    'XERJ_DISABLE_FEEDBACK=true',
    '--',
    xerj,
    'mcp',
    '--disable-feedback',
  ]);
  console.log(`Registered ${mcpName}. Restart Codex so it discovers the MCP tools.`);
}

try {
  switch (process.argv[2]) {
    case 'doctor':
      doctor();
      break;
    case 'serve':
      serve();
      break;
    case 'index':
      index();
      break;
    case 'map':
      map();
      break;
    case 'query':
      query();
      break;
    case 'def':
      findDefinition();
      break;
    case 'configure-codex':
      configureCodex();
      break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      printHelp();
      break;
    default:
      printHelp();
      process.exitCode = 2;
  }
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
}
