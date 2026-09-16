import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp, ScaffoldError, USAGE, resolveRuntimeVersion, RUNTIME_PACKAGE } from '../src/scaffold.js'
import { run } from '../src/cli.js'

function tmp(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix))
}

// Standard spawn stub for tests that need a successful install: distinguishes
// `npm view` (the registry lookup) from `npm install`, and records every call.
// `initOutput` stands in for what the real deka binary prints on init --
// tests that care about next-steps filtering pass their own to prove
// stripDekaNextSteps behaves against realistic input.
function makeSpawnStub({ calls = [], viewStdout = '9.9.9\n', initOutput = '' } = {}) {
  return (cmd, args, opts) => {
    calls.push([cmd, args, opts.cwd])
    if (cmd === 'npm' && args[0] === 'view') {
      return { status: 0, stdout: viewStdout }
    }
    if (cmd === 'npm' && args[0] === 'install') {
      mkdirSync(path.join(opts.cwd, 'node_modules', '.bin'), { recursive: true })
      writeFileSync(path.join(opts.cwd, 'node_modules', '.bin', 'deka'), '#!/bin/sh\n')
      return { status: 0 }
    }
    if (String(cmd).endsWith(path.join('node_modules', '.bin', 'deka'))) {
      return { status: 0, stdout: initOutput }
    }
    return { status: 0 }
  }
}

// The real deka binary's own next-steps block, captured by actually running
// `deka init myapp` (v0.53.2) with cwd set to the parent directory and
// `myapp` as the positional argument -- the exact invocation shape this
// fix switches to. Used to prove stripDekaNextSteps and create-deka-app's
// own printed next steps behave against real output, not just an
// abbreviated stub.
const REAL_DEKA_INIT_OUTPUT = `[create] myapp/deka.json
[create] myapp/deka.lock
[create] myapp/.gitignore
[create] myapp/index.html
[create] myapp/app/layout.dsx
[create] myapp/app/page.dsx
[create] myapp/app/Counter.dsx
[create] myapp/public/style.css
[create] myapp/public/404.html
[init] DekaScript app ready
  cd myapp
  deka serve
`

test('no argument: prints usage, exits non-zero, does not touch cwd', () => {
  const cwd = tmp('cda-no-arg-')
  const before = readdirSync(cwd)
  let printedError = ''
  const code = run({
    argv: [],
    cwd,
    env: {},
    log: () => {},
    error: (msg) => {
      printedError = msg
    },
  })
  assert.notEqual(code, 0)
  assert.equal(printedError, USAGE)
  assert.deepEqual(readdirSync(cwd), before, 'cwd must be untouched')
  rmSync(cwd, { recursive: true, force: true })
})

test('unsupported platform: rejected before touching the filesystem', () => {
  const cwd = tmp('cda-platform-')
  assert.throws(
    () =>
      createApp({
        targetArg: 'myapp',
        cwd,
        env: {},
        platform: 'win32',
        arch: 'x64',
      }),
    /does not support win32-x64/
  )
  assert.deepEqual(readdirSync(cwd), [], 'nothing should be created')
  rmSync(cwd, { recursive: true, force: true })
})

test('existing non-empty directory is refused with a clear message', () => {
  const cwd = tmp('cda-nonempty-')
  const target = path.join(cwd, 'myapp')
  mkdirSync(target)
  writeFileSync(path.join(target, 'keep-me.txt'), 'pre-existing file')

  assert.throws(
    () =>
      createApp({
        targetArg: 'myapp',
        cwd,
        env: {},
        platform: 'linux',
        arch: 'x64',
      }),
    (err) => err instanceof ScaffoldError && /already exists and is not empty/.test(err.message)
  )
  assert.deepEqual(readdirSync(target), ['keep-me.txt'], 'existing contents must survive untouched')
  rmSync(cwd, { recursive: true, force: true })
})

test('existing empty directory is accepted', () => {
  const cwd = tmp('cda-empty-')
  const target = path.join(cwd, 'myapp')
  mkdirSync(target)
  const calls = []

  const code = createApp({
    targetArg: 'myapp',
    cwd,
    env: { npm_config_user_agent: 'npm/10.2.4 node/v20.11.0 linux x64' },
    platform: 'linux',
    arch: 'x64',
    log: () => {},
    spawn: makeSpawnStub({ calls }),
  })

  assert.equal(code, 0)
  assert.equal(calls.length, 3, 'expects the registry lookup, one install call and one init call')
  assert.deepEqual(calls[0], ['npm', ['view', RUNTIME_PACKAGE, 'version'], target])
  assert.deepEqual(calls[1], ['npm', ['install'], target])
  assert.equal(calls[2][0], path.join(target, 'node_modules', '.bin', 'deka'))
  assert.deepEqual(
    calls[2][1],
    ['init', 'myapp'],
    'deka init must be invoked with the directory name as an argument, the same shape as running it by hand'
  )
  assert.equal(
    calls[2][2],
    cwd,
    'deka init must run with cwd set to the *parent* directory, not the new project directory, ' +
      'so deka prints a `cd myapp` line instead of advice with nothing to cd into'
  )
  rmSync(cwd, { recursive: true, force: true })
})

test('final output tells the user to cd into the project and gives a runnable dev command', () => {
  const cwd = tmp('cda-nextsteps-')
  const logs = []

  createApp({
    targetArg: 'myapp',
    cwd,
    env: { npm_config_user_agent: 'npm/10.2.4 node/v20.11.0 linux x64' },
    platform: 'linux',
    arch: 'x64',
    log: (msg) => logs.push(msg),
    spawn: makeSpawnStub({ initOutput: REAL_DEKA_INIT_OUTPUT }),
  })

  const output = logs.join('\n')

  // This is the bug: the user was left in the parent directory with no
  // `cd` instruction, and a `deka dev` suggestion that isn't on PATH.
  assert.match(output, /cd myapp\b/, 'output must name the project directory in a cd line')
  assert.match(output, /npm run dev/, 'output must give a command runnable via the package manager')
})

test('a `cd <dir>` line that disappears from the final output fails this suite', () => {
  // Directly guards against a regression where printNextSteps's cd line is
  // dropped (e.g. someone "simplifies" it away) without a matching test
  // failure. This does not call createApp -- it exercises the same
  // contract the previous test checks, worded as an explicit trap so the
  // intent is unmissable in a diff.
  const logs = []
  createApp({
    targetArg: 'myapp',
    cwd: tmp('cda-nextsteps-trap-'),
    env: { npm_config_user_agent: 'npm/10.2.4 node/v20.11.0 linux x64' },
    platform: 'linux',
    arch: 'x64',
    log: (msg) => logs.push(msg),
    spawn: makeSpawnStub({ initOutput: REAL_DEKA_INIT_OUTPUT }),
  })
  assert.ok(
    logs.some((line) => /^\s*cd myapp\s*$/.test(line)),
    `expected a standalone "cd myapp" line in the output; got:\n${logs.join('\n')}`
  )
})

test("deka init's own bare-command next-steps block is suppressed, not printed alongside ours", () => {
  const cwd = tmp('cda-suppress-')
  const logs = []

  createApp({
    targetArg: 'myapp',
    cwd,
    env: { npm_config_user_agent: 'npm/10.2.4 node/v20.11.0 linux x64' },
    platform: 'linux',
    arch: 'x64',
    log: (msg) => logs.push(msg),
    spawn: makeSpawnStub({ initOutput: REAL_DEKA_INIT_OUTPUT }),
  })

  const output = logs.join('\n')
  // REAL_DEKA_INIT_OUTPUT's own suggestion is a bare "  deka serve" line
  // with nothing else on it -- must not survive filtering. (`deka serve`
  // as a substring is fine if it ever showed up inside create-deka-app's
  // own text, which it doesn't today; the anchored line is the precise
  // thing that must vanish.)
  assert.doesNotMatch(
    output,
    /^\s*deka serve\s*$/m,
    "deka's own bare next-steps command must not appear -- it isn't runnable without a global install, " +
      "and two competing next-steps blocks would confuse the user this fix is for"
  )
  // The per-file [create] progress lines deka prints before its next-steps
  // block must still come through -- only the next-steps tail is filtered.
  assert.match(output, /\[create\] myapp\/deka\.json/, 'progress output before next-steps must survive filtering')
})

test('install failure surfaces an actionable error and stops before deka init', () => {
  const cwd = tmp('cda-install-fail-')
  const calls = []

  assert.throws(
    () =>
      createApp({
        targetArg: 'myapp',
        cwd,
        env: {},
        platform: 'linux',
        arch: 'x64',
        log: () => {},
        spawn: (cmd, args, opts) => {
          calls.push(cmd)
          return { status: 1 }
        },
      }),
    /"npm install" failed/
  )
  assert.deepEqual(
    calls,
    ['npm', 'npm'],
    'deka init must not run after a failed install (registry lookup + failed install only)'
  )
  rmSync(cwd, { recursive: true, force: true })
})

test('missing binary after install is reported clearly', () => {
  const cwd = tmp('cda-missing-bin-')

  assert.throws(
    () =>
      createApp({
        targetArg: 'myapp',
        cwd,
        env: {},
        platform: 'darwin',
        arch: 'arm64',
        log: () => {},
        // "install" succeeds but never actually creates the binary.
        spawn: () => ({ status: 0 }),
      }),
    /was not found after "npm install"/
  )
  rmSync(cwd, { recursive: true, force: true })
})

test('generated package.json pins the resolved @dekaruntime/deka version, not create-deka-app\'s own version', () => {
  const cwd = tmp('cda-pkgjson-')
  const calls = []

  // ownVersion is create-deka-app's own version. It must never end up in
  // the generated package.json -- the runtime package tracks deka's
  // release line, not this scaffolder's. createApp no longer even accepts
  // an ownVersion parameter; passing it here (as a caller mistakenly
  // might) must have zero effect on the pinned version.
  createApp({
    targetArg: 'myapp',
    cwd,
    env: {},
    platform: 'linux',
    arch: 'x64',
    ownVersion: '1.2.3',
    log: () => {},
    spawn: makeSpawnStub({ calls, viewStdout: '9.9.9\n' }),
  })

  const pkg = JSON.parse(readFileSync(path.join(cwd, 'myapp', 'package.json'), 'utf8'))
  assert.equal(
    pkg.devDependencies[RUNTIME_PACKAGE],
    '9.9.9',
    'must pin the version resolved from the npm registry'
  )
  assert.notEqual(
    pkg.devDependencies[RUNTIME_PACKAGE],
    '1.2.3',
    "must not pin create-deka-app's own version -- the two release lines are not in lockstep"
  )
  assert.deepEqual(pkg.scripts, { dev: 'deka dev', build: 'deka build', start: 'deka start' })
  rmSync(cwd, { recursive: true, force: true })
})

test('falls back to "latest" in the generated package.json when the registry lookup fails', () => {
  const cwd = tmp('cda-fallback-')
  const logs = []

  createApp({
    targetArg: 'myapp',
    cwd,
    env: {},
    platform: 'linux',
    arch: 'x64',
    log: (msg) => logs.push(msg),
    spawn: (cmd, args, opts) => {
      if (cmd === 'npm' && args[0] === 'view') {
        // Simulate an offline registry / npm view failure.
        return { status: 1, stdout: '', stderr: 'network timeout' }
      }
      if (cmd === 'npm' && args[0] === 'install') {
        mkdirSync(path.join(opts.cwd, 'node_modules', '.bin'), { recursive: true })
        writeFileSync(path.join(opts.cwd, 'node_modules', '.bin', 'deka'), '#!/bin/sh\n')
        return { status: 0 }
      }
      return { status: 0 }
    },
  })

  const pkg = JSON.parse(readFileSync(path.join(cwd, 'myapp', 'package.json'), 'utf8'))
  assert.equal(
    pkg.devDependencies[RUNTIME_PACKAGE],
    'latest',
    'must fall back to the "latest" dist-tag, never a version known to be wrong'
  )
  assert.ok(
    logs.some((msg) => /latest/i.test(msg) && /(could not resolve|falling back|registry)/i.test(msg)),
    `must tell the user it fell back; got logs:\n${logs.join('\n')}`
  )
  rmSync(cwd, { recursive: true, force: true })
})

test('resolveRuntimeVersion: returns the trimmed version on a successful lookup', () => {
  const version = resolveRuntimeVersion({
    spawn: () => ({ status: 0, stdout: '0.53.4\n' }),
    log: () => {},
  })
  assert.equal(version, '0.53.4')
})

test('resolveRuntimeVersion: falls back to "latest" on a non-zero exit', () => {
  const logs = []
  const version = resolveRuntimeVersion({
    spawn: () => ({ status: 1, stdout: '', stderr: 'ETARGET' }),
    log: (msg) => logs.push(msg),
  })
  assert.equal(version, 'latest')
  assert.ok(logs.length > 0, 'must log that it fell back')
})

test('resolveRuntimeVersion: falls back to "latest" when spawn itself errors (npm missing)', () => {
  const version = resolveRuntimeVersion({
    spawn: () => ({ error: new Error('ENOENT: npm not found') }),
    log: () => {},
  })
  assert.equal(version, 'latest')
})

test('resolveRuntimeVersion: falls back to "latest" on empty stdout', () => {
  const version = resolveRuntimeVersion({
    spawn: () => ({ status: 0, stdout: '' }),
    log: () => {},
  })
  assert.equal(version, 'latest')
})
