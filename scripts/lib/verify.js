// Download-and-verify: streams a URL to disk while hashing it, and fails
// closed -- any checksum mismatch, or any error mid-download, removes the
// partial/bad file rather than leaving something that looks installed.
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

export class ChecksumMismatchError extends Error {
  constructor(url, expected, actual) {
    super(`checksum mismatch for ${url}: expected ${expected}, got ${actual}`)
    this.name = 'ChecksumMismatchError'
    this.url = url
    this.expected = expected
    this.actual = actual
  }
}

export async function downloadAndVerify(url, expectedSha256, destPath, { fetchImpl = fetch } = {}) {
  const expected = String(expectedSha256).toLowerCase()
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true })

  const res = await fetchImpl(url)
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`)
  }
  if (!res.body) {
    throw new Error(`GET ${url} returned no body`)
  }

  const hash = crypto.createHash('sha256')
  const tmpPath = `${destPath}.download`

  try {
    const writeStream = fs.createWriteStream(tmpPath)
    // Web ReadableStream (global fetch) -> Node stream, hashing every chunk
    // as it passes through rather than buffering the whole file in memory.
    const nodeReadable = Readable.fromWeb ? Readable.fromWeb(res.body) : Readable.from(res.body)

    nodeReadable.on('data', (chunk) => hash.update(chunk))
    await pipeline(nodeReadable, writeStream)

    const actual = hash.digest('hex')
    if (actual !== expected) {
      throw new ChecksumMismatchError(url, expected, actual)
    }

    await fs.promises.rename(tmpPath, destPath)
    return { path: destPath, sha256: actual }
  } catch (err) {
    // Fail closed: never leave a partial or mismatched file behind under
    // the real destination name.
    await fs.promises.rm(tmpPath, { force: true })
    await fs.promises.rm(destPath, { force: true })
    throw err
  }
}
