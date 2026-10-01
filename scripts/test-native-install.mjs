// Pack the actual runtime, then run the public scaffolder through a local npm
// registry. This tests real npm installation and commands without publishing.
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { buildPackageJson } from '../src/scaffold.js'

const binary = path.resolve(process.argv[2])
const root = path.resolve(process.argv[3])
mkdirSync(root, { recursive: true })
const work = mkdtempSync(path.join(root, 'fresh-native-'))
const version = process.argv[4] || '0.60.1'
const baseVersion = version.replace(/-canary-[0-9a-f]+$/, '')
const platform = `${process.platform}-${process.arch}`
const packages = new Map()
const calls = []
function run(command, args, cwd, env = process.env, success = true) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    child.on('error', reject)
    child.on('close', code => {
      if ((code === 0) !== success) reject(new Error(`${command} ${args.join(' ')}: ${code}\n${stdout}\n${stderr}`))
      else resolve(stdout)
    })
  })
}
async function pack(relative, name, mutate) {
  const directory = path.join(work, name.replaceAll('/', '-'))
  mkdirSync(directory)
  if (relative === '.') {
    for (const file of ['index.js', 'src', 'README.md', 'LICENSE', 'package.json']) cpSync(file, path.join(directory, file), { recursive: true })
  } else cpSync(relative, directory, { recursive: true })
  const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json')))
  manifest.version = version
  mutate?.(manifest, directory)
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify(manifest))
  await run('npm', ['pack', '--pack-destination', work, '--json'], directory)
  const tarball = readdirSync(work).find(f => f === `${name.replace('@', '').replaceAll('/', '-')}-${version}.tgz`)
  assert(tarball, `missing packed ${name}`)
  const bytes = readFileSync(path.join(work, tarball))
  packages.set(name, { manifest, bytes, tarball })
}
let server
try {
  await pack(`npm/deka-${platform}`, `@dekaruntime/deka-${platform}`, (_, directory) => {
    mkdirSync(path.join(directory, 'bin'), { recursive: true })
    cpSync(binary, path.join(directory, 'bin/deka'))
  })
  await pack('npm/deka', '@dekaruntime/deka', manifest => {
    manifest.optionalDependencies = { [`@dekaruntime/deka-${platform}`]: version }
    assert(!manifest.dependencies?.['@dekaruntime/dsc'])
  })
  await pack('.', 'create-deka-app')
  server = createServer((request, response) => {
    const name = decodeURIComponent(request.url.slice(1))
    calls.push(name)
    const entry = packages.get(name)
    if (entry) {
      const address = server.address()
      const dist = { tarball: `http://127.0.0.1:${address.port}/${entry.tarball}`, shasum: createHash('sha1').update(entry.bytes).digest('hex'), integrity: `sha512-${createHash('sha512').update(entry.bytes).digest('base64')}` }
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ name, 'dist-tags': { latest: version }, versions: { [version]: { ...entry.manifest, dist } } }))
    } else {
      const archive = [...packages.values()].find(entry => entry.tarball === name)
      if (archive) response.end(archive.bytes)
      else { response.statusCode = 404; response.end('{}') }
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const registry = `http://127.0.0.1:${server.address().port}`
  const tools = path.join(work, 'tools')
  mkdirSync(tools)
  const env = { ...process.env, npm_config_registry: registry, npm_config_cache: path.join(work, 'cache'), npm_config_global: 'false', npm_config_bin_links: 'true', npm_config_audit: 'false', npm_config_fund: 'false', TMPDIR: work }
  writeFileSync(path.join(tools, 'package.json'), JSON.stringify({ name: 'native-install-test', private: true }))
  await run('npm', ['install', '--registry', registry, `create-deka-app@${version}`], tools, env)
  const project = path.join(work, 'app')
  await run(path.join(tools, 'node_modules/.bin/create-deka-app'), [project], work, env)
  const manifest = JSON.parse(readFileSync(path.join(project, 'package.json')))
  assert.deepEqual(manifest.scripts, buildPackageJson('app', version).scripts)
  assert(readFileSync(path.join(project, 'App.dsx'), 'utf8').includes('<view'))
  assert(!readdirSync(path.join(project, 'node_modules/.bin')).includes('dsc'))
  assert.equal((await run('npx', ['--no-install', 'deka', '--version'], project, env)).trim(), `deka ${baseVersion} (Rust VM)`)
  assert((await run('npm', ['test'], project, env)).includes('1 passed, 0 failed'))
  assert((await run('npm', ['run', 'dev', '--', '--exercise', '2'], project, env)).includes('Count:  2'))
  await run('npm', ['run', 'build'], project, env)
  const app = path.join(work, 'standalone')
  cpSync(path.join(project, 'dist/deka-app'), app)
  rmSync(project, { recursive: true })
  assert((await run(app, ['--exercise', '3'], work, {})).includes('Count:  3'))
  assert(!calls.some(url => url.includes('dsc')), JSON.stringify(calls))
  console.log('Packed npm runtime → real create-deka-app → npx/npm commands → relocated app passed; no DSC requested')
} finally {
  if (server) await new Promise(resolve => server.close(resolve))
  rmSync(work, { recursive: true, force: true })
}
