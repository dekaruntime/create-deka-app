import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { detectPackageManager } from './package-manager.js'
import { isSupportedPlatform, platformKey } from './platform.js'

// Thrown for every expected failure. `message` is written straight to
// stderr, so it always says what happened and what to do about it.
export class ScaffoldError extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.name = 'ScaffoldError'
    this.exitCode = exitCode
  }
}

export const USAGE = 'Usage: create-deka-app <directory>\n\n  npx create-deka-app myapp'

function sanitizePackageName(dirName) {
  const name = dirName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+/, '')
    .slice(0, 214)
  return name.length > 0 ? name : 'deka-app'
}

function dekaBinPath(targetDir, platform) {
  return path.join(targetDir, 'node_modules', '.bin', platform === 'win32' ? 'deka.cmd' : 'deka')
}

// Builds the package.json this package writes into every scaffolded
// project. Exported so the test suite can assert on it directly without
// re-deriving the shape.
export function buildPackageJson(dirName, ownVersion) {
  return {
    name: sanitizePackageName(dirName),
    private: true,
    version: '0.0.0',
    scripts: {
      dev: 'deka dev',
      build: 'deka build',
      start: 'deka start',
    },
    devDependencies: {
      '@dekaruntime/deka': ownVersion,
    },
  }
}

/**
 * Orchestrates the scaffold. Everything the real `deka init` binary is
 * responsible for (writing app/, public/, deka.json, deka.lock, printing
 * next steps) is left to it; this only does what has to happen before that
 * binary exists on disk.
 *
 * Returns 0 on success. Throws ScaffoldError (carrying an exitCode) for
 * every expected failure; anything else is a bug and propagates.
 */
export function createApp({
  targetArg,
  cwd = process.cwd(),
  env = process.env,
  ownVersion,
  platform = process.platform,
  arch = process.arch,
  spawn = spawnSync,
  log = console.log,
} = {}) {
  if (!targetArg) {
    throw new ScaffoldError(USAGE, 1)
  }

  if (!isSupportedPlatform(platform, arch)) {
    throw new ScaffoldError(
      `create-deka-app does not support ${platformKey(platform, arch)} yet.\n` +
        'Supported today: darwin-arm64, darwin-x64, linux-x64.\n' +
        'Windows support is tracked at https://github.com/dekaruntime/deka/issues/1092.'
    )
  }

  const targetDir = path.resolve(cwd, targetArg)

  if (existsSync(targetDir)) {
    const stat = statSync(targetDir)
    if (!stat.isDirectory()) {
      throw new ScaffoldError(`${targetDir} already exists and is not a directory.`)
    }
    if (readdirSync(targetDir).length > 0) {
      throw new ScaffoldError(
        `${targetDir} already exists and is not empty.\n` +
          'Choose a different directory, or remove its contents first.'
      )
    }
  } else {
    mkdirSync(targetDir, { recursive: true })
  }

  const pkg = buildPackageJson(path.basename(targetDir), ownVersion)
  writeFileSync(path.join(targetDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)

  const pm = detectPackageManager(env)
  log(`> Using ${pm.name} to install @dekaruntime/deka...`)

  const [installCmd, installArgs] = pm.install
  const install = spawn(installCmd, installArgs, { cwd: targetDir, stdio: 'inherit' })

  if (install.error) {
    throw new ScaffoldError(
      `Could not run "${pm.name} install" in ${targetDir}: ${install.error.message}\n` +
        `Make sure ${pm.name} is installed and on your PATH, then run it there yourself.`
    )
  }
  if (install.status !== 0) {
    throw new ScaffoldError(
      `"${pm.name} install" failed in ${targetDir} (exit code ${install.status}).\n` +
        'Run it there yourself to see the full error.',
      install.status ?? 1
    )
  }

  const dekaBin = dekaBinPath(targetDir, platform)
  if (!existsSync(dekaBin)) {
    throw new ScaffoldError(
      `${dekaBin} was not found after "${pm.name} install".\n` +
        `@dekaruntime/deka may not have published a build for ${platformKey(platform, arch)} yet, ` +
        'or the install above did not complete. Check its output.'
    )
  }

  const init = spawn(dekaBin, ['init'], { cwd: targetDir, stdio: 'inherit' })

  if (init.error) {
    throw new ScaffoldError(`Could not run "deka init" in ${targetDir}: ${init.error.message}`)
  }
  if (init.status !== 0) {
    throw new ScaffoldError(
      `"deka init" failed in ${targetDir} (exit code ${init.status}).`,
      init.status ?? 1
    )
  }

  return 0
}
