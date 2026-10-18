// Funções auxiliares compartilhadas pelas ferramentas.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { shortPath } from '../config.js'

export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  '.idea',
  'coverage',
  '.turbo',
  '.gradle',
  '.pytest_cache',
  '.mypy_cache',
])

export function resolvePath(cwd, p) {
  if (!p) return cwd
  p = String(p).trim()
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1))
  return path.resolve(cwd, p)
}

export function displayPath(cwd, abs) {
  const rel = path.relative(cwd, abs)
  if (rel === '') return '.'
  return !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : shortPath(abs)
}

/** Aceita variações comuns de nome de argumento que modelos costumam usar. */
export function pick(args, ...names) {
  for (const n of names) if (args?.[n] !== undefined && args[n] !== null) return args[n]
  return undefined
}

export function isBinaryBuffer(buf) {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

export function truncateMiddle(text, max = 30000) {
  if (text.length <= max) return text
  const half = Math.floor(max / 2)
  const head = text.slice(0, half)
  const tail = text.slice(-half)
  const omitted = text.slice(half, -half).split('\n').length
  return `${head}\n\n… [${omitted} linhas omitidas] …\n\n${tail}`
}

let rgPath
export function ripgrep() {
  if (rgPath !== undefined) return rgPath
  const r = spawnSync('rg', ['--version'], { encoding: 'utf8' })
  rgPath = r.status === 0 ? 'rg' : null
  return rgPath
}

/** Converte um glob (**, *, ?, {a,b}, [abc]) em RegExp para caminhos relativos com "/". */
export function globToRegExp(glob) {
  let re = ''
  let inGroup = 0
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const atSegStart = i === 0 || glob[i - 1] === '/'
        if (glob[i + 2] === '/' && atSegStart) {
          re += '(?:.*/)?'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (c === '{') {
      inGroup++
      re += '(?:'
    } else if (c === '}' && inGroup) {
      inGroup--
      re += ')'
    } else if (c === ',' && inGroup) re += '|'
    else if (c === '[') {
      const end = glob.indexOf(']', i)
      if (end === -1) re += '\\['
      else {
        let cls = glob.slice(i + 1, end)
        if (cls.startsWith('!')) cls = '^' + cls.slice(1)
        re += `[${cls.replace(/\\/g, '\\\\')}]`
        i = end
      }
    } else if ('.+^$()|\\'.includes(c)) re += '\\' + c
    else re += c
  }
  return new RegExp(`^${re}$`)
}

/** Percorre diretórios ignorando pastas pesadas. Retorna caminhos relativos a `root`. */
export function walk(root, { maxFiles = 20000, includeDirs = false, signal } = {}) {
  const out = []
  const stack = ['']
  while (stack.length && out.length < maxFiles) {
    if (signal?.aborted) break
    const rel = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) continue
        if (includeDirs) out.push(r + '/')
        stack.push(r)
      } else if (e.isFile() || e.isSymbolicLink()) out.push(r)
      if (out.length >= maxFiles) break
    }
  }
  return out
}

/** Regras simples de .gitignore (sem negação): diretório/, padrões ancorados com "/" e globs por nome. */
export function parseGitignore(text, base = '') {
  const rules = []
  for (let line of String(text).split('\n')) {
    line = line.replace(/\s+$/, '')
    if (!line || line.startsWith('#') || line.startsWith('!')) continue
    const dirOnly = line.endsWith('/')
    if (dirOnly) line = line.slice(0, -1)
    const anchored = line.includes('/')
    if (line.startsWith('/')) line = line.slice(1)
    if (!line) continue
    try { rules.push({ re: globToRegExp(anchored ? line : line), anchored, dirOnly, base }) } catch {}
  }
  return rules
}
export function ignoredBy(rules, rel, name, isDir) {
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue
    if (r.anchored) {
      if (r.base && !rel.startsWith(r.base + '/')) continue
      const local = r.base ? rel.slice(r.base.length + 1) : rel
      if (r.re.test(local)) return true
    } else if (r.re.test(name)) return true
  }
  return false
}

/**
 * Percurso de diretórios assíncrono: não bloqueia a interface, respeita .gitignore e as pastas pesadas,
 * para em `maxFiles`, no prazo `timeMs` ou no `signal`. Devolve { files, truncated, reason }.
 */
export async function walkAsync(root, { maxFiles = 20000, includeDirs = false, signal, timeMs = 15000, maxDepth = 32, gitignore = true } = {}) {
  const out = []
  const deadline = Date.now() + timeMs
  const queue = [{ rel: '', depth: 0, rules: [] }]
  let reason = ''
  while (queue.length) {
    if (signal?.aborted) { reason = 'interrompido'; break }
    if (Date.now() > deadline) { reason = `prazo de ${Math.round(timeMs / 1000)}s`; break }
    const { rel, depth, rules: inherited } = queue.shift()
    const dir = path.join(root, rel)
    let entries
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { continue }
    let rules = inherited
    if (gitignore && entries.some((e) => e.name === '.gitignore' && e.isFile())) {
      try { rules = [...inherited, ...parseGitignore(await fs.promises.readFile(path.join(dir, '.gitignore'), 'utf8'), rel)] } catch {}
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name) || (gitignore && ignoredBy(rules, r, e.name, true))) continue
        if (includeDirs) out.push(r + '/')
        if (depth + 1 < maxDepth) queue.push({ rel: r, depth: depth + 1, rules })
      } else if (e.isFile() || e.isSymbolicLink()) {
        if (gitignore && ignoredBy(rules, r, e.name, false)) continue
        out.push(r)
      }
      if (out.length >= maxFiles) { reason = `limite de ${maxFiles} arquivos`; break }
    }
    if (out.length >= maxFiles) break
  }
  return { files: out, truncated: !!reason, reason }
}

let grepFlavor
/** GNU grep do sistema (com -P quando disponível) — alternativa rápida e cancelável quando não há ripgrep. */
export function systemGrep() {
  if (grepFlavor !== undefined) return grepFlavor
  const probe = spawnSync('grep', ['-P', 'a\\wb'], { input: 'aXb\n', encoding: 'utf8' })
  if (probe.status === 0) grepFlavor = '-P'
  else grepFlavor = spawnSync('grep', ['-E', 'a.b'], { input: 'aXb\n', encoding: 'utf8' }).status === 0 ? '-E' : null
  return grepFlavor
}

export function countLines(s) {
  if (!s) return 0
  return s.split('\n').length - (s.endsWith('\n') ? 1 : 0)
}
