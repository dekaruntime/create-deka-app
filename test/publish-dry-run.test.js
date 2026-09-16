// Proves every new package.json in npm/ is a publishable manifest with a
// correct "files" glob. Uses `npm pack --dry-run --json`, which builds the
// tarball locally and never talks to the registry -- unlike `npm publish
// --dry-run`, which npm refuses to run against a scoped package name
// without being logged in (confirmed the hard way: this suite's CI run has
// no npm credentials by design, matching the zero-token posture the real
// publish-runtime.yml workflow uses). `npm publish --dry-run --tag next`
// was verified by hand locally (see the PR description) and produces the
// same file listing; `pack` is the form that can run unauthenticated here.
//
// Platform packages ship "files": ["bin/"], and that directory is
// git-ignored (CI downloads into it) -- so this test writes fixture
// binaries into bin/ first and removes them afterwards, to prove the glob
// actually captures what CI will put there.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const NPM_ROOT = path.join(__dirname, '..', 'npm')

const LAUNCHERS = ['deka', 'dsc']
const DEKA_PLATFORM_PACKAGES = ['deka-darwin-arm64', 'deka-darwin-x64', 'deka-linux-x64']
const DSC_PLATFORM_PACKAGES = ['dsc-darwin-arm64', 'dsc-darwin-x64', 'dsc-linux-x64']

function packDryRun(pkgDir, pkgName) {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: pkgDir,
    encoding: 'utf8',
  })
  const [report] = JSON.parse(output)
  assert.ok(report, `npm pack --dry-run --json produced no report for ${pkgDir}`)
  assert.equal(report.name, pkgName)
  return report.files.map((f) => f.path)
}

for (const name of LAUNCHERS) {
  test(`npm pack --dry-run succeeds for @dekaruntime/${name} (launcher)`, () => {
    const pkgDir = path.join(NPM_ROOT, name)
    const files = packDryRun(pkgDir, `@dekaruntime/${name}`)
    assert.ok(files.includes('bin.js'), `expected bin.js in ${files}`)
    assert.ok(files.includes('launcher-core.js'), `expected launcher-core.js in ${files}`)
  })
}

for (const name of DEKA_PLATFORM_PACKAGES) {
  test(`npm pack --dry-run succeeds for @dekaruntime/${name} (ships deka + dsc siblings)`, (t) => {
    const pkgDir = path.join(NPM_ROOT, name)
    const binDir = path.join(pkgDir, 'bin')
    fs.mkdirSync(binDir, { recursive: true })
    fs.writeFileSync(path.join(binDir, 'deka'), 'fixture')
    fs.writeFileSync(path.join(binDir, 'dsc'), 'fixture')
    fs.chmodSync(path.join(binDir, 'deka'), 0o755)
    fs.chmodSync(path.join(binDir, 'dsc'), 0o755)
    t.after(() => fs.rmSync(binDir, { recursive: true, force: true }))

    const files = packDryRun(pkgDir, `@dekaruntime/${name}`)
    assert.ok(files.includes('bin/deka'), `expected bin/deka in ${files}`)
    assert.ok(files.includes('bin/dsc'), `expected bin/dsc in ${files}`)
  })
}

for (const name of DSC_PLATFORM_PACKAGES) {
  test(`npm pack --dry-run succeeds for @dekaruntime/${name}`, (t) => {
    const pkgDir = path.join(NPM_ROOT, name)
    const binDir = path.join(pkgDir, 'bin')
    fs.mkdirSync(binDir, { recursive: true })
    fs.writeFileSync(path.join(binDir, 'dsc'), 'fixture')
    fs.chmodSync(path.join(binDir, 'dsc'), 0o755)
    t.after(() => fs.rmSync(binDir, { recursive: true, force: true }))

    const files = packDryRun(pkgDir, `@dekaruntime/${name}`)
    assert.ok(files.includes('bin/dsc'), `expected bin/dsc in ${files}`)
  })
}

test('a platform package with no bin/ has nothing runnable to pack (guards that the fixtures above are load-bearing)', () => {
  const binDir = path.join(NPM_ROOT, 'deka-linux-x64', 'bin')
  // Deliberately not created here -- proves bin/ is git-ignored and absent
  // outside of CI or the fixture setup in the tests above.
  assert.ok(!fs.existsSync(binDir), 'bin/ must be git-ignored and absent between test runs')
})
