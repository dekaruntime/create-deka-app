import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const deka = require('../npm/deka/bin.js')
test('native Deka exposes one command and no compiler environment bridge', () => {
  assert.equal(typeof deka.main, 'function')
  const manifest = require('../npm/deka/package.json')
  assert.deepEqual(manifest.bin, { deka: 'bin.js' })
  assert.equal(manifest.dependencies?.['@dekaruntime/dsc'], undefined)
})
