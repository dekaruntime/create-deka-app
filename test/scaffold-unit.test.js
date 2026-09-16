import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { createInterface } from 'node:readline'
import os from 'node:os'
import path from 'node:path'
import { createApp, ScaffoldError, USAGE, resolveRuntimeVersion, resolveLatestRuntimeVersion, RUNTIME_PACKAGE } from '../src/scaffold.js'
import { createInitOutputFilter } from '../src/init-output-filter.js'
import { run } from '../src/cli.js'

// The pinned test stand-in for create-deka-app's own version. Lockstep
// versioning means this is exactly what the generated package.json should
// pin in the common case -- never a plain "own version differs from
// runtime version" placeholder like the old 0.0.x-era tests used.
const OWN_VERSION = '0.53.4'

function tmp(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix))
}

// Standard spawn stub for tests that need a successful install on the
// first try (the lockstep happy path: no `npm view` call at all).
// `initOutput` stands in for what the real deka binary prints on init --
// tests that care about next-steps filtering pass their own to prove
// stripDekaNextSteps behaves against realistic input.
// `cmd` is whichever package manager's install command createApp resolved
// (npm, pnpm, yarn or bun) -- matched on `args[0] === 'install'` rather
// than a specific `cmd` name, so this stub works for all four the same
// way the real install step does.
function makeSpawnStub({ calls = [], initOutput = '' } = {}) {
  return (cmd, args, opts) => {
    calls.push([cmd, args, opts.cwd])
    if (cmd === 'npm' && args[0] === 'view') {
      return { status: 0, stdout: '9.9.9\n' }
    }
    if (args[0] === 'install') {
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

// Test double for createApp's `runDekaInit` -- the real implementation
// (runDekaInitStreaming, in src/scaffold.js) spawns a real process and
// streams its stdout through createInitOutputFilter to `log` line by
// line. This drives the exact same filter against canned `initOutput`
// instead, so unit tests exercise the real filtering logic without
// spawning anything -- and, sharing `calls` with makeSpawnStub, still
// produce the same [cmd, args, cwd] shape the existing assertions expect
// for the deka-init step.
function makeRunDekaInitStub({ calls = [], initOutput = '' } = {}) {
  return (dekaBin, args, { cwd, log }) =>
    new Promise((resolve) => {
      calls.push([dekaBin, args, cwd])
      const filter = createInitOutputFilter()
      const rl = createInterface({ input: filter, crlfDelay: Infinity })
      rl.on('line', log)
      // `close` fires only once the input has ended AND every 'line' it
      // produced has already been emitted -- resolving here (rather than
      // on the filter's own 'finish') guarantees createApp's next step
      // (printNextSteps) can't run before all of deka init's lines do.
      rl.on('close', () => resolve({ status: 0 }))
      filter.end(initOutput)
    })
}

// The real deka binary's own output, captured by actually running
// `deka init myapp` (v0.53.7) with cwd set to the parent directory and
// `myapp` as the positional argument -- the exact invocation shape this
// fix uses (see PR description for the raw bytes this was copied from,
// including the banner). Used to prove createInitOutputFilter and
// create-deka-app's own printed next steps behave against real output,
// not just an abbreviated stub. Deliberately keeps deka's real shape: a
// blank line, then "Next steps:", then its indented command lines --
// that shape is exactly what the filter keys off.
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

  Next steps:
  cd myapp
  deka serve
`

test('no argument: prints usage, exits non-zero, does not touch cwd', async () => {
  const cwd = tmp('cda-no-arg-')
  const before = readdirSync(cwd)
  let printedError = ''
  const code = await run({
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

test('unsupported platform: rejected before touching the filesystem', async () => {
  const cwd = tmp('cda-platform-')
  await assert.rejects(
    () =>
      createApp({
        targetArg: 'myapp',
        cwd,
        env: {},
        platform: 'win32',
        arch: 'x64',
        ownVersion: OWN_VERSION,
      }),
    /does not support win32-x64/
  )
  assert.deepEqual(readdirSync(cwd), [], 'nothing should be created')
  rmSync(cwd, { recursive: true, force: true })
})

test('existing non-empty directory is refused with a clear message', async () => {
  const cwd = tmp('cda-nonempty-')
  const target = path.join(cwd, 'myapp')
  mkdirSync(target)
  writeFileSync(path.join(target, 'keep-me.txt'), 'pre-existing file')

  await assert.rejects(
    () =>
      createApp({
        targetArg: 'myapp',
        cwd,
        env: {},
        platform: 'linux',
        arch: 'x64',
        ownVersion: OWN_VERSION,
        log: () => {},
      }),
    (err) => err instanceof ScaffoldError && /already exists and is not empty/.test(err.message)
  )
  assert.deepEqual(readdirSync(target), ['keep-me.txt'], 'existing contents must survive untouched')
  rmSync(cwd, { recursive: true, force: true })
})

test('createApp requires ownVersion (lockstep versioning has no other source of truth for the pin)', async () => {
  const cwd = tmp('cda-no-ownversion-')
  await assert.rejects(
    () =>
      createApp({
        targetArg: 'myapp',
        cwd,
        env: {},
        platform: 'linux',
        arch: 'x64',
      }),
    /requires ownVersion/
  )
  rmSync(cwd, { recursive: true, force: true })
})

test('existing empty directory is accepted, and the happy path makes no registry call', async () => {
  const cwd = tmp('cda-empty-')
  const target = path.join(cwd, 'myapp')
  mkdirSync(target)
  const calls = []

  const code = await createApp({
    targetArg: 'myapp',
    cwd,
    env: { npm_config_user_agent: 'npm/10.2.4 node/v20.11.0 linux x64' },
    platform: 'linux',
    arch: 'x64',
    ownVersion: OWN_VERSION,
    log: () => {},
    spawn: makeSpawnStub({ calls }),
    runDekaInit: makeRunDekaInitStub({ calls }),
  })

  assert.equal(code, 0)
  assert.equal(
    calls.length,
    2,
    'lockstep versioning pins ownVersion directly -- expects exactly one install call and one init call, no registry lookup'
  )
  assert.deepEqual(calls[0], ['npm', ['install'], target])
  assert.equal(calls[1][0], path.join(target, 'node_modules', '.bin', 'deka'))
  assert.deepEqual(
    calls[1][1],
    ['init', 'myapp'],
    'deka init must be invoked with the directory name as an argument, the same shape as running it by hand'
  )
  assert.equal(
    calls[1][2],
    cwd,
    'deka init must run with cwd set to the *parent* directory, not the new project directory, ' +
      'so deka prints a `cd myapp` line instead of advice with nothing to cd into'
  )
  rmSync(cwd, { recursive: true, force: true })
})

test('final output tells the user to cd into the project and gives a runnable, package-manager-correct dev command', async () => {
  const cwd = tmp('cda-nextsteps-')
  const logs = []

  await createApp({
    targetArg: 'myapp',
    cwd,
    env: { npm_config_user_agent: 'npm/10.2.4 node/v20.11.0 linux x64' },
    platform: 'linux',
    arch: 'x64',
    ownVersion: OWN_VERSION,
    log: (msg) => logs.push(msg),
    spawn: makeSpawnStub({}),
    runDekaInit: makeRunDekaInitStub({ initOutput: REAL_DEKA_INIT_OUTPUT }),
  })

  const output = logs.join('\n')

  // This is the bug (deka#1103): the user was left in the parent directory
  // with no `cd` instruction, and told to run a bare `deka dev` that isn't
  // on PATH for a project-local install.
  assert.match(output, /cd myapp\b/, 'output must name the project directory in a cd line')
  assert.match(output, /^\s*npm run dev\b/m, 'npm projects must be told to run `npm run dev`, not a bare `deka dev`')
  assert.match(output, /npx deka dev/, 'must also mention the direct npx form as an alternative')
})

test('a `cd <dir>` line that disappears from the final output fails this suite', async () => {
  // Directly guards against a regression where printNextSteps's cd line is
  // dropped (e.g. someone "simplifies" it away) without a matching test
  // failure. This does not call createApp -- it exercises the same
  // contract the previous test checks, worded as an explicit trap so the
  // intent is unmissable in a diff.
  const logs = []
  await createApp({
    targetArg: 'myapp',
    cwd: tmp('cda-nextsteps-trap-'),
    env: { npm_config_user_agent: 'npm/10.2.4 node/v20.11.0 linux x64' },
    platform: 'linux',
    arch: 'x64',
    ownVersion: OWN_VERSION,
    log: (msg) => logs.push(msg),
    spawn: makeSpawnStub({}),
    runDekaInit: makeRunDekaInitStub({ initOutput: REAL_DEKA_INIT_OUTPUT }),
  })
  assert.ok(
    logs.some((line) => /^\s*cd myapp\s*$/.test(line)),
    `expected a standalone "cd myapp" line in the output; got:\n${logs.join('\n')}`
  )
})

test("deka init's own bare-command next-steps block is suppressed, not printed alongside ours", async () => {
  const cwd = tmp('cda-suppress-')
  const logs = []

  await createApp({
    targetArg: 'myapp',
    cwd,
    env: { npm_config_user_agent: 'npm/10.2.4 node/v20.11.0 linux x64' },
    platform: 'linux',
    arch: 'x64',
    ownVersion: OWN_VERSION,
    log: (msg) => logs.push(msg),
    spawn: makeSpawnStub({}),
    runDekaInit: makeRunDekaInitStub({ initOutput: REAL_DEKA_INIT_OUTPUT }),
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

test('install failure with no fallback available surfaces an actionable error and stops before deka init', async () => {
  const cwd = tmp('cda-install-fail-')
  const calls = []

  await assert.rejects(
    () =>
      createApp({
        targetArg: 'myapp',
        cwd,
        env: {},
        platform: 'linux',
        arch: 'x64',
        ownVersion: OWN_VERSION,
        log: () => {},
        spawn: (cmd, args, opts) => {
          calls.push([cmd, args[0]])
          if (cmd === 'npm' && args[0] === 'view') {
            // The registry also reports OWN_VERSION as latest -- there is
            // nothing to fall back to, so this must fail without retrying
            // the install a second time.
            return { status: 0, stdout: `${OWN_VERSION}\n` }
          }
          return { status: 1 }
        },
      }),
    /"npm install" failed/
  )
  assert.deepEqual(
    calls,
    [
      ['npm', 'install'],
      ['npm', 'view'],
    ],
    'deka init must not run after a failed install with no usable fallback (one failed install, one fallback lookup, no retry)'
  )
  rmSync(cwd, { recursive: true, force: true })
})

test('missing binary after install is reported clearly', async () => {
  const cwd = tmp('cda-missing-bin-')

  await assert.rejects(
    () =>
      createApp({
        targetArg: 'myapp',
        cwd,
        env: {},
        platform: 'darwin',
        arch: 'arm64',
        ownVersion: OWN_VERSION,
        log: () => {},
        // "install" succeeds but never actually creates the binary.
        spawn: () => ({ status: 0 }),
      }),
    /was not found after "npm install"/
  )
  rmSync(cwd, { recursive: true, force: true })
})

test('generated package.json pins exactly create-deka-app\'s own version when it installs cleanly', async () => {
  const cwd = tmp('cda-pkgjson-')
  const calls = []

  await createApp({
    targetArg: 'myapp',
    cwd,
    env: {},
    platform: 'linux',
    arch: 'x64',
    ownVersion: OWN_VERSION,
    log: () => {},
    spawn: makeSpawnStub({ calls }),
    runDekaInit: makeRunDekaInitStub({ calls }),
  })

  const pkg = JSON.parse(readFileSync(path.join(cwd, 'myapp', 'package.json'), 'utf8'))
  assert.equal(
    pkg.devDependencies[RUNTIME_PACKAGE],
    OWN_VERSION,
    'lockstep versioning: the scaffolder pins exactly its own version when that version exists on the registry'
  )
  assert.ok(
    !calls.some(([cmd, args]) => cmd === 'npm' && args[0] === 'view'),
    'the happy path must not query the registry at all'
  )
  assert.deepEqual(pkg.scripts, { dev: 'deka dev', build: 'deka build', start: 'deka start' })
  rmSync(cwd, { recursive: true, force: true })
})

test('falls back to the latest published runtime version, with a warning, when the exact pin fails to install', async () => {
  const cwd = tmp('cda-fallback-')
  const logs = []
  const installAttempts = []

  await createApp({
    targetArg: 'myapp',
    cwd,
    env: {},
    platform: 'linux',
    arch: 'x64',
    ownVersion: OWN_VERSION,
    log: (msg) => logs.push(msg),
    spawn: (cmd, args, opts) => {
      if (cmd === 'npm' && args[0] === 'view') {
        return { status: 0, stdout: '9.9.9\n' }
      }
      if (cmd === 'npm' && args[0] === 'install') {
        const pkg = JSON.parse(readFileSync(path.join(opts.cwd, 'package.json'), 'utf8'))
        const pinned = pkg.devDependencies[RUNTIME_PACKAGE]
        installAttempts.push(pinned)
        if (pinned === OWN_VERSION) {
          // Simulate the ETARGET case: create-deka-app@OWN_VERSION shipped
          // before @dekaruntime/deka@OWN_VERSION was published.
          return { status: 1, stdout: '', stderr: 'ETARGET' }
        }
        mkdirSync(path.join(opts.cwd, 'node_modules', '.bin'), { recursive: true })
        writeFileSync(path.join(opts.cwd, 'node_modules', '.bin', 'deka'), '#!/bin/sh\n')
        return { status: 0 }
      }
      return { status: 0 }
    },
    runDekaInit: makeRunDekaInitStub(),
  })

  assert.deepEqual(
    installAttempts,
    [OWN_VERSION, '9.9.9'],
    'must retry the install once, against the registry-resolved fallback version'
  )

  const pkg = JSON.parse(readFileSync(path.join(cwd, 'myapp', 'package.json'), 'utf8'))
  assert.equal(
    pkg.devDependencies[RUNTIME_PACKAGE],
    '9.9.9',
    'must end up pinning the fallback version that actually installed'
  )
  assert.notEqual(
    pkg.devDependencies[RUNTIME_PACKAGE],
    OWN_VERSION,
    'must never leave the nonexistent version pinned in the final package.json (the ETARGET bug from 0.0.3)'
  )
  assert.ok(
    logs.some((msg) => /falling back/i.test(msg) && msg.includes(OWN_VERSION)),
    `must clearly log that it fell back; got logs:\n${logs.join('\n')}`
  )
  rmSync(cwd, { recursive: true, force: true })
})

test('falls back to the "latest" dist-tag when both the exact pin and the registry lookup fail', async () => {
  const cwd = tmp('cda-fallback-offline-')
  const logs = []

  await createApp({
    targetArg: 'myapp',
    cwd,
    env: {},
    platform: 'linux',
    arch: 'x64',
    ownVersion: OWN_VERSION,
    log: (msg) => logs.push(msg),
    spawn: (cmd, args, opts) => {
      if (cmd === 'npm' && args[0] === 'view') {
        // Simulate an offline registry / npm view failure.
        return { status: 1, stdout: '', stderr: 'network timeout' }
      }
      if (cmd === 'npm' && args[0] === 'install') {
        const pkg = JSON.parse(readFileSync(path.join(opts.cwd, 'package.json'), 'utf8'))
        if (pkg.devDependencies[RUNTIME_PACKAGE] === OWN_VERSION) {
          return { status: 1, stdout: '', stderr: 'ETARGET' }
        }
        mkdirSync(path.join(opts.cwd, 'node_modules', '.bin'), { recursive: true })
        writeFileSync(path.join(opts.cwd, 'node_modules', '.bin', 'deka'), '#!/bin/sh\n')
        return { status: 0 }
      }
      return { status: 0 }
    },
    runDekaInit: makeRunDekaInitStub(),
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

test('resolveRuntimeVersion: pins ownVersion directly, with no spawn/network call', () => {
  const version = resolveRuntimeVersion({ ownVersion: '0.53.4' })
  assert.equal(version, '0.53.4')
})

test('resolveRuntimeVersion: requires ownVersion', () => {
  assert.throws(() => resolveRuntimeVersion({}), /requires ownVersion/)
})

test('resolveLatestRuntimeVersion: returns the trimmed version on a successful lookup', () => {
  const version = resolveLatestRuntimeVersion({
    spawn: () => ({ status: 0, stdout: '0.53.4\n' }),
    log: () => {},
  })
  assert.equal(version, '0.53.4')
})

test('resolveLatestRuntimeVersion: falls back to "latest" on a non-zero exit', () => {
  const logs = []
  const version = resolveLatestRuntimeVersion({
    spawn: () => ({ status: 1, stdout: '', stderr: 'ETARGET' }),
    log: (msg) => logs.push(msg),
  })
  assert.equal(version, 'latest')
  assert.ok(logs.length > 0, 'must log that it fell back')
})

test('resolveLatestRuntimeVersion: falls back to "latest" when spawn itself errors (npm missing)', () => {
  const version = resolveLatestRuntimeVersion({
    spawn: () => ({ error: new Error('ENOENT: npm not found') }),
    log: () => {},
  })
  assert.equal(version, 'latest')
})

test('resolveLatestRuntimeVersion: falls back to "latest" on empty stdout', () => {
  const version = resolveLatestRuntimeVersion({
    spawn: () => ({ status: 0, stdout: '' }),
    log: () => {},
  })
  assert.equal(version, 'latest')
})

// rfd#68 (Release Channels): create-deka-app@X.Y.Z-canary-<sha> must pin
// @dekaruntime/deka@X.Y.Z-canary-<sha> verbatim -- the exact same lockstep
// contract as a stable version, just proven against a prerelease string so
// a regression that mangles/truncates the "-canary-<sha>" suffix (e.g. a
// naive semver-parse that keeps only X.Y.Z) fails loudly here.
const CANARY_OWN_VERSION = '0.59.0-canary-d5661ed'

test('resolveRuntimeVersion: pins a canary ownVersion verbatim, suffix and all', () => {
  const version = resolveRuntimeVersion({ ownVersion: CANARY_OWN_VERSION })
  assert.equal(version, CANARY_OWN_VERSION)
})

test("generated package.json pins create-deka-app's own canary version exactly, including the -canary-<sha> suffix", async () => {
  const cwd = tmp('cda-canary-pkgjson-')
  const calls = []

  await createApp({
    targetArg: 'myapp',
    cwd,
    env: {},
    platform: 'linux',
    arch: 'x64',
    ownVersion: CANARY_OWN_VERSION,
    log: () => {},
    spawn: makeSpawnStub({ calls }),
    runDekaInit: makeRunDekaInitStub({ calls }),
  })

  const pkg = JSON.parse(readFileSync(path.join(cwd, 'myapp', 'package.json'), 'utf8'))
  assert.equal(
    pkg.devDependencies[RUNTIME_PACKAGE],
    CANARY_OWN_VERSION,
    'a canary create-deka-app must pin the identical canary @dekaruntime/deka version, not a stripped/rounded one'
  )
  assert.ok(
    !calls.some(([cmd, args]) => cmd === 'npm' && args[0] === 'view'),
    'the happy path must not query the registry at all, canary or not'
  )
  rmSync(cwd, { recursive: true, force: true })
})

test('resolveLatestRuntimeVersion: a canary channel looks up the "canary" dist-tag, never "latest"', () => {
  const calls = []
  const version = resolveLatestRuntimeVersion({
    channel: 'canary',
    spawn: (cmd, args) => {
      calls.push([cmd, args])
      return { status: 0, stdout: '0.59.0-canary-e4f5a6b\n' }
    },
    log: () => {},
  })
  assert.equal(version, '0.59.0-canary-e4f5a6b')
  assert.deepEqual(calls, [['npm', ['view', `${RUNTIME_PACKAGE}@canary`, 'version']]])
})

test('resolveLatestRuntimeVersion: an unreachable registry on the canary channel falls back to the "canary" dist-tag, not "latest"', () => {
  const version = resolveLatestRuntimeVersion({
    channel: 'canary',
    spawn: () => ({ status: 1, stdout: '', stderr: 'network timeout' }),
    log: () => {},
  })
  assert.equal(version, 'canary')
})

test('a canary create-deka-app whose exact pin fails to install falls back to the canary dist-tag, not latest stable', async () => {
  const cwd = tmp('cda-canary-fallback-')
  const viewCalls = []
  const installAttempts = []
  const CANARY_FALLBACK_VERSION = '0.59.0-canary-e4f5a6b'

  await createApp({
    targetArg: 'myapp',
    cwd,
    env: {},
    platform: 'linux',
    arch: 'x64',
    ownVersion: CANARY_OWN_VERSION,
    log: () => {},
    spawn: (cmd, args, opts) => {
      if (cmd === 'npm' && args[0] === 'view') {
        viewCalls.push(args[1])
        return { status: 0, stdout: `${CANARY_FALLBACK_VERSION}\n` }
      }
      if (cmd === 'npm' && args[0] === 'install') {
        const pkg = JSON.parse(readFileSync(path.join(opts.cwd, 'package.json'), 'utf8'))
        const pinned = pkg.devDependencies[RUNTIME_PACKAGE]
        installAttempts.push(pinned)
        if (pinned === CANARY_OWN_VERSION) {
          return { status: 1, stdout: '', stderr: 'ETARGET' }
        }
        mkdirSync(path.join(opts.cwd, 'node_modules', '.bin'), { recursive: true })
        writeFileSync(path.join(opts.cwd, 'node_modules', '.bin', 'deka'), '#!/bin/sh\n')
        return { status: 0 }
      }
      return { status: 0 }
    },
    runDekaInit: makeRunDekaInitStub(),
  })

  assert.deepEqual(
    viewCalls,
    [`${RUNTIME_PACKAGE}@canary`],
    'the fallback lookup must ask for the canary dist-tag, matching the running (canary) create-deka-app, not latest'
  )
  assert.deepEqual(installAttempts, [CANARY_OWN_VERSION, CANARY_FALLBACK_VERSION])

  const pkg = JSON.parse(readFileSync(path.join(cwd, 'myapp', 'package.json'), 'utf8'))
  assert.equal(pkg.devDependencies[RUNTIME_PACKAGE], CANARY_FALLBACK_VERSION)
  rmSync(cwd, { recursive: true, force: true })
})

// deka#1103: the actual bug -- `deka` is never on PATH for a project-local
// install, so the "Next steps" must give a command each package manager
// can actually run (its own `dev` script) rather than a bare `deka dev`,
// with the direct node_modules/.bin form mentioned as an alternative.
const NEXT_STEPS_BY_PM = [
  { userAgent: 'npm/10.2.4 node/v20.11.0 linux x64', run: 'npm run dev', direct: 'npx deka dev' },
  { userAgent: 'pnpm/8.15.1 npm/? node/v20.11.0 linux x64', run: 'pnpm dev', direct: 'pnpm exec deka dev' },
  { userAgent: 'yarn/1.22.19 npm/? node/v20.11.0 linux x64', run: 'yarn dev', direct: 'yarn deka dev' },
  { userAgent: 'bun/1.1.0 npm/? node/v20.11.0 linux x64', run: 'bun dev', direct: 'bunx deka dev' },
]

for (const { userAgent, run: runCmd, direct } of NEXT_STEPS_BY_PM) {
  test(`next steps for ${userAgent.split('/')[0]}: "${runCmd}" with "${direct}" as the direct alternative`, async () => {
    const cwd = tmp('cda-nextsteps-pm-')
    const logs = []

    await createApp({
      targetArg: 'myapp',
      cwd,
      env: { npm_config_user_agent: userAgent },
      platform: 'linux',
      arch: 'x64',
      ownVersion: OWN_VERSION,
      log: (msg) => logs.push(msg),
      spawn: makeSpawnStub({}),
      runDekaInit: makeRunDekaInitStub({ initOutput: REAL_DEKA_INIT_OUTPUT }),
    })

    const output = logs.join('\n')
    assert.ok(
      logs.some((line) => line.includes(runCmd)),
      `expected a line with "${runCmd}"; got:\n${output}`
    )
    assert.ok(
      logs.some((line) => line.includes(direct)),
      `expected the direct alternative "${direct}" to be mentioned; got:\n${output}`
    )
    rmSync(cwd, { recursive: true, force: true })
  })
}

test('the deka banner is printed once, as the very first output, before the install step', async () => {
  const cwd = tmp('cda-banner-')
  const logs = []

  await createApp({
    targetArg: 'myapp',
    cwd,
    env: { npm_config_user_agent: 'npm/10.2.4 node/v20.11.0 linux x64' },
    platform: 'linux',
    arch: 'x64',
    ownVersion: OWN_VERSION,
    log: (msg) => logs.push(msg),
    spawn: makeSpawnStub({}),
    runDekaInit: makeRunDekaInitStub({ initOutput: REAL_DEKA_INIT_OUTPUT }),
  })

  const bannerIndex = logs.findIndex((line) => /[░█]/.test(line))
  const installIndex = logs.findIndex((line) => /Installing the deka runtime/.test(line))

  assert.notEqual(bannerIndex, -1, 'the banner must be printed')
  assert.notEqual(installIndex, -1, 'the install step line must be printed')
  assert.equal(bannerIndex, 0, 'the banner must be the very first thing printed')
  assert.ok(bannerIndex < installIndex, 'the banner must come before the install step')

  // Only one `log()` call contains banner glyphs -- create-deka-app's own,
  // printed up front. (Whether deka init's own copy would have been a
  // second one is covered separately, at the filter level, in
  // test/init-output-filter.test.js -- REAL_DEKA_INIT_OUTPUT here carries
  // no banner text of its own.)
  const bannerLogCalls = logs.filter((line) => /[░█]/.test(line))
  assert.equal(bannerLogCalls.length, 1, `expected exactly one log() call with banner glyphs; got:\n${logs.join('\n')}`)
  rmSync(cwd, { recursive: true, force: true })
})
