import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync, spawn as spawnChild } from 'node:child_process'
import { createInterface } from 'node:readline'
import path from 'node:path'
import { detectPackageManager } from './package-manager.js'
import { isSupportedPlatform, platformKey } from './platform.js'
import { versionChannel, distTagFor } from './channel.js'
import { createInitOutputFilter } from './init-output-filter.js'
import { BANNER } from './banner.js'

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

// `deka dev` is only runnable as a bare command when `deka` is on PATH --
// true for a global/curl install, never true here: this package always
// installs @dekaruntime/deka as a project devDependency, so the only copy
// of `deka` that exists is node_modules/.bin/deka (deka#1103 -- the actual
// bug: deka init's own "Next steps" told people to run `deka dev` and it
// printed `command not found`). Each package manager has its own idiom for
// running a devDependency's binary via its `dev` script, plus a direct
// form that reaches node_modules/.bin without needing a script at all --
// both are shown so the user isn't stuck if package.json's `dev` script
// ever changes.
const DEV_STEP_BY_PM = {
  npm: { run: 'npm run dev', direct: 'npx deka dev' },
  pnpm: { run: 'pnpm dev', direct: 'pnpm exec deka dev' },
  yarn: { run: 'yarn dev', direct: 'yarn deka dev' },
  bun: { run: 'bun dev', direct: 'bunx deka dev' },
}

// Prints create-deka-app's own "Next steps", replacing deka init's (which
// is suppressed -- see createInitOutputFilter) because deka init's version
// (a) doesn't know it's being invoked from the parent directory, so it
// can't tell the user they still need to `cd <dirName>` first, and (b)
// always suggests a bare `deka dev`, which is wrong here (see above).
function printNextSteps(log, dirName, pm) {
  const step = DEV_STEP_BY_PM[pm.name] || DEV_STEP_BY_PM.npm
  log('')
  log('  Next steps:')
  log(`    cd ${dirName}`)
  log(`    ${step.run}        # or: ${step.direct}`)
}

// Runs `deka init`, streaming its (filtered) output to `log` line by line
// as the child prints it -- not buffered and replayed after the process
// exits -- so the per-file `[create] ...` lines appear as the scaffold
// actually happens. `createInitOutputFilter` (src/init-output-filter.js)
// strips deka's own banner (create-deka-app already printed its own, once,
// before the install step -- see createApp below) and deka's own "Next
// steps" block (see printNextSteps above for why) out of that stream;
// everything else passes through unchanged.
//
// Streams STDERR, not stdout -- verified against the real binary (run it
// with each redirected separately): the banner, every `[create] ...` /
// `[init] ...` line and "Next steps" all go to stderr; stdout is empty on
// a normal run. deka init's stdout is buffered instead, purely so it can
// still be shown (unfiltered) if it ever turns out to matter on a failure.
//
// Passed into createApp as `runDekaInit` (defaulting to this real
// implementation) purely so tests can substitute a fake without spawning a
// real process -- see makeRunDekaInitStub in test/scaffold-unit.test.js,
// which drives this exact same createInitOutputFilter so tests exercise
// the real filtering logic instead of a reimplementation of it.
export function runDekaInitStreaming(dekaBin, args, { cwd, log }) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawnChild(dekaBin, args, { cwd, stdio: ['inherit', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ status: null, error })
      return
    }

    let stdout = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })

    const filtered = child.stderr.pipe(createInitOutputFilter())
    createInterface({ input: filtered, crlfDelay: Infinity }).on('line', log)

    child.on('error', (error) => resolve({ status: null, error, stdout }))
    child.on('close', (status) => resolve({ status, stdout }))
  })
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
// Falls back to the running version's OWN channel's dist-tag -- never to a
// version we already know is wrong, and never silently to `latest` for a
// canary -- if the registry can't be reached (offline, registry outage,
// etc), and says so via `log` so the fallback is visible.
//
// rfd#68: `channel` is the channel of the create-deka-app version that is
// running (see resolveRuntimeVersion / createApp below) -- `canary` looks
// up `@dekaruntime/deka@canary`, so `npx create-deka-app@canary myapp`
// falls back onto another canary build, never quietly onto `latest` stable.
export function resolveLatestRuntimeVersion({
  spawn = spawnSync,
  cwd = process.cwd(),
  log = console.log,
  channel = 'stable',
} = {}) {
  const distTag = distTagFor(channel)
  const result = spawn('npm', ['view', `${RUNTIME_PACKAGE}@${distTag}`, 'version'], { cwd, encoding: 'utf8' })

  const version =
    result && !result.error && result.status === 0 ? String(result.stdout || '').trim() : ''

  if (!version) {
    log(
      `> Could not resolve the ${distTag} ${RUNTIME_PACKAGE} version from the npm registry ` +
        `(offline, or the registry is unreachable); pinning "${distTag}" instead.`
    )
    return distTag
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
 *
 * Async only because the final step (running `deka init`) streams its
 * output as it happens rather than buffering it -- see runDekaInitStreaming.
 * Everything before that step is still plain synchronous code.
 */
export async function createApp({
  targetArg,
  cwd = process.cwd(),
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  spawn = spawnSync,
  runDekaInit = runDekaInitStreaming,
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

  // Printed once, up front, before anything else -- deka init would print
  // this exact banner itself (see src/banner.js for where these bytes came
  // from), so its copy is suppressed (createInitOutputFilter) to keep it
  // from showing twice.
  log(BANNER)
  log('')

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
  log(`> Installing the deka runtime with ${pm.name}...`)

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
    const fallbackVersion = resolveLatestRuntimeVersion({ spawn, cwd: targetDir, log, channel: versionChannel(ownVersion) })
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
  // Its stderr (where deka prints everything -- see runDekaInitStreaming)
  // streams straight to `log`, filtered, as deka prints it. Only stdout
  // comes back buffered, since it's normally empty and only worth showing
  // at all on the failure path below.
  const init = await runDekaInit(dekaBin, ['init', dirName], { cwd: parentDir, log })

  if (init.error) {
    throw new ScaffoldError(`Could not run "deka init" in ${targetDir}: ${init.error.message}`)
  }
  if (init.status !== 0) {
    // Something went wrong. Whatever deka printed to stderr before failing
    // already reached `log` live, filtered the same as on the success
    // path; show its stdout too, unfiltered, in the rare case it printed
    // something there.
    if (init.stdout) log(String(init.stdout))
    throw new ScaffoldError(
      `"deka init" failed in ${targetDir} (exit code ${init.status}).`,
      init.status ?? 1
    )
  }

  printNextSteps(log, dirName, pm)

  return 0
}
