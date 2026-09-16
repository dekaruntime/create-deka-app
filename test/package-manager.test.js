import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectPackageManager } from '../src/package-manager.js'

test('detects npm from npm_config_user_agent', () => {
  const pm = detectPackageManager({
    npm_config_user_agent: 'npm/10.2.4 node/v20.11.0 darwin arm64 workspaces/false',
  })
  assert.equal(pm.name, 'npm')
  assert.deepEqual(pm.install, ['npm', ['install']])
})

test('detects pnpm from npm_config_user_agent', () => {
  const pm = detectPackageManager({
    npm_config_user_agent: 'pnpm/8.15.1 npm/? node/v20.11.0 darwin arm64',
  })
  assert.equal(pm.name, 'pnpm')
  assert.deepEqual(pm.install, ['pnpm', ['install']])
})

test('detects yarn from npm_config_user_agent', () => {
  const pm = detectPackageManager({
    npm_config_user_agent: 'yarn/1.22.19 npm/? node/v20.11.0 darwin arm64',
  })
  assert.equal(pm.name, 'yarn')
  assert.deepEqual(pm.install, ['yarn', ['install']])
})

test('detects bun from npm_config_user_agent', () => {
  const pm = detectPackageManager({
    npm_config_user_agent: 'bun/1.0.25 npm/? node/v20.11.0 darwin arm64',
  })
  assert.equal(pm.name, 'bun')
  assert.deepEqual(pm.install, ['bun', ['install']])
})

test('falls back to npm_execpath when npm_config_user_agent is absent', () => {
  assert.equal(
    detectPackageManager({ npm_execpath: '/opt/homebrew/lib/node_modules/pnpm/bin/pnpm.cjs' }).name,
    'pnpm'
  )
  assert.equal(detectPackageManager({ npm_execpath: '/usr/local/bin/yarn.js' }).name, 'yarn')
  assert.equal(
    detectPackageManager({ npm_execpath: '/usr/local/lib/node_modules/bun/bin/bun.js' }).name,
    'bun'
  )
})

test('defaults to npm when nothing is detectable', () => {
  assert.equal(detectPackageManager({}).name, 'npm')
})
