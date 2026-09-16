import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { smokeTestVersion } from '../scripts/sync.js'
import { baseVersionOf } from '../src/channel.js'

// deka and dsc print their version banner on STDERR and exit 0. A stdout-only
// read returns '' and rejects a good binary — that failure aborted the first
// real publish run (create-deka-app run 35041417592).
function stubBinary(dir, name, body) {
  const p = join(dir, name)
  writeFileSync(p, `#!/bin/sh\n${body}\n`)
  chmodSync(p, 0o755)
  return p
}

test('accepts a binary that prints its version on stderr', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-'))
  const bin = stubBinary(dir, 'dsc', 'echo "dsc [version 0.53.4]" >&2')
  assert.match(smokeTestVersion(bin, '0.53.4'), /0\.53\.4/)
})

test('accepts a binary that prints its version on stdout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-'))
  const bin = stubBinary(dir, 'deka', 'echo "deka [version 0.53.4]"')
  assert.match(smokeTestVersion(bin, '0.53.4'), /0\.53\.4/)
})

test('rejects a binary reporting the wrong version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-'))
  const bin = stubBinary(dir, 'dsc', 'echo "dsc [version 0.52.0]" >&2')
  assert.throws(() => smokeTestVersion(bin, '0.53.4'), /did not mention 0\.53\.4/)
})

test('rejects a binary that prints nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-'))
  const bin = stubBinary(dir, 'dsc', 'true')
  assert.throws(() => smokeTestVersion(bin, '0.53.4'), /did not mention/)
})

test('rejects a binary that exits non-zero', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-'))
  const bin = stubBinary(dir, 'dsc', 'echo "dsc [version 0.53.4]" >&2; exit 3')
  assert.throws(() => smokeTestVersion(bin, '0.53.4'), /exited 3/)
})

// rfd#68: a canary binary's --version banner names the BASE version plus a
// commit sha -- promotion republishes the exact same bytes under the plain
// tag, so the binary never learns it was ever built as a canary. The smoke
// test (scripts/sync.js) must therefore compare against base_version, not
// the full "-canary-<sha>" version string it downloaded under.
test('canary binary: --version reports the base version, and the smoke test must be run against base_version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-'))
  const bin = stubBinary(dir, 'dsc', 'echo "dsc [version 0.59.0 (d5661ed)]" >&2')

  const manifest = { version: '0.59.0-canary-d5661ed', base_version: '0.59.0' }
  const expected = baseVersionOf(manifest.version, manifest)
  assert.equal(expected, '0.59.0')
  assert.match(smokeTestVersion(bin, expected), /0\.59\.0/)
})

test('canary binary: comparing against the FULL "-canary-<sha>" version (the bug this guards against) wrongly rejects a good build', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-'))
  const bin = stubBinary(dir, 'dsc', 'echo "dsc [version 0.59.0 (d5661ed)]" >&2')
  assert.throws(
    () => smokeTestVersion(bin, '0.59.0-canary-d5661ed'),
    /did not mention 0\.59\.0-canary-d5661ed/,
    'a real canary binary never prints its own "-canary-<sha>" suffix, so comparing against the full version must fail'
  )
})

test('canary binary: a manifest with no base_version (pre-rfd#68) still smoke-tests correctly via the stripped fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-'))
  const bin = stubBinary(dir, 'deka', 'echo "deka [version 0.59.0 (d5661ed)]"')
  const expected = baseVersionOf('0.59.0-canary-d5661ed', null)
  assert.match(smokeTestVersion(bin, expected), /0\.59\.0/)
})
