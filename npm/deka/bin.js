#!/usr/bin/env node
'use strict';
// npm only resolves the prebuilt Rust executable. Compilation happens in Deka.
const core = require('./launcher-core');
function main() {
  return core.run({ family: 'deka', platformPackagePrefix: '@dekaruntime/deka', binaryName: 'deka', launcherDir: __dirname });
}
if (require.main === module) {
  main().catch((err) => { console.error(`deka: ${err.message}`); process.exitCode = 1; });
}
module.exports = { main };
