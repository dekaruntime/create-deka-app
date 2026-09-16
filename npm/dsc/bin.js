#!/usr/bin/env node
'use strict';

// @dekaruntime/dsc: a thin wrapper that resolves and execs the platform
// binary installed via optionalDependencies. Standalone compiler-only
// install (editor tooling, CI type-checking) -- see npm/deka/bin.js for the
// deka launcher, which bundles its own sibling dsc for runtime correctness
// and does not depend on this package for that.
//
// Kept intentionally requireable-without-side-effects (guarded by the
// require.main check below) so tests can exercise main() directly.
const core = require('./launcher-core');

function main() {
  return core.run({
    family: 'dsc',
    platformPackagePrefix: '@dekaruntime/dsc',
    binaryName: 'dsc',
    launcherDir: __dirname,
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`dsc: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
