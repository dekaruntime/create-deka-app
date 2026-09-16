// End-to-end (within this process) proof that scripts/sync.js itself --
// not just the smokeTestVersion/baseVersionOf helpers in isolation -- wires
// the base-version comparison through correctly for a canary manifest.
// Stubs global fetch (the manifest and the binary bytes) so this needs no
// live network and no real deka.gg/dsc-wasm.deka.gg availability; sync.js
// and its dependencies (scripts/lib/manifest.js, scripts/lib/verify.js) all
// default to the global `fetch`, so overriding it here reaches every layer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sync } from '../scripts/sync.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TMP_ROOT = path.join(__dirname, '..', '.tmp')

function freshRoot(prefix) {
  const dir = path.join(TMP_ROOT, `${prefix}-${crypto.randomBytes(4).toString('hex')}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function stubFetch(routes) {
  return async (url) => {
    const href = String(url)
    for (const [match, respond] of routes) {
      const matches = typeof match === 'string' ? href === match : match.test(href)
      if (matches) return respond()
    }
    throw new Error(`unstubbed fetch: ${href}`)
  }
}

test('sync(): a canary manifest smoke-tests the downloaded binary against base_version, not the full canary version', async (t) => {
  const version = '0.59.0-canary-d5661ed'
  const baseVersion = '0.59.0'
  // The stub binary mimics the real contract: it reports the BASE version
  // on --version, never the "-canary-<sha>" suffix it was published under.
  const binaryScript = `#!/bin/sh\necho "dsc [version ${baseVersion} (d5661ed)]" >&2\n`
  const sha256 = crypto.createHash('sha256').update(binaryScript).digest('hex')

  const manifest = {
    family: 'dsc',
    version,
    channel: 'canary',
    base_version: baseVersion,
    binaries: {
      'darwin-arm64': { name: 'dsc', sha256 },
      'darwin-x64': { name: 'dsc', sha256 },
      'linux-x64': { name: 'dsc', sha256 },
    },
  }

  const manifestUrl = `https://dsc-wasm.deka.gg/v${version}/release.json`
  const binaryUrlPrefix = `https://dsc-wasm.deka.gg/v${version}/`

  const realFetch = globalThis.fetch
  globalThis.fetch = stubFetch([
    [manifestUrl, () => new Response(JSON.stringify(manifest), { status: 200 })],
    [new RegExp(`^${binaryUrlPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), () => new Response(binaryScript, { status: 200 })],
  ])
  t.after(() => {
    globalThis.fetch = realFetch
  })

  const root = freshRoot('sync-canary')
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const summary = await sync({ family: 'dsc', version, root })

  assert.equal(summary.smokeTests.length, 1)
  assert.equal(summary.smokeTests[0].baseVersion, baseVersion)
  assert.match(summary.smokeTests[0].output, /0\.59\.0/)
  assert.doesNotMatch(
    summary.smokeTests[0].output,
    /canary/,
    'the real binary never mentions "canary" in its --version banner'
  )
})

test('sync(): a canary manifest with no base_version (pre-rfd#68) still smoke-tests correctly via the stripped-suffix fallback', async (t) => {
  const version = '0.59.0-canary-e4f5a6b'
  const baseVersion = '0.59.0'
  const binaryScript = `#!/bin/sh\necho "dsc [version ${baseVersion} (e4f5a6b)]" >&2\n`
  const sha256 = crypto.createHash('sha256').update(binaryScript).digest('hex')

  // Deliberately no base_version field.
  const manifest = {
    family: 'dsc',
    version,
    binaries: {
      'darwin-arm64': { name: 'dsc', sha256 },
      'darwin-x64': { name: 'dsc', sha256 },
      'linux-x64': { name: 'dsc', sha256 },
    },
  }

  const manifestUrl = `https://dsc-wasm.deka.gg/v${version}/release.json`
  const binaryUrlPrefix = `https://dsc-wasm.deka.gg/v${version}/`

  const realFetch = globalThis.fetch
  globalThis.fetch = stubFetch([
    [manifestUrl, () => new Response(JSON.stringify(manifest), { status: 200 })],
    [new RegExp(`^${binaryUrlPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), () => new Response(binaryScript, { status: 200 })],
  ])
  t.after(() => {
    globalThis.fetch = realFetch
  })

  const root = freshRoot('sync-canary-nofield')
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const summary = await sync({ family: 'dsc', version, root })

  assert.equal(summary.smokeTests[0].baseVersion, baseVersion)
  assert.match(summary.smokeTests[0].output, /0\.59\.0/)
})

test('sync(): a stable manifest is unaffected -- base version equals the requested version', async (t) => {
  const version = '0.59.0'
  const dscVersion = '0.58.0'
  const dekaScript = `#!/bin/sh\necho "deka [version ${version}]"\n`
  const dscScript = `#!/bin/sh\necho "dsc [version ${dscVersion}]" >&2\n`
  const dekaSha = crypto.createHash('sha256').update(dekaScript).digest('hex')
  const dscSha = crypto.createHash('sha256').update(dscScript).digest('hex')

  const dekaManifest = {
    family: 'deka',
    version,
    channel: 'stable',
    binaries: Object.fromEntries(
      ['darwin-arm64', 'darwin-x64', 'linux-x64'].map((p) => [p, { name: 'deka', sha256: dekaSha }])
    ),
  }
  const dscManifest = {
    family: 'dsc',
    version: dscVersion,
    channel: 'stable',
    binaries: Object.fromEntries(
      ['darwin-arm64', 'darwin-x64', 'linux-x64'].map((p) => [p, { name: 'dsc', sha256: dscSha }])
    ),
  }

  const realFetch = globalThis.fetch
  globalThis.fetch = stubFetch([
    [`https://releases.deka.gg/${version}/release.json`, () => new Response(JSON.stringify(dekaManifest), { status: 200 })],
    [`https://dsc-wasm.deka.gg/v${dscVersion}/release.json`, () => new Response(JSON.stringify(dscManifest), { status: 200 })],
    [new RegExp(`^https://releases\\.deka\\.gg/${version}/`), () => new Response(dekaScript, { status: 200 })],
    [new RegExp(`^https://dsc-wasm\\.deka\\.gg/v${dscVersion}/`), () => new Response(dscScript, { status: 200 })],
  ])
  t.after(() => {
    globalThis.fetch = realFetch
  })

  const root = freshRoot('sync-stable')
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const summary = await sync({ family: 'deka', version, dscVersion, root })

  assert.equal(summary.smokeTests.length, 2)
  const [dekaSmoke, dscSmoke] = summary.smokeTests
  assert.equal(dekaSmoke.baseVersion, version)
  assert.match(dekaSmoke.output, /0\.59\.0/)
  assert.equal(dscSmoke.baseVersion, dscVersion)
  assert.match(dscSmoke.output, /0\.58\.0/)
})
