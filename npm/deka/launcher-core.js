'use strict';

// Shared launcher logic for the @dekaruntime/deka and @dekaruntime/dsc
// wrappers. This exact file is duplicated byte-for-byte at
// npm/dsc/launcher-core.js -- see test/launcher-core-parity.test.js, which
// fails the build if the two copies drift. It is duplicated rather than
// imported because each package must be self-contained once published: npm
// only packs files inside a package's own directory, so a launcher cannot
// `require('../deka/launcher-core')` after install.
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Platforms deka and dsc publish prebuilt binaries for today. Anything else
// (Windows included) gets a clear message instead of a stack trace --
// see https://github.com/dekaruntime/deka/issues/1092.
const SUPPORTED_PLATFORMS = new Set(['darwin-arm64', 'darwin-x64', 'linux-x64']);

function platformKey(platform = os.platform(), arch = os.arch()) {
  return `${platform}-${arch}`;
}

function isSupportedPlatform(key) {
  return SUPPORTED_PLATFORMS.has(key);
}

function unsupportedPlatformMessage(family, key) {
  return [
    `${family}: unsupported platform "${key}".`,
    'Prebuilt binaries are published for darwin-arm64, darwin-x64 and linux-x64 only.',
    'Windows support is tracked at https://github.com/dekaruntime/deka/issues/1092.',
  ].join('\n');
}

// Resolve the installed directory of a platform package (e.g.
// @dekaruntime/deka-darwin-arm64). Tries standard module resolution first --
// this covers both local installs and the common global-install layout,
// where npm links the platform package as a sibling of the launcher. Falls
// back to a manual check under the launcher's own node_modules, because npm
// sometimes nests optionalDependencies there instead (the case tana's
// bin.js was written to handle).
function resolvePlatformPackageDir(pkgName, launcherDir, overrides = {}) {
  const resolve = overrides.resolve || require.resolve;
  const existsSync = overrides.existsSync || fs.existsSync;

  try {
    return path.dirname(resolve(`${pkgName}/package.json`));
  } catch {
    // Fall through to the nesting fallback below.
  }

  const nested = path.join(launcherDir, 'node_modules', pkgName);
  if (existsSync(path.join(nested, 'package.json'))) {
    return nested;
  }

  return null;
}

// Run the resolved platform binary, forwarding argv, stdio, SIGINT/SIGTERM
// and the exit code. Returns a promise that resolves once the child has
// exited (or could not be started), after process.exitCode has been set --
// callers should not call process.exit() themselves, so stdio has a chance
// to flush.
function run(opts) {
  const {
    family,
    platformPackagePrefix,
    binaryName,
    launcherDir,
    platform,
    arch,
    argv = process.argv.slice(2),
    extraEnv,
    resolveDir,
  } = opts;

  const key = platformKey(platform, arch);

  if (!isSupportedPlatform(key)) {
    console.error(unsupportedPlatformMessage(family, key));
    process.exitCode = 1;
    return Promise.resolve({ code: 1, signal: null });
  }

  const pkgName = `${platformPackagePrefix}-${key}`;
  const pkgDir = resolveDir
    ? resolveDir(pkgName, launcherDir)
    : resolvePlatformPackageDir(pkgName, launcherDir);

  if (!pkgDir) {
    console.error(`${family}: could not locate ${pkgName}. Try reinstalling ${family}.`);
    process.exitCode = 1;
    return Promise.resolve({ code: 1, signal: null });
  }

  const binaryPath = path.join(pkgDir, 'bin', binaryName);
  if (!fs.existsSync(binaryPath)) {
    console.error(`${family}: ${binaryPath} is missing. Try reinstalling ${family}.`);
    process.exitCode = 1;
    return Promise.resolve({ code: 1, signal: null });
  }

  const env = extraEnv ? extraEnv(pkgDir, process.env) : process.env;

  return new Promise((resolvePromise) => {
    const child = spawn(binaryPath, argv, { stdio: 'inherit', env });

    const forward = (signal) => {
      child.kill(signal);
    };
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);

    const cleanup = () => {
      process.removeListener('SIGINT', forward);
      process.removeListener('SIGTERM', forward);
    };

    child.on('error', (err) => {
      cleanup();
      console.error(`${family}: failed to launch ${binaryPath}: ${err.message}`);
      process.exitCode = 1;
      resolvePromise({ code: 1, signal: null });
    });

    child.on('exit', (code, signal) => {
      cleanup();
      if (signal) {
        // POSIX/bash convention: 128 + signal number. Deterministic and
        // matches what a shell reports for a signal-terminated process.
        const signalNumber = os.constants.signals[signal];
        process.exitCode = signalNumber ? 128 + signalNumber : 1;
      } else {
        process.exitCode = code === null ? 1 : code;
      }
      resolvePromise({ code: process.exitCode, signal });
    });
  });
}

module.exports = {
  SUPPORTED_PLATFORMS,
  platformKey,
  isSupportedPlatform,
  unsupportedPlatformMessage,
  resolvePlatformPackageDir,
  run,
};
