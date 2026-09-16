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
import fs from 'node:fs'
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

// Resolved version returned by the stubbed `npm view` fallback lookup,
// standing in for whatever is actually latest on the real registry.
// Deliberately different from create-deka-app's own version, so a test
// that mixes up the happy-path pin and the fallback pin fails loudly.
const STUB_FALLBACK_VERSION = '9.9.9'

// Writes a fake `npm` onto PATH that mimics just enough of npm to drive the
// real CLI end to end. `installBehavior` is either:
//  - 'succeed': every `npm install` succeeds (the lockstep happy path --
//    the exact @dekaruntime/deka pin "exists").
//  - 'fail-exact-pin': `npm install` fails while package.json pins
//    OWN_VERSION (simulating the runtime build not published yet) and
//    succeeds once it pins anything else, so the fallback path is
//    exercised for real through the CLI, not just unit-tested.
// `npm view` (the fallback registry lookup) always prints
// STUB_FALLBACK_VERSION and logs that it ran, so a test can assert it was
// (or was not) called.
//
// The deka stub is invoked as `deka init <dirName>` from the *parent*
// directory (create-deka-app's new invocation shape) and, like the real
// binary, creates its files inside `$2` and prints a `[init] ...` block
// ending in a bare `deka serve` suggestion -- the exact suggestion
// create-deka-app must suppress and replace.
function writeStubNpm(binDir, logFile, { installBehavior = 'succeed', ownVersion } = {}) {
  const npmPath = path.join(binDir, 'npm')
  const installFailureClause =
    installBehavior === 'fail-exact-pin'
      ? `PINNED="$(node -e "console.log(require('./package.json').devDependencies['@dekaruntime/deka'])")"
if [ "$PINNED" = "${ownVersion}" ]; then
  echo "npm install|pinned=$PINNED|FAILED|$(pwd)" >> "${logFile}"
  echo "npm ERR! code ETARGET" >&2
  exit 1
fi
`
      : ''
  writeFileSync(
    npmPath,
    `#!/bin/sh
set -e
if [ "$1" = "view" ]; then
  echo "npm view $2 $3|$(pwd)" >> "${logFile}"
  echo "${STUB_FALLBACK_VERSION}"
  exit 0
fi
${installFailureClause}SAW_PKG_JSON=no
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

test('end-to-end: create-deka-app myapp scaffolds via npm and runs deka init in order (lockstep happy path)', () => {
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
    ownVersion,
    "lockstep versioning: must pin exactly create-deka-app's own version when it installs cleanly"
  )

  // Proof that step 4 (deka init) actually ran, not just that install did.
  assert.ok(
    existsSync(path.join(targetDir, 'deka.json')),
    'deka init must have run and produced its own output (step 4)'
  )

  const log = readFileSync(logFile, 'utf8').trim().split('\n')
  assert.equal(
    log.length,
    2,
    `lockstep versioning makes no registry call on the happy path -- expected exactly [npm install, deka init], got:\n${log.join('\n')}`
  )
  assert.match(log[0], /^npm install\|saw-package-json=yes\|/, 'package.json must be written before install runs')
  // macOS resolves /var -> /private/var, so the child reports a realpath'd cwd
  // while `work` is the unresolved mkdtemp path. Compare both realpath'd, or
  // this fails on every macOS run and passes only on Linux CI (it did: 0.0.5
  // shipped with this red).
  const [initCmd, initCwd] = log[1].split('|')
  assert.equal(
    initCmd,
    'deka init myapp',
    'deka init must run after install, invoked with the directory name as an argument'
  )
  assert.equal(
    fs.realpathSync(initCwd),
    fs.realpathSync(work),
    'deka init must run from the parent directory'
  )

  // The bug this suite guards against: the user is left in the parent
  // directory with no indication they must `cd` into the new project. The
  // final output must name the project directory in a `cd` line and give
  // the canonical `deka dev` command -- deka from this package is scoped
  // to the project, so that command works with nothing beyond what install
  // already put in node_modules/.bin -- and deka init's own next-steps
  // suggestion (a bare "deka serve", from this fixture) must not appear at
  // all, since two competing next-steps blocks would be worse than one.
  assert.match(
    output,
    /cd myapp/,
    'must tell the user to cd into the new project directory -- this is the line the bug report showed missing'
  )
  assert.match(output, /^\s*deka dev\s*$/m, 'must give the canonical `deka dev` command')
  assert.doesNotMatch(
    output,
    /^\s*deka serve\s*$/m,
    "deka init's own bare-command suggestion must be suppressed, not printed alongside create-deka-app's own"
  )

  rmSync(work, { recursive: true, force: true })
})

test('end-to-end: falls back to the registry-resolved version when the exact pin fails to install', () => {
  const work = tmp('cda-e2e-fallback-')
  const binDir = path.join(work, 'bin')
  mkdirSync(binDir)
  const logFile = path.join(work, 'log.txt')
  writeFileSync(logFile, '')

  const ownVersion = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version
  writeStubNpm(binDir, logFile, { installBehavior: 'fail-exact-pin', ownVersion })

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

  assert.match(output, /Falling back to the latest published version/i)

  const pkg = JSON.parse(readFileSync(path.join(work, 'myapp', 'package.json'), 'utf8'))
  assert.equal(
    pkg.devDependencies['@dekaruntime/deka'],
    STUB_FALLBACK_VERSION,
    'must end up pinning the registry-resolved fallback version, not the unpublished exact pin'
  )

  const log = readFileSync(logFile, 'utf8').trim().split('\n')
  assert.ok(
    log.some((line) => line.startsWith('npm install') && line.includes(`pinned=${ownVersion}`) && line.includes('FAILED')),
    `expected a failed install attempt pinning ${ownVersion}; got:\n${log.join('\n')}`
  )
  assert.ok(
    // rfd#68: the fallback looks up the SAME dist-tag as the running
    // version's channel -- `latest` here, since this checkout's own
    // package.json version (a stable "0.0.0" placeholder outside of a
    // publish run) is on the stable channel.
    log.some((line) => line.startsWith(`npm view @dekaruntime/deka@latest version|`)),
    `expected the fallback registry lookup to have run; got:\n${log.join('\n')}`
  )
  assert.ok(
    log.some((line) => line.startsWith('npm install') && line.includes('saw-package-json=yes') && !line.includes('FAILED')),
    `expected a second, successful install attempt; got:\n${log.join('\n')}`
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
