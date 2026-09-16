#!/usr/bin/env node
// Test fixture: traps SIGINT/SIGTERM and exits with a distinguishing code,
// instead of dying to the signal's default disposition. Used to prove the
// wrapper actually forwards the signal to the child rather than swallowing
// it or orphaning the child. Prints a ready marker once its handlers are
// registered, so a test can wait for that instead of racing a fixed delay
// against process startup under CI load.
process.on('SIGINT', () => process.exit(42))
process.on('SIGTERM', () => process.exit(43))
console.log('signal-trap ready')
setInterval(() => {}, 1000)
