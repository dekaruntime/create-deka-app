import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp, ScaffoldError, USAGE } from '../src/scaffold.js'
import { run } from '../src/cli.js'

function tmp(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix))
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
        ownVersion: '0.0.2',
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
        ownVersion: '0.0.2',
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
    ownVersion: '0.0.2',
    log: () => {},
    spawn: (cmd, args, opts) => {
      calls.push([cmd, args, opts.cwd])
      if (cmd === 'npm') {
        mkdirSync(path.join(opts.cwd, 'node_modules', '.bin'), { recursive: true })
        writeFileSync(path.join(opts.cwd, 'node_modules', '.bin', 'deka'), '#!/bin/sh\n')
        return { status: 0 }
      }
      return { status: 0 }
    },
  })

  assert.equal(code, 0)
  assert.equal(calls.length, 2, 'expects exactly one install call and one init call')
  assert.deepEqual(calls[0], ['npm', ['install'], target])
  assert.equal(calls[1][0], path.join(target, 'node_modules', '.bin', 'deka'))
  assert.deepEqual(calls[1][1], ['init'])
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
        ownVersion: '0.0.2',
        log: () => {},
        spawn: (cmd, args, opts) => {
          calls.push(cmd)
          return { status: 1 }
        },
      }),
    /"npm install" failed/
  )
  assert.deepEqual(calls, ['npm'], 'deka init must not run after a failed install')
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
        ownVersion: '0.0.2',
        log: () => {},
        // "install" succeeds but never actually creates the binary.
        spawn: () => ({ status: 0 }),
      }),
    /was not found after "npm install"/
  )
  rmSync(cwd, { recursive: true, force: true })
})

test('generated package.json pins @dekaruntime/deka at this package\'s own version', () => {
  const cwd = tmp('cda-pkgjson-')
  createApp({
    targetArg: 'myapp',
    cwd,
    env: {},
    platform: 'linux',
    arch: 'x64',
    ownVersion: '1.2.3',
    log: () => {},
    spawn: (cmd, args, opts) => {
      if (cmd === 'npm') {
        mkdirSync(path.join(opts.cwd, 'node_modules', '.bin'), { recursive: true })
        writeFileSync(path.join(opts.cwd, 'node_modules', '.bin', 'deka'), '#!/bin/sh\n')
      }
      return { status: 0 }
    },
  })

  const pkg = JSON.parse(readFileSync(path.join(cwd, 'myapp', 'package.json'), 'utf8'))
  assert.equal(pkg.devDependencies['@dekaruntime/deka'], '1.2.3')
  assert.deepEqual(pkg.scripts, { dev: 'deka dev', build: 'deka build', start: 'deka start' })
  rmSync(cwd, { recursive: true, force: true })
})
