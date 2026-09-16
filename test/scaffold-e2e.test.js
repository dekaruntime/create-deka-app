// End-to-end: runs the real CLI (index.js) as a subprocess, with a stubbed
// package manager and a stubbed deka binary on PATH standing in for the
// real npm registry and the real deka platform binary. Nothing here mocks
// createApp's internals — it proves the whole chain: the registry version
// lookup, directory creation, package.json contents, the install step,
// and that `deka init` (step 4) actually runs. Removing the deka-init call
// from src/scaffold.js makes this fail (no deka.json, and the
// order-of-operations log is too short).
//
// The stubbed deka binary also mimics the real one's "next steps" output
// (a `[init] ...` line followed by a bare `deka serve` suggestion, verified
// against the actual published binary -- see PR description) so this test
// proves create-deka-app suppresses that and prints its own `cd` + package
// manager dev command instead, rather than just asserting against the stub
// in isolation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(__dirname, '..')
const cliPath = path.join(repoRoot, 'index.js')

function tmp(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix))
}

// Resolved version returned by the stubbed `npm view` below, standing in
// for whatever is actually latest on the real registry. Deliberately
// different from both create-deka-app's own version and from a plausible
// runtime version, so a test that mixes them up fails loudly.
const STUB_RUNTIME_VERSION = '9.9.9'

// Writes a fake `npm` onto PATH that mimics just enough of npm to drive the
// real CLI end to end:
//  - `npm view @dekaruntime/deka version` (the registry lookup) prints
//    STUB_RUNTIME_VERSION and logs that it ran.
//  - `npm install` records that it ran (and whether package.json already
//    existed, to prove write-before-install ordering), then materializes
//    node_modules/.bin/deka as a second stub standing in for the real
//    platform binary that a genuine install would have fetched.
//
// The deka stub is invoked as `deka init <dirName>` from the *parent*
// directory (create-deka-app's new invocation shape) and, like the real
// binary, creates its files inside `$2` and prints a `[init] ...` block
// ending in a bare `deka serve` suggestion -- the exact suggestion
// create-deka-app must suppress and replace.
function writeStubNpm(binDir, logFile) {
  const npmPath = path.join(binDir, 'npm')
  writeFileSync(
    npmPath,
    `#!/bin/sh
set -e
if [ "$1" = "view" ]; then
  echo "npm view $2 $3|$(pwd)" >> "${logFile}"
  echo "${STUB_RUNTIME_VERSION}"
  exit 0
fi
SAW_PKG_JSON=no
if [ -f package.json ]; then SAW_PKG_JSON=yes; fi
echo "npm install|saw-package-json=$SAW_PKG_JSON|$(pwd)" >> "${logFile}"
mkdir -p node_modules/.bin
cat > node_modules/.bin/deka <<'DEKA_EOF'
#!/bin/sh
echo "deka $*|$(pwd)" >> "${logFile}"
if [ "$1" = "init" ]; then
  DIR="$2"
  echo '{"stub":true}' > "$DIR/deka.json"
  echo "[create] $DIR/deka.json"
  echo "[init] DekaScript app ready"
  echo "  cd $DIR"
  echo "  deka serve"
fi
exit 0
DEKA_EOF
chmod +x node_modules/.bin/deka
exit 0
`
  )
  chmodSync(npmPath, 0o755)
}

test('end-to-end: create-deka-app myapp scaffolds via npm and runs deka init in order', () => {
  const work = tmp('cda-e2e-')
  const binDir = path.join(work, 'bin')
  mkdirSync(binDir)
  const logFile = path.join(work, 'log.txt')
  writeFileSync(logFile, '')
  writeStubNpm(binDir, logFile)

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    npm_config_user_agent: 'npm/10.2.4 node/v20.11.0 darwin arm64 workspaces/false',
  }

  const output = execFileSync(process.execPath, [cliPath, 'myapp'], {
    cwd: work,
    env,
    encoding: 'utf8',
  })

  assert.match(output, /Using npm to install/)

  const targetDir = path.join(work, 'myapp')
  const pkgJsonPath = path.join(targetDir, 'package.json')
  assert.ok(existsSync(pkgJsonPath), 'package.json must exist')

  const ownVersion = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
  assert.equal(pkg.name, 'myapp')
  assert.equal(pkg.private, true)
  assert.deepEqual(pkg.scripts, { dev: 'deka dev', build: 'deka build', start: 'deka start' })
  assert.equal(
    pkg.devDependencies['@dekaruntime/deka'],
    STUB_RUNTIME_VERSION,
    'must pin the @dekaruntime/deka version resolved from the registry (npm view)'
  )
  assert.notEqual(
    pkg.devDependencies['@dekaruntime/deka'],
    ownVersion,
    "must NOT pin create-deka-app's own version -- the two release lines are not in lockstep"
  )

  // Proof that step 4 (deka init) actually ran, not just that install did.
  assert.ok(
    existsSync(path.join(targetDir, 'deka.json')),
    'deka init must have run and produced its own output (step 4)'
  )

  const log = readFileSync(logFile, 'utf8').trim().split('\n')
  assert.equal(
    log.length,
    3,
    `expected exactly [npm view, npm install, deka init], got:\n${log.join('\n')}`
  )
  assert.match(
    log[0],
    /^npm view @dekaruntime\/deka version\|/,
    'the runtime version must be resolved from the registry before package.json is written'
  )
  assert.match(log[1], /^npm install\|saw-package-json=yes\|/, 'package.json must be written before install runs')
  assert.equal(
    log[2],
    `deka init myapp|${work}`,
    'deka init must run after install, invoked with the directory name as an argument, from the parent directory'
  )

  // The bug this suite guards against: the user is left in the parent
  // directory with no indication they must `cd` into the new project, and
  // told to run a bare `deka` command that isn't on their PATH. The final
  // output must name the project directory in a `cd` line and give a
  // command that runs via the package manager (works with nothing beyond
  // what install already put in node_modules/.bin) -- and deka's own
  // suggestion (a bare "deka serve") must not appear at all, since two
  // competing next-steps blocks would be worse than one wrong one.
  assert.match(
    output,
    /cd myapp/,
    'must tell the user to cd into the new project directory -- this is the line the bug report showed missing'
  )
  assert.match(
    output,
    /npm run dev/,
    'must give a dev command that works via the package manager, not a bare `deka` command'
  )
  assert.doesNotMatch(
    output,
    /^\s*deka serve\s*$/m,
    "deka init's own bare-command suggestion must be suppressed, not printed alongside create-deka-app's own"
  )

  rmSync(work, { recursive: true, force: true })
})

test('end-to-end: no argument prints usage and exits non-zero', () => {
  const work = tmp('cda-e2e-usage-')
  let threw = null
  try {
    execFileSync(process.execPath, [cliPath], { cwd: work, encoding: 'utf8' })
  } catch (err) {
    threw = err
  }
  assert.ok(threw, 'must exit non-zero')
  assert.notEqual(threw.status, 0)
  assert.match(threw.stderr, /Usage: create-deka-app <directory>/)
  rmSync(work, { recursive: true, force: true })
})

test('end-to-end: refuses an existing non-empty directory', () => {
  const work = tmp('cda-e2e-nonempty-')
  const target = path.join(work, 'myapp')
  mkdirSync(target)
  writeFileSync(path.join(target, 'existing.txt'), 'do not touch')

  let threw = null
  try {
    execFileSync(process.execPath, [cliPath, 'myapp'], { cwd: work, encoding: 'utf8' })
  } catch (err) {
    threw = err
  }
  assert.ok(threw, 'must exit non-zero')
  assert.match(threw.stderr, /already exists and is not empty/)
  assert.ok(!existsSync(path.join(target, 'package.json')), 'must not scaffold into it')

  rmSync(work, { recursive: true, force: true })
})
