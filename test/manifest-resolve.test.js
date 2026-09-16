// Exercises scripts/lib/manifest.js against the real, live manifests
// (releases.deka.gg and dsc-wasm.deka.gg). These are small JSON documents,
// so this stays fast; it never downloads a binary. It is the proof that
// the URL shapes CI depends on (no "v" for deka, "v" for dsc) are correct
// against the real hosts, not just against a mock.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveLatestVersion, resolveManifest, PLATFORMS } from '../scripts/lib/manifest.js'

function assertManifestShape(manifest, family, version) {
  assert.equal(manifest.family, family)
  assert.equal(manifest.version, version)
  for (const platform of PLATFORMS) {
    const entry = manifest.binaries[platform]
    assert.ok(entry, `missing binaries.${platform}`)
    assert.match(entry.sha256, /^[0-9a-f]{64}$/, `binaries.${platform}.sha256 must be 64 lowercase hex chars`)
    assert.ok(entry.url.includes(version), `binary URL must be pinned to ${version}, got ${entry.url}`)
  }
}

test('deka: resolves the real latest.json and release.json manifest', { timeout: 15000 }, async () => {
  const version = await resolveLatestVersion('deka')
  assert.match(version, /^\d+\.\d+\.\d+/)

  const manifest = await resolveManifest('deka', version)
  assertManifestShape(manifest, 'deka', version)

  // deka's manifest URL and binary URL never carry a "v" prefix.
  for (const platform of PLATFORMS) {
    assert.ok(manifest.binaries[platform].url.startsWith(`https://releases.deka.gg/${version}/`))
  }
})

test('dsc: resolves the real latest/release.json and v<version>/release.json manifest', { timeout: 15000 }, async () => {
  const version = await resolveLatestVersion('dsc')
  assert.match(version, /^\d+\.\d+\.\d+/)

  const manifest = await resolveManifest('dsc', version)
  assertManifestShape(manifest, 'dsc', version)

  // dsc's manifest URL and binary URL always carry a "v" prefix.
  for (const platform of PLATFORMS) {
    assert.ok(manifest.binaries[platform].url.startsWith(`https://dsc-wasm.deka.gg/v${version}/`))
  }
})

test(
  'a binary URL from the real manifest actually serves bytes (ranged GET, no full download)',
  { timeout: 15000 },
  async () => {
    const version = await resolveLatestVersion('deka')
    const manifest = await resolveManifest('deka', version)
    const url = manifest.binaries['linux-x64'].url

    const res = await fetch(url, { headers: { Range: 'bytes=0-63' } })
    assert.ok(res.status === 200 || res.status === 206, `expected 200/206 for a ranged GET, got ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    assert.ok(buf.length > 0, 'expected some bytes back')
  }
)

test('resolveManifest rejects a manifest whose reported version does not match the requested one', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ version: '9.9.9', binaries: {} }),
  })
  await assert.rejects(
    () => resolveManifest('deka', '1.2.3', fakeFetch),
    /reports version "9.9.9", expected "1.2.3"/
  )
})
