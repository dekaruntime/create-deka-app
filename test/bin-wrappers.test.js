// Unit tests for the two bin.js entry points themselves (not just the
// shared core): which binary name they resolve to, and how they wire up
// DEKA_DSC. Both files export their internals rather than running on
// require(), guarded by `if (require.main === module)`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Both bin.js files are CommonJS (see launcher-core.test.js for why).
const dekaBin = require('../npm/deka/bin.js')
const dscBin = require('../npm/dsc/bin.js')

test('deka bin.js resolves "deka" by default and "dsc" when invoked as dsc', () => {
  assert.equal(dekaBin.resolveBinaryName('/usr/local/bin/deka'), 'deka')
  assert.equal(dekaBin.resolveBinaryName('/some/path/dsc'), 'dsc')
  assert.equal(dekaBin.resolveBinaryName(undefined), 'deka')
})

test('deka bin.js sets DEKA_DSC to the sibling dsc only for the deka command, and only if present', () => {
  const fixtureDir = path.join(__dirname, 'fixtures', 'pkg')
  assert.ok(fs.existsSync(path.join(fixtureDir, 'bin', 'dsc')), 'fixture must ship a sibling dsc')

  const envForDeka = dekaBin.makeExtraEnv('deka')(fixtureDir, { PATH: '/bin' })
  assert.equal(envForDeka.DEKA_DSC, path.join(fixtureDir, 'bin', 'dsc'))
  assert.equal(envForDeka.PATH, '/bin', 'must not clobber the rest of the environment')

  const envForDsc = dekaBin.makeExtraEnv('dsc')(fixtureDir, { PATH: '/bin' })
  assert.equal(envForDsc.DEKA_DSC, undefined, 'the dsc command does not need DEKA_DSC set on itself')
})

test('deka bin.js leaves the environment untouched when no sibling dsc exists', () => {
  const envForDeka = dekaBin.makeExtraEnv('deka')('/does/not/exist', { PATH: '/bin' })
  assert.equal(envForDeka.DEKA_DSC, undefined)
})

test('dsc bin.js exposes a main() that runs the dsc family with no dual dispatch', () => {
  assert.equal(typeof dscBin.main, 'function')
})
