import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'

const require = createRequire(import.meta.url)
// npm/deka/launcher-core.js is CommonJS on purpose: each launcher package
// must be self-contained once published, and its own package.json (no
// "type" field) makes that directory tree CommonJS regardless of this
// repo's root "type": "module". require() is the correct way to load it.
const core = require('../npm/deka/launcher-core.js')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_PKG = path.join(__dirname, 'fixtures', 'pkg')

test('platformKey composes platform and arch', () => {
  assert.equal(core.platformKey('darwin', 'arm64'), 'darwin-arm64')
  assert.equal(core.platformKey('linux', 'x64'), 'linux-x64')
})

test('isSupportedPlatform matches exactly the three shipped platforms', () => {
  assert.equal(core.isSupportedPlatform('darwin-arm64'), true)
  assert.equal(core.isSupportedPlatform('darwin-x64'), true)
  assert.equal(core.isSupportedPlatform('linux-x64'), true)
  assert.equal(core.isSupportedPlatform('win32-x64'), false)
  assert.equal(core.isSupportedPlatform('linux-arm64'), false)
})

test('unsupportedPlatformMessage names the shipped platforms and the tracking issue', () => {
  const msg = core.unsupportedPlatformMessage('deka', 'win32-x64')
  assert.match(msg, /win32-x64/)
  assert.match(msg, /darwin-arm64/)
  assert.match(msg, /darwin-x64/)
  assert.match(msg, /linux-x64/)
  assert.match(msg, /dekaruntime\/deka\/issues\/1092/)
})

test('resolvePlatformPackageDir: require.resolve success', () => {
  const found = core.resolvePlatformPackageDir('@dekaruntime/deka-linux-x64', '/launcher', {
    resolve: () => '/root/node_modules/@dekaruntime/deka-linux-x64/package.json',
  })
  assert.equal(found, '/root/node_modules/@dekaruntime/deka-linux-x64')
})

test('resolvePlatformPackageDir: falls back to nested node_modules when require.resolve fails', () => {
  const nestedPkgJson = path.join('/launcher', 'node_modules', '@dekaruntime/deka-linux-x64', 'package.json')
  const found = core.resolvePlatformPackageDir('@dekaruntime/deka-linux-x64', '/launcher', {
    resolve: () => {
      throw new Error('MODULE_NOT_FOUND')
    },
    existsSync: (p) => p === nestedPkgJson,
  })
  assert.equal(found, path.dirname(nestedPkgJson))
})

test('resolvePlatformPackageDir: returns null when neither resolution finds the package', () => {
  const found = core.resolvePlatformPackageDir('@dekaruntime/deka-linux-x64', '/launcher', {
    resolve: () => {
      throw new Error('MODULE_NOT_FOUND')
    },
    existsSync: () => false,
  })
  assert.equal(found, null)
})

test('run(): unsupported platform prints a clear message and exits 1 without spawning', async () => {
  const originalError = console.error
  const messages = []
  console.error = (msg) => messages.push(msg)
  const originalExitCode = process.exitCode
  try {
    const result = await core.run({
      family: 'deka',
      platformPackagePrefix: '@dekaruntime/deka',
      binaryName: 'deka',
      launcherDir: __dirname,
      platform: 'win32',
      arch: 'x64',
      resolveDir: () => {
        throw new Error('should not be called for an unsupported platform')
      },
    })
    assert.equal(result.code, 1)
    assert.equal(process.exitCode, 1)
    assert.match(messages.join('\n'), /unsupported platform "win32-x64"/)
  } finally {
    console.error = originalError
    process.exitCode = originalExitCode
  }
})

test('run(): missing platform package prints a clear message and exits 1', async () => {
  const originalError = console.error
  const messages = []
  console.error = (msg) => messages.push(msg)
  const originalExitCode = process.exitCode
  try {
    const result = await core.run({
      family: 'deka',
      platformPackagePrefix: '@dekaruntime/deka',
      binaryName: 'deka',
      launcherDir: __dirname,
      platform: 'linux',
      arch: 'x64',
      resolveDir: () => null,
    })
    assert.equal(result.code, 1)
    assert.equal(process.exitCode, 1)
    assert.match(messages.join('\n'), /could not locate @dekaruntime\/deka-linux-x64/)
  } finally {
    console.error = originalError
    process.exitCode = originalExitCode
  }
})

test('run(): propagates the child exit code verbatim', async () => {
  const originalExitCode = process.exitCode
  try {
    const result = await core.run({
      family: 'deka',
      platformPackagePrefix: '@dekaruntime/deka',
      binaryName: 'deka', // fixtures/pkg/bin/deka exits with argv[2]
      launcherDir: __dirname,
      platform: 'linux',
      arch: 'x64',
      argv: ['7'],
      resolveDir: () => FIXTURE_PKG,
    })
    assert.equal(result.code, 7)
    assert.equal(process.exitCode, 7)
  } finally {
    process.exitCode = originalExitCode
  }
})

test('run(): exit code 0 is propagated (not coerced to a truthy failure)', async () => {
  const originalExitCode = process.exitCode
  try {
    const result = await core.run({
      family: 'deka',
      platformPackagePrefix: '@dekaruntime/deka',
      binaryName: 'deka',
      launcherDir: __dirname,
      platform: 'linux',
      arch: 'x64',
      argv: ['0'],
      resolveDir: () => FIXTURE_PKG,
    })
    assert.equal(result.code, 0)
    assert.equal(process.exitCode, 0)
  } finally {
    process.exitCode = originalExitCode
  }
})

// fixtures/signal-trap.js prints this once its own signal handlers are
// registered. Waiting for it (rather than a fixed sleep) avoids a race
// under CI load, where multiple test files run concurrently and process
// startup can take longer than a fixed delay would assume.
function waitForReady(child, marker) {
  return new Promise((resolve, reject) => {
    let buf = ''
    const onData = (chunk) => {
      buf += chunk.toString()
      if (buf.includes(marker)) {
        child.stdout.off('data', onData)
        resolve()
      }
    }
    child.stdout.on('data', onData)
    child.once('error', reject)
  })
}

test('run(): forwards SIGINT to the child (Ctrl-C during a long-running command reaches it)', async () => {
  // Run the launcher-shaped harness as a real OS subprocess -- not
  // core.run() executed in-process -- so the SIGINT we send targets a
  // dedicated process exactly the way a user's shell signals a real `deka`
  // invocation, without touching the test runner's own signal handling.
  const harnessPath = path.join(__dirname, 'fixtures', 'wrapper-harness.cjs')
  const harness = spawn(process.execPath, [harnessPath], { stdio: ['ignore', 'pipe', 'pipe'] })

  const exited = new Promise((resolve) => {
    harness.on('exit', (code, signal) => resolve({ code, signal }))
  })

  // The harness's child (signal-trap.js) inherits the harness's stdio, so
  // its "ready" marker arrives on harness.stdout. Only once its SIGINT
  // handler is actually registered do we deliver SIGINT to the harness --
  // the wrapper process -- exactly as a shell would on Ctrl-C.
  await waitForReady(harness, 'signal-trap ready')
  harness.kill('SIGINT')

  const result = await exited
  assert.equal(
    result.code,
    42,
    `the child trapped SIGINT and exit(42)'d; that must survive through the wrapper (got code=${result.code} signal=${result.signal})`
  )
  assert.equal(result.signal, null, 'the wrapper should exit via exit code, not be killed by a raw signal itself')
})

test('run(): forwards SIGTERM to the child as well', async () => {
  const harnessPath = path.join(__dirname, 'fixtures', 'wrapper-harness.cjs')
  const harness = spawn(process.execPath, [harnessPath], { stdio: ['ignore', 'pipe', 'pipe'] })

  const exited = new Promise((resolve) => {
    harness.on('exit', (code, signal) => resolve({ code, signal }))
  })

  await waitForReady(harness, 'signal-trap ready')
  harness.kill('SIGTERM')

  const result = await exited
  assert.equal(result.code, 43, `expected the SIGTERM trap's exit code (got code=${result.code} signal=${result.signal})`)
})

test('run(): does not leak its SIGINT/SIGTERM listeners after the child exits', async () => {
  const before = process.listenerCount('SIGINT')
  await core.run({
    family: 'deka',
    platformPackagePrefix: '@dekaruntime/deka',
    binaryName: 'deka',
    launcherDir: __dirname,
    platform: 'linux',
    arch: 'x64',
    argv: ['0'],
    resolveDir: () => FIXTURE_PKG,
  })
  process.exitCode = 0
  assert.equal(process.listenerCount('SIGINT'), before)
})
