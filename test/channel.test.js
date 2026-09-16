// src/channel.js is the single source of truth for "which channel is this
// version on" -- shared by the shipped CLI (src/scaffold.js) and the
// release pipeline (scripts/lib/manifest.js). rfd#68 (Release Channels).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { versionChannel, distTagFor, baseVersionOf } from '../src/channel.js'

test('versionChannel: a plain X.Y.Z is stable', () => {
  assert.equal(versionChannel('0.59.0'), 'stable')
})

test('versionChannel: X.Y.Z-canary-<7hex> is canary', () => {
  assert.equal(versionChannel('0.59.0-canary-d5661ed'), 'canary')
})

test('versionChannel: an unrelated prerelease suffix is not mistaken for canary', () => {
  assert.equal(versionChannel('0.59.0-beta.1'), 'stable')
})

test('distTagFor: canary -> "canary", everything else -> "latest"', () => {
  assert.equal(distTagFor('canary'), 'canary')
  assert.equal(distTagFor('stable'), 'latest')
  assert.equal(distTagFor(undefined), 'latest')
})

test('baseVersionOf: prefers an explicit base_version field on the manifest', () => {
  assert.equal(
    baseVersionOf('0.59.0-canary-d5661ed', { base_version: '0.59.0' }),
    '0.59.0'
  )
})

test('baseVersionOf: falls back to stripping "-canary-<sha>" when the manifest has no base_version (pre-rfd#68 manifest)', () => {
  assert.equal(baseVersionOf('0.59.0-canary-d5661ed', null), '0.59.0')
  assert.equal(baseVersionOf('0.59.0-canary-d5661ed', {}), '0.59.0')
  assert.equal(baseVersionOf('0.59.0-canary-d5661ed', { base_version: '' }), '0.59.0')
})

test('baseVersionOf: a stable version is its own base version', () => {
  assert.equal(baseVersionOf('0.59.0', null), '0.59.0')
})
