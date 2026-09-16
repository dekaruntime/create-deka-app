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

// rfd#68 (Release Channels): a canary's per-version path shape is IDENTICAL
// to stable's for both families -- only the pointer file (latest.json vs
// canary.json / latest/release.json vs canary/release.json) differs. deka
// has never used a "v" prefix on its version path; dsc has always used one.
// These use a fake fetch (no live network -- there is no guarantee a real
// canary is live on either host at test time) to prove the URL shapes
// scripts/sync.js depends on.
function fakeManifestFetch(expectedUrl, version) {
  return async (url) => {
    assert.equal(url, expectedUrl, `expected exactly one GET, to ${expectedUrl}`)
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        version,
        channel: 'canary',
        base_version: version.replace(/-canary-[0-9a-f]+$/i, ''),
        binaries: Object.fromEntries(
          PLATFORMS.map((p) => [p, { name: 'x', sha256: '0'.repeat(64) }])
        ),
      }),
    }
  }
}

test('deka: a canary version builds a "v"-free path, exactly like stable, just with the full canary string', async () => {
  const version = '0.59.0-canary-d5661ed'
  const manifest = await resolveManifest(
    'deka',
    version,
    fakeManifestFetch(`https://releases.deka.gg/${version}/release.json`, version)
  )
  assert.equal(manifest.version, version)
  assert.equal(manifest.channel, 'canary')
  assert.equal(manifest.base_version, '0.59.0')
  for (const platform of PLATFORMS) {
    assert.equal(manifest.binaries[platform].url, `https://releases.deka.gg/${version}/x`)
  }
})

test('dsc: a canary version keeps the "v" prefix, exactly like stable, just with the full canary string', async () => {
  const version = '0.58.3-canary-a1b2c3d'
  const manifest = await resolveManifest(
    'dsc',
    version,
    fakeManifestFetch(`https://dsc-wasm.deka.gg/v${version}/release.json`, version)
  )
  assert.equal(manifest.version, version)
  for (const platform of PLATFORMS) {
    assert.equal(manifest.binaries[platform].url, `https://dsc-wasm.deka.gg/v${version}/x`)
  }
})

test('resolveLatestVersion: deka canary reads canary.json, not latest.json', async () => {
  const fakeFetch = async (url) => {
    assert.equal(url, 'https://releases.deka.gg/canary.json')
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ version: '0.59.0-canary-d5661ed' }) }
  }
  const version = await resolveLatestVersion('deka', 'canary', fakeFetch)
  assert.equal(version, '0.59.0-canary-d5661ed')
})

test('resolveLatestVersion: dsc canary reads canary/release.json, not latest/release.json', async () => {
  const fakeFetch = async (url) => {
    assert.equal(url, 'https://dsc-wasm.deka.gg/canary/release.json')
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ version: '0.58.3-canary-a1b2c3d' }) }
  }
  const version = await resolveLatestVersion('dsc', 'canary', fakeFetch)
  assert.equal(version, '0.58.3-canary-a1b2c3d')
})

test('resolveLatestVersion: default channel is "stable" (backward compatible with pre-rfd#68 callers)', async () => {
  const fakeFetch = async (url) => {
    assert.equal(url, 'https://releases.deka.gg/latest.json')
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ version: '0.53.4' }) }
  }
  const version = await resolveLatestVersion('deka', undefined, fakeFetch)
  assert.equal(version, '0.53.4')
})
