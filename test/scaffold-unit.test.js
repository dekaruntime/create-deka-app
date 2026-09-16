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
function makeSpawnStub({ calls = [], viewStdout = '9.9.9\n' } = {}) {
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
    return { status: 0 }
  }
}

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
  assert.deepEqual(calls[2][1], ['init'])
  rmSync(cwd, { recursive: true, force: true })
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
