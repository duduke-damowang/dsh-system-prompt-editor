/**
 * Build the installable halves from `src/`.
 *
 * Why a build step exists at all: the plugin is installed under the profile's
 * `node_modules`, and Node refuses to strip TypeScript types for files inside
 * `node_modules` (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). The Host half is
 * therefore authored in TypeScript and emitted as plain ESM JavaScript here.
 *
 * The Client half is already plain JavaScript because the Host serves it to the
 * browser verbatim; this script only copies it, so `lib/` is always the
 * complete installable artifact.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const checkOnly = process.argv.includes('--check')

/** Emit one TypeScript source file as plain ESM JavaScript. */
function emitHost() {
  const source = join(root, 'src', 'host', 'index.ts')
  const target = join(root, 'lib', 'host', 'index.js')
  const code = readFileSync(source, 'utf8')
  const output = stripTypeScriptTypes(code, { mode: 'strip', sourceUrl: source })
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, output, 'utf8')
  return relative(root, target)
}

/** Copy the browser half unchanged; it must stay plain JavaScript. */
function emitClient() {
  const source = join(root, 'src', 'client', 'index.js')
  const target = join(root, 'lib', 'client', 'index.js')
  const code = readFileSync(source, 'utf8')
  if (/\b(?:interface|type)\s+[A-Z]\w*\s*(?:=|\{)/.test(code) || /:\s*(?:string|number|boolean)\b/.test(code)) {
    throw new Error('src/client/index.js must stay plain JavaScript: the browser receives it verbatim')
  }
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, code, 'utf8')
  return relative(root, target)
}

const written = []
if (!checkOnly) rmSync(join(root, 'lib'), { recursive: true, force: true })
written.push(emitHost())
written.push(emitClient())

console.log(`${checkOnly ? 'verified' : 'built'}: ${written.join(', ')}`)
