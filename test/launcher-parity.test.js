// npm/deka/launcher-core.js and npm/dsc/launcher-core.js must be
// byte-identical: each launcher package has to be self-contained once
// published (npm only packs a package's own directory), so the shared
// logic is duplicated rather than imported across packages. This test is
// the drift guard that duplication needs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

test('npm/deka/launcher-core.js and npm/dsc/launcher-core.js are byte-identical', () => {
  const a = fs.readFileSync(path.join(__dirname, '..', 'npm', 'deka', 'launcher-core.js'))
  const b = fs.readFileSync(path.join(__dirname, '..', 'npm', 'dsc', 'launcher-core.js'))
  assert.ok(a.equals(b), 'npm/deka/launcher-core.js and npm/dsc/launcher-core.js have drifted apart')
})

test('both bin.js wrappers guard their entry point behind require.main', () => {
  for (const pkg of ['deka', 'dsc']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'npm', pkg, 'bin.js'), 'utf8')
    assert.match(
      src,
      /require\.main === module/,
      `npm/${pkg}/bin.js should guard its side effect so it can be require()'d in tests`
    )
  }
})
