#!/usr/bin/env node
// Placeholder. The real scaffolder (dekaruntime/deka#1091) installs the
// platform-matched deka binary and runs `deka init`.
const supported = new Set(['darwin-arm64', 'darwin-x64', 'linux-x64'])
const platform = `${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`

console.log('')
console.log('  create-deka-app is not published yet.')
console.log('')
console.log('  deka is a runtime and language for full-stack apps: https://deka.gg')
console.log('  Install today:  curl -fsSL https://deka.gg/install.sh | sh')
console.log('')
if (!supported.has(platform)) {
  console.log(`  Note: ${platform} is not supported yet.`)
  console.log('  macOS (Apple Silicon and Intel) and Linux x64 are supported; Windows is coming.')
  console.log('')
}
