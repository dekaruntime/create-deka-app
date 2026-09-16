import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createApp, ScaffoldError } from './scaffold.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ownPackageJson = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))

/**
 * Entry point used by both index.js (the real CLI) and the test suite
 * (with argv/env/cwd/log overridden). Returns the process exit code rather
 * than calling process.exit itself, so it stays testable.
 */
export function run({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  log = console.log,
  error = console.error,
  ownVersion = ownPackageJson.version,
} = {}) {
  const targetArg = argv[0]
  try {
    return createApp({ targetArg, cwd, env, ownVersion, log })
  } catch (err) {
    if (err instanceof ScaffoldError) {
      error(err.message)
      return err.exitCode
    }
    throw err
  }
}
