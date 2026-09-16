import { Transform } from 'node:stream'

// ANSI truecolor/bold/reset codes deka wraps its banner in -- stripped only
// to *detect* a banner line, never from what actually gets forwarded (lines
// that pass through are pushed byte-for-byte).
const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g

// deka's banner is drawn entirely from the block-drawing characters ░ and █
// (plus the spaces between them) -- matched structurally, not by exact
// text, so a font/color tweak on deka's side can't silently break this.
// The `[░█]` requirement means a plain blank or space-only line never
// matches (see the deka#1103 PR description for the captured banner bytes,
// also copied into src/banner.js).
function isBannerLine(line) {
  const stripped = line.replace(ANSI_ESCAPE, '')
  return stripped.length > 0 && /^[░█\s]+$/.test(stripped) && /[░█]/.test(stripped)
}

function isNextStepsHeading(line) {
  return /^\s*Next steps:\s*$/.test(line)
}

// Lines inside deka's own "Next steps" block are always indented commands
// (`  deka dev`, `  cd myapp`); an unindented line means the block ended.
function isIndentedContent(line) {
  return /^\s+\S/.test(line)
}

/**
 * A streaming line filter for `deka init`'s stdout. Two things get
 * dropped, everywhere they appear in the stream:
 *
 *  - the deka ASCII banner (create-deka-app prints its own copy, once,
 *    before the install step -- see src/banner.js -- so deka init's copy
 *    would otherwise make it show twice)
 *  - deka's own trailing "Next steps:" block: a blank line, the
 *    "Next steps:" heading, then its indented command lines. It always
 *    suggests a bare `deka dev`, which only works with deka on PATH --
 *    wrong for a project-local install (deka#1103). create-deka-app prints
 *    its own package-manager-correct block instead (see
 *    printNextSteps in scaffold.js).
 *
 * Everything else -- notably the per-file `[create] ...` progress lines,
 * and `[init] DekaScript app ready` -- passes through unchanged, in order,
 * as it arrives.
 *
 * This is a real byte-stream Transform, not "buffer the whole run, filter,
 * replay" -- so those [create] lines reach the terminal as deka prints
 * them, not only after the child process exits (see runDekaInit in
 * scaffold.js, the only place this is meant to be piped from).
 *
 * If deka ever stops printing either block, this is a no-op for it --
 * nothing here assumes either block exists, so nothing breaks.
 */
export function createInitOutputFilter() {
  let carry = ''
  // A blank line is held back (not yet forwarded) until we see whether the
  // very next line is the "Next steps:" heading -- only then do we know it
  // was the lead-in to deka's block, rather than just a blank line deka
  // printed for some other reason.
  let pendingBlank = null
  let suppressing = false

  function emitLine(push, line) {
    if (isBannerLine(line)) return

    if (suppressing) {
      if (line === '' || isIndentedContent(line)) return
      suppressing = false
      // falls through: this line is not part of the block, handle normally
    }

    if (pendingBlank !== null) {
      if (isNextStepsHeading(line)) {
        pendingBlank = null
        suppressing = true
        return
      }
      push(pendingBlank + '\n')
      pendingBlank = null
    }

    if (line === '') {
      pendingBlank = line
      return
    }

    push(line + '\n')
  }

  return new Transform({
    transform(chunk, _encoding, callback) {
      carry += chunk.toString('utf8')
      const lines = carry.split('\n')
      // The last split element is either '' (the chunk ended cleanly on a
      // newline) or a partial line -- either way it isn't a complete line
      // yet, so hold it for the next chunk (or flush, at end of stream).
      carry = lines.pop()
      for (const line of lines) emitLine((s) => this.push(s), line)
      callback()
    },
    flush(callback) {
      if (carry.length > 0) emitLine((s) => this.push(s), carry)
      if (pendingBlank !== null) this.push(pendingBlank + '\n')
      callback()
    },
  })
}
