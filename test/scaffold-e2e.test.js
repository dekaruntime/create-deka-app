// End-to-end: runs the real CLI (index.js) as a subprocess, with a stubbed
// package manager and a stubbed deka binary on PATH standing in for the
// real npm registry and the real deka platform binary. Nothing here mocks
// createApp's internals — it proves the whole chain: directory creation,
// package.json contents, the install step, and that `deka init` (step 4)
// actually runs. Removing the deka-init call from src/scaffold.js makes
// this fail (no deka.json, and the order-of-operations log is too short).
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

// Writes a fake `npm` onto PATH that mimics just enough of `npm install`:
// it records that it ran (and whether package.json already existed, to
// prove write-before-install ordering), then materializes
// node_modules/.bin/deka as a second stub standing in for the real
// platform binary that a genuine install would have fetched.
function writeStubNpm(binDir, logFile) {
  const npmPath = path.join(binDir, 'npm')
  writeFileSync(
    npmPath,
    `#!/bin/sh
set -e
SAW_PKG_JSON=no
if [ -f package.json ]; then SAW_PKG_JSON=yes; fi
echo "npm install|saw-package-json=$SAW_PKG_JSON|$(pwd)" >> "${logFile}"
mkdir -p node_modules/.bin
cat > node_modules/.bin/deka <<'DEKA_EOF'
#!/bin/sh
echo "deka $*|$(pwd)" >> "${logFile}"
if [ "$1" = "init" ]; then
  echo '{"stub":true}' > deka.json
  echo "[init] project scaffolded (stub)"
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
    ownVersion,
    'must pin @dekaruntime/deka at create-deka-app\'s own version (lockstep)'
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
    `expected exactly [npm install, deka init], got:\n${log.join('\n')}`
  )
  assert.match(log[0], /^npm install\|saw-package-json=yes\|/, 'package.json must be written before install runs')
  assert.match(log[1], /^deka init\|/, 'deka init must run, and run after install')

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
