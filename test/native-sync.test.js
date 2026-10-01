import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sync, parseArgs } from '../scripts/sync.js'

test('native deka sync rejects a legacy release before downloading any executable', async t => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return new Response(JSON.stringify({ version: '0.60.1', dsc_version: '0.53.5', binaries: Object.fromEntries(['linux-x64', 'darwin-x64', 'darwin-arm64'].map(p => [p, { name: `deka-${p}`, sha256: '0'.repeat(64) }])) }))
  }
  t.after(() => { globalThis.fetch = original })
  await assert.rejects(sync({ family: 'deka', version: '0.60.1' }), /native VM contract/)
  assert.equal(calls, 1)
})
test('native sync command has no standalone compiler pin', () => {
  assert.equal(parseArgs(['--family', 'deka', '--version', '0.60.1']).family, 'deka')
  assert.throws(() => parseArgs(['--family', 'deka', '--version', '0.60.1', '--dsc-version', '0.53.5']), /unknown argument/)
})
