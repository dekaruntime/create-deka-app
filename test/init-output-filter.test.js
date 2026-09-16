// Unit tests for createInitOutputFilter (src/init-output-filter.js), the
// streaming line filter that sits between deka init's real stdout and
// create-deka-app's own output -- see runDekaInitStreaming in
// src/scaffold.js, the only place this is meant to be piped from.
//
// These feed the filter a fake child stdout (writing it directly, the way
// `child.stdout.pipe(filter)` would) and assert on what comes out the
// other end -- no real process involved.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInterface } from 'node:readline'
import { createInitOutputFilter } from '../src/init-output-filter.js'
import { BANNER } from '../src/banner.js'

// Collects every line the filter emits, in the order it emits them, by
// piping it through readline the same way runDekaInitStreaming does.
function collectLines(filter) {
  const lines = []
  const rl = createInterface({ input: filter, crlfDelay: Infinity })
  rl.on('line', (line) => lines.push(line))
  return new Promise((resolve) => {
    rl.on('close', () => resolve(lines))
  })
}

// The real deka init output shape (banner, per-file [create] lines,
// "[init] ... ready", then a blank line + "Next steps:" + its indented
// commands) -- captured from the real v0.53.7 binary, see the PR
// description for the raw bytes.
const FULL_REAL_OUTPUT =
  `${BANNER}\n` +
  '\n' +
  '[create] myapp/deka.json\n' +
  '[create] myapp/deka.lock\n' +
  '[create] myapp/.gitignore\n' +
  '[create] myapp/index.html\n' +
  '[create] myapp/app/layout.dsx\n' +
  '[create] myapp/app/page.dsx\n' +
  '[create] myapp/app/Counter.dsx\n' +
  '[create] myapp/public/style.css\n' +
  '[create] myapp/public/404.html\n' +
  '[create] myapp/public/favicon.ico\n' +
  '[init] DekaScript app ready\n' +
  '\n' +
  '  Next steps:\n' +
  '  cd myapp\n' +
  '  deka dev\n'

test('only the [create]/[init] progress lines pass through; banner and Next steps are both dropped, order preserved', async () => {
  const filter = createInitOutputFilter()
  const linesPromise = collectLines(filter)
  filter.end(FULL_REAL_OUTPUT)
  const lines = await linesPromise

  const expected = [
    // The blank line deka prints between its own banner (stripped) and its
    // first [create] line is not part of the "Next steps" block, so it is
    // not suppressed -- only a blank line immediately followed by the
    // "Next steps:" heading is.
    '',
    '[create] myapp/deka.json',
    '[create] myapp/deka.lock',
    '[create] myapp/.gitignore',
    '[create] myapp/index.html',
    '[create] myapp/app/layout.dsx',
    '[create] myapp/app/page.dsx',
    '[create] myapp/app/Counter.dsx',
    '[create] myapp/public/style.css',
    '[create] myapp/public/404.html',
    '[create] myapp/public/favicon.ico',
    '[init] DekaScript app ready',
  ]

  // Every banner/glyph and "Next steps" line must be gone.
  assert.ok(
    !lines.some((line) => /[░█]/.test(line)),
    `no banner glyphs may survive; got:\n${lines.join('\n')}`
  )
  assert.ok(
    !lines.some((line) => /Next steps:/.test(line)),
    `the "Next steps:" heading must be dropped; got:\n${lines.join('\n')}`
  )
  assert.ok(
    !lines.some((line) => /^\s*deka dev\s*$/.test(line)),
    `deka's own bare "deka dev" suggestion must be dropped; got:\n${lines.join('\n')}`
  )
  assert.ok(
    !lines.some((line) => /^\s*cd myapp\s*$/.test(line)),
    `deka's own "cd myapp" line (part of its Next steps block) must be dropped; got:\n${lines.join('\n')}`
  )

  // Everything else survives, in the same relative order it arrived in.
  assert.deepEqual(lines, expected, `expected exactly the [create]/[init] lines, in order; got:\n${lines.join('\n')}`)
})

test('feeding the stream in arbitrary chunk boundaries (mid-line splits) produces the same result', async () => {
  // Simulates a real child process: data arrives in whatever chunks the OS
  // pipe happens to deliver, which very often split a line across two
  // chunks. The filter buffers partial lines internally (see `carry` in
  // src/init-output-filter.js) -- this proves that actually works, not
  // just the single-write case above.
  const filter = createInitOutputFilter()
  const linesPromise = collectLines(filter)

  let i = 0
  const chunkSize = 7
  while (i < FULL_REAL_OUTPUT.length) {
    filter.write(FULL_REAL_OUTPUT.slice(i, i + chunkSize))
    i += chunkSize
  }
  filter.end()

  const lines = await linesPromise
  assert.ok(lines.includes('[create] myapp/deka.json'))
  assert.ok(lines.includes('[init] DekaScript app ready'))
  assert.ok(!lines.some((line) => /[░█]/.test(line)))
  assert.ok(!lines.some((line) => /^\s*deka dev\s*$/.test(line)))
})

test('a blank line that is NOT followed by "Next steps:" is forwarded, not eaten', async () => {
  const filter = createInitOutputFilter()
  const linesPromise = collectLines(filter)
  filter.end('[create] myapp/deka.json\n\n[create] myapp/deka.lock\n')
  const lines = await linesPromise
  assert.deepEqual(lines, ['[create] myapp/deka.json', '', '[create] myapp/deka.lock'])
})

test('if deka ever stops printing the Next steps block, the filter is a no-op for it', async () => {
  const filter = createInitOutputFilter()
  const linesPromise = collectLines(filter)
  filter.end('[create] myapp/deka.json\n[init] DekaScript app ready\n')
  const lines = await linesPromise
  assert.deepEqual(lines, ['[create] myapp/deka.json', '[init] DekaScript app ready'])
})

test('if deka ever stops printing the banner, the filter is a no-op for it', async () => {
  const filter = createInitOutputFilter()
  const linesPromise = collectLines(filter)
  filter.end('[create] myapp/deka.json\n')
  const lines = await linesPromise
  assert.deepEqual(lines, ['[create] myapp/deka.json'])
})

test('an empty stream produces no lines', async () => {
  const filter = createInitOutputFilter()
  const linesPromise = collectLines(filter)
  filter.end('')
  const lines = await linesPromise
  assert.deepEqual(lines, [])
})
