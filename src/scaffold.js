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

// `deka init`'s own "next steps" block always starts with a line beginning
// "[init]" (verified against the real binary: `[init] DekaScript app
// ready` followed by 1-2 indented command lines). Everything from that
// line onward is deka's suggestion for what to run next, and we always
// replace it with our own -- see printNextSteps below for why. Everything
// before it (the banner, the per-file `[create] ...` lines) is left
// intact so the user still sees the scaffold happen.
function stripDekaNextSteps(output) {
  if (!output) return ''
  const lines = String(output).split(/\r?\n/)
  const cutIndex = lines.findIndex((line) => line.startsWith('[init]'))
  return cutIndex === -1 ? String(output) : lines.slice(0, cutIndex).join('\n')
}

// deka init's own next-steps text always tells the user to run `deka dev`,
// and that command is correct as-is -- `deka` from this package is scoped
// to the project, so the copy installed into node_modules/.bin (and picked
// up via the project's package.json script) works with nothing beyond what
// the install step above already put on disk. We suppress deka's block
// (stripDekaNextSteps) only because it doesn't know it's being invoked
// from the parent directory here, so it can't tell the user they still
// need to `cd <dirName>` first -- not because its command is wrong. Our
// own block adds that missing `cd` and repeats `deka dev` verbatim,
// regardless of which package manager ran the install. (This reverts an
// earlier version of this function that substituted a package-manager
// idiom -- `npm run dev` / `pnpm dev` / etc. -- for `deka dev`, on the
// mistaken premise that a bare `deka dev` can't be run without a global
// install.)
function printNextSteps(log, dirName) {
  log('')
  log('  Next steps:')
  log(`    cd ${dirName}`)
  log('    deka dev')
}

export const RUNTIME_PACKAGE = '@dekaruntime/deka'

// Builds the package.json this package writes into every scaffolded
// project. Exported so the test suite can assert on it directly without
// re-deriving the shape.
//
// `runtimeVersion` is whatever create-deka-app decided to pin -- under
// lockstep versioning (see createApp below) that is this scaffolder's own
// version in the common case, or the registry-resolved fallback version
// when the exact match hasn't been published.
export function buildPackageJson(dirName, runtimeVersion) {
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
      [RUNTIME_PACKAGE]: runtimeVersion,
    },
  }
}

// Looks up the latest published @dekaruntime/deka version from the npm
// registry. This is the FALLBACK path only -- under lockstep versioning,
// create-deka-app@X.Y.Z always scaffolds @dekaruntime/deka@X.Y.Z directly
// (see resolveRuntimeVersion below), with no registry call. This function
// is reached only when that exact pin failed to install, e.g. a
// create-deka-app release that published before its matching runtime
// build finished.
//
// Always shells out to `npm` for this lookup (not the detected package
// manager) -- npm ships with every Node.js install, so it is available
// regardless of whether the user ran this via npx, pnpm create, yarn
// create or bun create, and `npm view` is a read-only registry query with
// no project-local side effects.
//
// Falls back to the "latest" dist-tag -- never to a version we already
// know is wrong -- if the registry can't be reached (offline, registry
// outage, etc), and says so via `log` so the fallback is visible.
export function resolveLatestRuntimeVersion({ spawn = spawnSync, cwd = process.cwd(), log = console.log } = {}) {
  const result = spawn('npm', ['view', RUNTIME_PACKAGE, 'version'], { cwd, encoding: 'utf8' })

  const version =
    result && !result.error && result.status === 0 ? String(result.stdout || '').trim() : ''

  if (!version) {
    log(
      `> Could not resolve the latest ${RUNTIME_PACKAGE} version from the npm registry ` +
        '(offline, or the registry is unreachable); pinning "latest" instead.'
    )
    return 'latest'
  }

  return version
}

// Decides which @dekaruntime/deka version to pin in the scaffolded
// project. `ownVersion` is create-deka-app's own version -- under
// lockstep versioning (README: "create-deka-app's version always equals
// the deka runtime version it scaffolds") that IS the runtime version, so
// this returns it directly with no network call: a given create-deka-app
// version always produces the same pin, reproducibly.
//
// This is exported only so the test suite can call it directly; createApp
// below is what actually decides whether the pin needs the fallback (that
// requires attempting the install, which this function does not do).
export function resolveRuntimeVersion({ ownVersion }) {
  if (!ownVersion) {
    throw new Error('resolveRuntimeVersion requires ownVersion')
  }
  return ownVersion
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
  platform = process.platform,
  arch = process.arch,
  spawn = spawnSync,
  log = console.log,
  ownVersion,
} = {}) {
  if (!targetArg) {
    throw new ScaffoldError(USAGE, 1)
  }

  if (!ownVersion) {
    throw new Error('createApp requires ownVersion (create-deka-app pins it as the runtime version)')
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

  // Lockstep versioning: create-deka-app@X.Y.Z always pins
  // @dekaruntime/deka@X.Y.Z -- this is create-deka-app's own version, so
  // deciding the pin needs no network call and is fully reproducible (a
  // given create-deka-app version always produces the same project).
  //
  // The one case this doesn't cover is a create-deka-app release whose
  // exact-matching runtime build isn't published yet (there is no
  // standalone scaffolder-only release path -- one publish path,
  // .github/workflows/publish-runtime.yml). That surfaces as the install
  // below failing, and is handled as a fallback: re-resolve against the
  // registry and retry once, never silently leaving a nonexistent version
  // pinned in the final package.json (the ETARGET bug fixed in 0.0.3).
  let runtimeVersion = resolveRuntimeVersion({ ownVersion })

  const writePackageJson = (version) => {
    const pkg = buildPackageJson(path.basename(targetDir), version)
    writeFileSync(path.join(targetDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  }
  writePackageJson(runtimeVersion)

  const pm = detectPackageManager(env)
  log(`> Using ${pm.name} to install @dekaruntime/deka...`)

  const [installCmd, installArgs] = pm.install
  const runInstall = () => spawn(installCmd, installArgs, { cwd: targetDir, stdio: 'inherit' })

  let install = runInstall()

  if (install.error) {
    throw new ScaffoldError(
      `Could not run "${pm.name} install" in ${targetDir}: ${install.error.message}\n` +
        `Make sure ${pm.name} is installed and on your PATH, then run it there yourself.`
    )
  }

  if (install.status !== 0) {
    log(
      `> "${pm.name} install" could not install ${RUNTIME_PACKAGE}@${runtimeVersion} (exit code ${install.status}). ` +
        `This can happen when create-deka-app@${ownVersion} shipped before its matching runtime build did. ` +
        'Falling back to the latest published version instead.'
    )
    const fallbackVersion = resolveLatestRuntimeVersion({ spawn, cwd: targetDir, log })
    if (fallbackVersion === runtimeVersion) {
      throw new ScaffoldError(
        `"${pm.name} install" failed in ${targetDir} (exit code ${install.status}), ` +
          `and the npm registry also reports ${RUNTIME_PACKAGE}@${fallbackVersion} as the latest version.\n` +
          'Run it there yourself to see the full error.',
        install.status ?? 1
      )
    }

    runtimeVersion = fallbackVersion
    writePackageJson(runtimeVersion)
    install = runInstall()

    if (install.error) {
      throw new ScaffoldError(
        `Could not run "${pm.name} install" in ${targetDir}: ${install.error.message}\n` +
          `Make sure ${pm.name} is installed and on your PATH, then run it there yourself.`
      )
    }
    if (install.status !== 0) {
      throw new ScaffoldError(
        `"${pm.name} install" failed in ${targetDir} (exit code ${install.status}), ` +
          `even after falling back to ${RUNTIME_PACKAGE}@${runtimeVersion}.\n` +
          'Run it there yourself to see the full error.',
        install.status ?? 1
      )
    }
  }

  const dekaBin = dekaBinPath(targetDir, platform)
  if (!existsSync(dekaBin)) {
    throw new ScaffoldError(
      `${dekaBin} was not found after "${pm.name} install".\n` +
        `@dekaruntime/deka may not have published a build for ${platformKey(platform, arch)} yet, ` +
        'or the install above did not complete. Check its output.'
    )
  }

  // Invoked as `deka init <dirName>` from the *parent* directory -- the
  // same shape as someone typing `deka init myapp` by hand -- rather than
  // `deka init` with cwd already set to targetDir. deka init never
  // overwrites a file that already exists (package.json, written above,
  // survives untouched), and this shape is what makes deka's own output
  // reference the right directory name if any of it leaks through.
  const dirName = path.basename(targetDir)
  const parentDir = path.dirname(targetDir)
  const init = spawn(dekaBin, ['init', dirName], {
    cwd: parentDir,
    stdio: ['inherit', 'pipe', 'pipe'],
    encoding: 'utf8',
  })

  if (init.error) {
    throw new ScaffoldError(`Could not run "deka init" in ${targetDir}: ${init.error.message}`)
  }
  if (init.status !== 0) {
    // Something went wrong -- show everything deka printed, unfiltered,
    // so the real error is visible. Filtering only ever happens below, on
    // the success path, where we know exactly what we're throwing away.
    if (init.stdout) log(String(init.stdout))
    if (init.stderr) log(String(init.stderr))
    throw new ScaffoldError(
      `"deka init" failed in ${targetDir} (exit code ${init.status}).`,
      init.status ?? 1
    )
  }

  if (init.stdout) log(stripDekaNextSteps(init.stdout))
  if (init.stderr) log(stripDekaNextSteps(init.stderr))
  printNextSteps(log, dirName)

  return 0
}
