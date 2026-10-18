// Ferramentas de busca: glob (arquivos por padrão), grep (conteúdo) e ls (árvore de diretórios).

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { IGNORED_DIRS, displayPath, globToRegExp, isBinaryBuffer, pick, resolvePath, ripgrep, systemGrep, walkAsync } from './util.js'

const ignoredGlobs = [...IGNORED_DIRS].flatMap((dir) => ['--glob', `!**/${dir}/**`])

const SEARCH_TIMEOUT = 60000

/** Executa um comando e coleta até `maxLines` linhas de stdout, com prazo (resultado parcial ao estourar). */
function runCollect(cmd, args, { cwd, signal, maxLines = 1000, timeout = SEARCH_TIMEOUT } = {}) {
  return new Promise((resolve) => {
    let child
    try { child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }) } catch (e) { return resolve({ lines: [], truncated: false, err: e.message, code: -1 }) }
    const lines = []
    let buf = ''
    let err = ''
    let truncated = false
    let timedOut = false
    const onAbort = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeout)
    child.stdout.on('data', (d) => {
      if (truncated) return
      buf += d.toString('utf8')
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        lines.push(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
        if (lines.length >= maxLines) {
          truncated = true
          child.kill('SIGKILL')
          break
        }
      }
    })
    child.stderr.on('data', (d) => { if (err.length < 4000) err += d.toString('utf8') })
    child.on('error', (e) => { clearTimeout(timer); resolve({ lines, truncated, err: e.message, code: -1 }) })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (buf && !truncated) lines.push(buf)
      resolve({ lines, truncated, err, code, timedOut })
    })
  })
}

/** "*.{js,ts}" → ["*.js", "*.ts"] (o --include do grep não entende chaves). */
function expandBraces(g) {
  const m = /\{([^{}]*)\}/.exec(g)
  if (!m) return [g]
  return m[1].split(',').flatMap((alt) => expandBraces(g.slice(0, m.index) + alt + g.slice(m.index + m[0].length)))
}

export const glob = {
  name: 'glob',
  label: 'Glob',
  readOnly: true,
  description:
    'Find files by glob pattern (e.g. "**/*.ts", "src/**/*.{js,jsx}", "*.md"). Returns matching paths sorted by modification time (newest first). Respects .gitignore. Use this instead of `find`.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern' },
      path: { type: 'string', description: 'Directory to search in (default: working directory)' },
    },
    required: ['pattern'],
  },
  summary(args) {
    const p = pick(args, 'pattern', 'glob')
    const dir = pick(args, 'path', 'dir', 'directory')
    return `${p || ''}${dir ? ` em ${dir}` : ''}`
  },
  async run(args, ctx) {
    const pattern = String(pick(args, 'pattern', 'glob') || '').trim()
    if (!pattern) return { output: 'Erro: parâmetro "pattern" é obrigatório.', isError: true }
    const dir = resolvePath(ctx.cwd, pick(args, 'path', 'dir', 'directory') || '.')
    if (!fs.existsSync(dir)) return { output: `Erro: diretório não existe: ${dir}`, isError: true }
    let files
    let note = ''
    if (ripgrep()) {
      const r = await runCollect('rg', ['--files', '--hidden', '--no-config', '--glob', pattern, ...ignoredGlobs], { cwd: dir, signal: ctx.signal, maxLines: 5000 })
      if (r.code === 2) return { output: `Erro do ripgrep: ${r.err.trim().slice(0, 500)}`, isError: true }
      files = r.lines.filter(Boolean)
      if (r.timedOut) note = `\n(busca interrompida após ${SEARCH_TIMEOUT / 1000}s; resultados parciais — restrinja com path)`
    } else {
      const re = globToRegExp(pattern)
      const baseOnly = !pattern.includes('/')
      const w = await walkAsync(dir, { maxFiles: 100000, signal: ctx.signal, timeMs: 30000 })
      files = w.files.filter((f) => re.test(f) || (baseOnly && re.test(path.posix.basename(f))))
      if (w.truncated) note = `\n(busca parcial: ${w.reason} — restrinja com path ou um padrão mais específico)`
    }
    const withTime = await Promise.all(files.slice(0, 2000).map(async (f) => {
      let mtime = 0
      try {
        mtime = (await fs.promises.stat(path.join(dir, f))).mtimeMs
      } catch {}
      return { f, mtime }
    }))
    withTime.sort((a, b) => b.mtime - a.mtime)
    const limit = 200
    const shown = withTime.slice(0, limit).map(({ f }) => displayPath(ctx.cwd, path.join(dir, f)))
    if (!shown.length) return { output: 'Nenhum arquivo encontrado.', display: { summary: 'nenhum arquivo' } }
    const more = files.length > limit ? `\n(… mais ${files.length - limit} arquivos; refine o padrão)` : ''
    return { output: shown.join('\n') + more + note, display: { summary: `${files.length} arquivo${files.length === 1 ? '' : 's'}${note ? ' (parcial)' : ''}` } }
  },
}

export const grep = {
  name: 'grep',
  label: 'Grep',
  readOnly: true,
  description:
    'Search file contents with a regular expression (ripgrep syntax). Returns "path:line:text" matches by default. Options: glob filter (e.g. "*.js"), case-insensitive, context lines, or output_mode "files_with_matches" / "count". Use this instead of grep/rg in bash.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for' },
      path: { type: 'string', description: 'File or directory to search (default: working directory)' },
      glob: { type: 'string', description: 'Only search files matching this glob, e.g. "*.ts"' },
      ignore_case: { type: 'boolean', description: 'Case-insensitive search' },
      context: { type: 'integer', description: 'Lines of context around each match' },
      output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: 'Default: content' },
      head_limit: { type: 'integer', description: 'Max output lines (default 200)' },
    },
    required: ['pattern'],
  },
  summary(args) {
    const p = pick(args, 'pattern', 'regex', 'query')
    const where = pick(args, 'path', 'dir')
    const g = pick(args, 'glob', 'include')
    return `"${p || ''}"${where ? ` em ${where}` : ''}${g ? ` (${g})` : ''}`
  },
  async run(args, ctx) {
    const pattern = pick(args, 'pattern', 'regex', 'query')
    if (!pattern) return { output: 'Erro: parâmetro "pattern" é obrigatório.', isError: true }
    const target = resolvePath(ctx.cwd, pick(args, 'path', 'dir') || '.')
    if (!fs.existsSync(target)) return { output: `Erro: caminho não existe: ${target}`, isError: true }
    const mode = pick(args, 'output_mode', 'mode') || 'content'
    const limit = Math.max(1, Number(pick(args, 'head_limit', 'limit', 'max_results')) || 200)
    const ic = !!pick(args, 'ignore_case', '-i', 'case_insensitive')
    const ctxLines = Number(pick(args, 'context', '-C')) || 0
    const g = pick(args, 'glob', 'include')
    let lines
    let truncated = false
    if (ripgrep()) {
      const a = ['--no-config', '--color', 'never', '--hidden', '--glob', '!.git', '--max-columns', '400', '--max-columns-preview']
      if (ic) a.push('-i')
      if (g) a.push('--glob', String(g))
      a.push(...ignoredGlobs)
      if (mode === 'files_with_matches') a.push('--files-with-matches')
      else if (mode === 'count') a.push('--count-matches', '--with-filename')
      else {
        a.push('--line-number', '--no-heading', '--with-filename')
        if (ctxLines) a.push('-C', String(ctxLines))
      }
      a.push('-e', String(pattern), '--', path.relative(ctx.cwd, target) || '.')
      const r = await runCollect('rg', a, { cwd: ctx.cwd, signal: ctx.signal, maxLines: limit })
      if (r.code === 2 && !r.lines.length) return { output: `Erro do ripgrep: ${r.err.trim().slice(0, 500)}`, isError: true }
      lines = r.lines
      truncated = r.truncated
      if (r.timedOut) { truncated = true; lines.push(`(busca interrompida após ${SEARCH_TIMEOUT / 1000}s — restrinja com path ou glob)`) }
    } else if (systemGrep()) {
      // GNU grep: rápido, roda fora do processo e pode ser cancelado
      const a = ['-r', '-I', '-H', '--color=never', systemGrep()]
      if (ic) a.push('-i')
      for (const dir of IGNORED_DIRS) a.push(`--exclude-dir=${dir}`)
      if (g && !String(g).includes('/')) for (const one of expandBraces(String(g))) a.push(`--include=${one}`)
      if (mode === 'files_with_matches') a.push('-l')
      else if (mode === 'count') a.push('-c')
      else {
        a.push('-n')
        if (ctxLines) a.push('-C', String(ctxLines))
      }
      const rel = path.relative(ctx.cwd, target) || '.'
      a.push('-e', String(pattern), '--', rel)
      const r = await runCollect('grep', a, { cwd: ctx.cwd, signal: ctx.signal, maxLines: mode === 'count' ? 100000 : limit })
      if (r.code === 2 && !r.lines.length) return { output: `Erro do grep: ${r.err.trim().slice(0, 500)}`, isError: true }
      const globRe = g && String(g).includes('/') ? globToRegExp(String(g)) : null
      lines = r.lines
        .map((l) => l.replace(/^\.\//, ''))
        .filter((l) => !(mode === 'count' && /:0$/.test(l)))
        .filter((l) => !globRe || globRe.test(l.split(/[:-]\d+[:-]|:/)[0]))
        .map((l) => (l.length > 400 ? l.slice(0, 400) + '…' : l))
      truncated = r.truncated
      if (r.timedOut) { truncated = true; lines.push(`(busca interrompida após ${SEARCH_TIMEOUT / 1000}s — restrinja com path ou glob)`) }
    } else {
      let re
      try {
        re = new RegExp(String(pattern), ic ? 'i' : '')
      } catch (e) {
        return { output: `Erro: regex inválida: ${e.message}`, isError: true }
      }
      const globRe = g ? globToRegExp(String(g)) : null
      const isDir = fs.statSync(target).isDirectory()
      const files = isDir ? (await walkAsync(target, { signal: ctx.signal, timeMs: 30000 })).files.map((f) => path.join(target, f)) : [target]
      lines = []
      for (const file of files) {
        if (lines.length >= limit || ctx.signal?.aborted) {
          truncated = true
          break
        }
        if (globRe && !globRe.test(path.basename(file)) && !globRe.test(path.relative(target, file))) continue
        let buf
        try {
          if ((await fs.promises.stat(file)).size > 2 * 1024 * 1024) continue
          buf = await fs.promises.readFile(file)
        } catch {
          continue
        }
        if (isBinaryBuffer(buf)) continue
        const rel = displayPath(ctx.cwd, file)
        const fileLines = buf.toString('utf8').split('\n')
        let count = 0
        fileLines.forEach((l, i) => {
          if (!re.test(l)) return
          count++
          if (mode === 'content' && lines.length < limit) lines.push(`${rel}:${i + 1}:${l.slice(0, 400)}`)
        })
        if (count && mode === 'files_with_matches') lines.push(rel)
        if (count && mode === 'count') lines.push(`${rel}:${count}`)
      }
    }
    if (!lines.length) return { output: 'Nenhuma correspondência encontrada.', display: { summary: 'nenhum resultado' } }
    const files = new Set(lines.map((l) => l.split(/[:-]\d+[:-]/)[0]))
    const summary =
      mode === 'files_with_matches'
        ? `${lines.length} arquivo${lines.length === 1 ? '' : 's'}`
        : mode === 'count'
          ? `contagem em ${lines.length} arquivo${lines.length === 1 ? '' : 's'}`
          : `${lines.filter((l) => /:\d+:/.test(l)).length} resultado${lines.length === 1 ? '' : 's'} em ${files.size} arquivo${files.size === 1 ? '' : 's'}`
    return {
      output: lines.join('\n') + (truncated ? `\n(… resultados truncados em ${limit} linhas; refine a busca)` : ''),
      display: { summary: summary + (truncated ? '+' : '') },
    }
  },
}

export const ls = {
  name: 'ls',
  label: 'List',
  readOnly: true,
  description: 'List a directory as a tree (default depth 2), skipping heavy folders like node_modules and .git.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory (default: working directory)' },
      depth: { type: 'integer', description: 'Max depth (default 2)' },
    },
  },
  summary(args) {
    return pick(args, 'path', 'dir', 'directory') || '.'
  },
  async run(args, ctx) {
    const root = resolvePath(ctx.cwd, pick(args, 'path', 'dir', 'directory') || '.')
    const depth = Math.min(6, Math.max(1, Number(pick(args, 'depth', 'max_depth')) || 2))
    if (!fs.existsSync(root)) return { output: `Erro: diretório não existe: ${root}`, isError: true }
    if (!fs.statSync(root).isDirectory()) return { output: `${root} é um arquivo, não um diretório.`, isError: true }
    const out = []
    let count = 0
    const max = 400
    const rec = (dir, prefix, level) => {
      let entries
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      entries = entries.filter((e) => e.name !== '.git' && e.name !== '.DS_Store')
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      entries.forEach((e, i) => {
        if (count >= max) return
        const last = i === entries.length - 1
        const isDir = e.isDirectory()
        const skip = isDir && IGNORED_DIRS.has(e.name)
        out.push(`${prefix}${last ? '└── ' : '├── '}${e.name}${isDir ? '/' : ''}${skip ? ' (ignorado)' : ''}`)
        count++
        if (isDir && !skip && level < depth) rec(path.join(dir, e.name), prefix + (last ? '    ' : '│   '), level + 1)
      })
    }
    rec(root, '', 1)
    const header = displayPath(ctx.cwd, root) + '/'
    return {
      output: [header, ...out].join('\n') + (count >= max ? `\n(… lista truncada em ${max} entradas)` : ''),
      display: { summary: `${count} entrada${count === 1 ? '' : 's'}` },
    }
  },
}
