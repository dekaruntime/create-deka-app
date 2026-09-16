// Proves scripts/lib/verify.js's downloadAndVerify() fails closed: a good
// checksum lands the file, a deliberately corrupted checksum must throw
// and must not leave a file (partial or otherwise) behind. Uses a local
// HTTP server serving fixed bytes so the test is fast and deterministic --
// no network, no multi-hundred-MB download.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { downloadAndVerify, ChecksumMismatchError } from '../scripts/lib/verify.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const FIXTURE_BYTES = crypto.randomBytes(4096)
const GOOD_SHA256 = crypto.createHash('sha256').update(FIXTURE_BYTES).digest('hex')
// A deliberately corrupted checksum: well-formed hex, does not match what
// the server actually serves.
const BAD_SHA256 = crypto
  .createHash('sha256')
  .update(Buffer.concat([FIXTURE_BYTES, Buffer.from('x')]))
  .digest('hex')

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      res.end(FIXTURE_BYTES)
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function tmpDir() {
  // Never /tmp: scratch lives under this checkout's own .tmp.
  const dir = path.join(__dirname, '..', '.tmp', `verify-test-${crypto.randomBytes(4).toString('hex')}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

test('downloadAndVerify: a correct sha256 writes the file with the exact bytes served', async (t) => {
  const server = await startServer()
  t.after(() => server.close())
  const dir = tmpDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const { port } = server.address()
  const dest = path.join(dir, 'good-binary')

  const result = await downloadAndVerify(`http://127.0.0.1:${port}/binary`, GOOD_SHA256, dest)

  assert.equal(result.sha256, GOOD_SHA256)
  assert.ok(fs.existsSync(dest))
  assert.ok(FIXTURE_BYTES.equals(fs.readFileSync(dest)), 'downloaded bytes must match what was served')
  assert.ok(!fs.existsSync(`${dest}.download`), 'no leftover temp file after a successful download')
})

test('downloadAndVerify: a deliberately corrupted checksum fails closed -- throws, and leaves nothing on disk', async (t) => {
  const server = await startServer()
  t.after(() => server.close())
  const dir = tmpDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const { port } = server.address()
  const dest = path.join(dir, 'bad-binary')

  await assert.rejects(
    () => downloadAndVerify(`http://127.0.0.1:${port}/binary`, BAD_SHA256, dest),
    (err) => {
      assert.ok(err instanceof ChecksumMismatchError)
      assert.equal(err.expected, BAD_SHA256)
      assert.equal(err.actual, GOOD_SHA256)
      return true
    }
  )

  // Fail closed: neither the final path nor a partial temp file survives.
  assert.ok(!fs.existsSync(dest), 'a checksum mismatch must not leave the destination file behind')
  assert.ok(!fs.existsSync(`${dest}.download`), 'a checksum mismatch must not leave a partial temp file behind')
})

test('downloadAndVerify: an HTTP error status fails closed with no file written', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(404)
    res.end('not found')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const dir = tmpDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const { port } = server.address()
  const dest = path.join(dir, 'missing-binary')

  await assert.rejects(() => downloadAndVerify(`http://127.0.0.1:${port}/nope`, GOOD_SHA256, dest), /404/)
  assert.ok(!fs.existsSync(dest))
})
