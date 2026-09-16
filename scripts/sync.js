#!/usr/bin/env node
// CI driver: downloads and verifies the binaries for one release family
// into the npm/<family>-<platform>/bin/ directories in this checkout, then
// smoke-tests the runner-native binary. Nothing is committed -- the CI
// workflow publishes straight from this working tree and discards it.
//
// Usage:
//   node scripts/sync.js --family deka --version 0.53.4 --dsc-version 0.53.4
//   node scripts/sync.js --family dsc  --version 0.53.4
import path from 'node:path'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { resolveManifest, PLATFORMS } from './lib/manifest.js'
import { downloadAndVerify } from './lib/verify.js'

// The workflow runs a single ubuntu-latest job (deka#1091: no per-platform
// build matrix, since nothing is compiled here). Only the linux-x64 binary
// can actually be executed on that runner -- darwin binaries are
// checksum-verified only, which is what the manifest sha256 is for.
export const RUNNER_NATIVE_PLATFORM = 'linux-x64'

export function parseArgs(argv) {
  const args = { root: process.cwd() }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--family') args.family = argv[++i]
    else if (a === '--version') args.version = argv[++i]
    else if (a === '--dsc-version') args.dscVersion = argv[++i]
    else if (a === '--root') args.root = argv[++i]
    else throw new Error(`unknown argument: ${a}`)
  }
  if (!args.family) throw new Error('--family is required')
  if (!args.version) throw new Error('--version is required')
  if (args.family === 'deka' && !args.dscVersion) {
    throw new Error('--dsc-version is required for --family deka (deka pins it in scripts/dsc-version)')
  }
  return args
}

export function smokeTestVersion(binaryPath, expectedVersion) {
  const output = execFileSync(binaryPath, ['--version'], { encoding: 'utf8' })
  if (!output.includes(expectedVersion)) {
    throw new Error(`${binaryPath} --version did not mention ${expectedVersion}: ${output.trim()}`)
  }
  return output.trim()
}

export async function sync(args) {
  const familyManifest = await resolveManifest(args.family, args.version)
  const dscManifest = args.family === 'deka' ? await resolveManifest('dsc', args.dscVersion) : null

  const downloaded = []

  for (const platform of PLATFORMS) {
    const destDir = path.join(args.root, 'npm', `${args.family}-${platform}`, 'bin')

    const entry = familyManifest.binaries[platform]
    const destPath = path.join(destDir, args.family)
    await downloadAndVerify(entry.url, entry.sha256, destPath)
    fs.chmodSync(destPath, 0o755)
    downloaded.push({ platform, binary: args.family, path: destPath, sha256: entry.sha256 })

    if (dscManifest) {
      const dscEntry = dscManifest.binaries[platform]
      const dscDestPath = path.join(destDir, 'dsc')
      await downloadAndVerify(dscEntry.url, dscEntry.sha256, dscDestPath)
      fs.chmodSync(dscDestPath, 0o755)
      downloaded.push({ platform, binary: 'dsc', path: dscDestPath, sha256: dscEntry.sha256 })
    }
  }

  const smokeTests = []
  const nativeFamilyBinary = path.join(args.root, 'npm', `${args.family}-${RUNNER_NATIVE_PLATFORM}`, 'bin', args.family)
  smokeTests.push({
    binary: nativeFamilyBinary,
    version: args.version,
    output: smokeTestVersion(nativeFamilyBinary, args.version),
  })

  if (dscManifest) {
    const nativeDscBinary = path.join(args.root, 'npm', `${args.family}-${RUNNER_NATIVE_PLATFORM}`, 'bin', 'dsc')
    smokeTests.push({
      binary: nativeDscBinary,
      version: args.dscVersion,
      output: smokeTestVersion(nativeDscBinary, args.dscVersion),
    })
  }

  return { family: args.family, version: args.version, dscVersion: args.dscVersion, downloaded, smokeTests }
}

// ESM equivalent of CommonJS's `require.main === module`: true only when
// this file is the one node was invoked on, not when it's imported (e.g.
// by the test suite).
const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedAsScript) {
  sync(parseArgs(process.argv.slice(2)))
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2))
    })
    .catch((err) => {
      console.error(`sync: ${err.message}`)
      process.exitCode = 1
    })
}
