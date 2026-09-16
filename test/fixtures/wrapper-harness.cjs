#!/usr/bin/env node
// Standalone launcher-shaped process for the SIGINT-forwarding test.
// Spawned as a real OS child from the test (not executed in-process), so a
// signal sent to *this* process, and this process's own
// SIGINT/SIGTERM->child forwarding (via launcher-core.js), can be observed
// exactly the way a user's shell delivers Ctrl-C to a real `deka`/`dsc`
// invocation -- without interacting with the test runner's own process or
// its signal handling.
'use strict';
const path = require('path');
const core = require('../../npm/deka/launcher-core.js');

const fixturePkg = path.join(__dirname, 'pkg');

core.run({
  family: 'dsc',
  platformPackagePrefix: '@dekaruntime/dsc',
  binaryName: 'dsc', // fixtures/pkg/bin/dsc traps SIGINT/SIGTERM and exits 42/43
  launcherDir: __dirname,
  platform: 'linux',
  arch: 'x64',
  argv: [],
  resolveDir: () => fixturePkg,
});
