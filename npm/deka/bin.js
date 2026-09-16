#!/usr/bin/env node
'use strict';

// @dekaruntime/deka: a thin wrapper that resolves and execs the platform
// binary installed via optionalDependencies. It ships both the `deka` and
// `dsc` commands (package.json's "bin" field points both names at this same
// file) -- which one to run is decided by how the file was invoked.
//
// Kept intentionally requireable-without-side-effects (guarded by the
// require.main check below) so tests can exercise resolveBinaryName,
// makeExtraEnv and main() directly.
const path = require('path');
const fs = require('fs');
const core = require('./launcher-core');

function resolveBinaryName(argv1) {
  const invokedAs = path.basename(argv1 || 'deka');
  return invokedAs === 'dsc' ? 'dsc' : 'deka';
}

// When running the `deka` command, point DEKA_DSC at the dsc bundled
// alongside this platform's deka binary. This is belt-and-braces for
// find_cli_dsc() (deka check/fmt/transpile/lsp), which does consult the
// environment; the runtime's own find_dsc() is sibling-only and does not
// read DEKA_DSC, so correctness never depends on this.
function makeExtraEnv(binaryName) {
  return function extraEnv(pkgDir, env) {
    if (binaryName !== 'deka') return env;
    const dscPath = path.join(pkgDir, 'bin', 'dsc');
    if (!fs.existsSync(dscPath)) return env;
    return Object.assign({}, env, { DEKA_DSC: dscPath });
  };
}

function main(argv = process.argv) {
  const binaryName = resolveBinaryName(argv[1]);
  return core.run({
    family: 'deka',
    platformPackagePrefix: '@dekaruntime/deka',
    binaryName,
    launcherDir: __dirname,
    extraEnv: makeExtraEnv(binaryName),
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`deka: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { resolveBinaryName, makeExtraEnv, main };
