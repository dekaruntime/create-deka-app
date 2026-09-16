// rfd#68 (Release Channels): a version carries its channel in its own
// string. `X.Y.Z-canary-<sha>` is a canary -- a build published under the
// `canary` npm dist-tag, from a `vX.Y.Z-canary-<sha>` release tag. Anything
// else (plain `X.Y.Z`) is stable, published under `latest`.
//
// Shared between the CLI this package ships (src/scaffold.js: the lockstep
// pin and its registry-lookup fallback) and the release pipeline that is
// NOT shipped (scripts/lib/manifest.js: R2 URL shapes) -- kept in src/ (not
// scripts/) because scripts/ is excluded from the published npm tarball
// (see package.json "files"), so anything scaffold.js depends on has to
// live somewhere that ships.
// https://github.com/dekaruntime/rfd/issues/68
const CANARY_SUFFIX = /-canary-[0-9a-f]+$/i

export function versionChannel(version) {
  return CANARY_SUFFIX.test(String(version)) ? 'canary' : 'stable'
}

export function distTagFor(channel) {
  return channel === 'canary' ? 'canary' : 'latest'
}

// The base version a canary's own binaries report on `--version`.
// Promotion republishes the exact same bytes under the plain tag, so a
// canary build never learns it is a canary -- its `--version` output
// always names the base version (plus a commit sha), never the
// "-canary-<sha>" suffix. Manifests written under rfd#68 carry an explicit
// `base_version` field; a manifest that predates it (or a caller that
// hasn't fetched one) falls back to stripping the suffix from the full
// version string.
export function baseVersionOf(version, manifest) {
  if (manifest && typeof manifest.base_version === 'string' && manifest.base_version) {
    return manifest.base_version
  }
  return String(version).replace(CANARY_SUFFIX, '')
}
