// Renderizador de Markdown linha a linha (compatível com streaming) e realce de sintaxe simples.

import { bold, fg, italic, strike, t, underline } from '../theme.js'
import { padEnd, strWidth, truncate, wrapLine } from './ansi.js'

const C = {
  keyword: fg('#a3e635'),
  string: fg('#a7f3d0'),
  number: fg('#5eead4'),
  comment: fg('#5f8a6c'),
  func: fg('#4ade80'),
  type: fg('#34d399'),
  punct: fg('#9fb8a6'),
  plain: (s) => s,
  inlineCode: fg('#bef264'),
  link: fg('#5eead4'),
}

const KW = {
  js: 'break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new return super switch this throw try typeof var void while with yield async await of static get set from as null undefined true false interface type enum implements private public protected readonly',
  py: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield None True False self match case',
  sh: 'if then else elif fi case esac for while until do done in function return local export echo exit set unset source alias cd sudo',
  go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false',
  rust: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while',
  c: 'auto break case char const continue default do double else enum extern float for goto if int long register return short signed sizeof static struct switch typedef union unsigned void volatile while include define class public private protected virtual template namespace using new delete bool true false nullptr',
  java: 'abstract boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long new package private protected public return short static super switch this throw throws try void while true false null var val fun when object',
  rb: 'begin end def class module if elsif else unless while until for in do return yield self nil true false and or not require puts',
  sql: 'select from where insert into values update set delete create table drop alter index join left right inner outer on group by order having limit as and or not null primary key foreign references distinct union all',
  php: 'function class public private protected return if else elseif foreach for while echo new use namespace static null true false array',
  lua: 'and break do else elseif end false for function if in local nil not or repeat return then true until while',
}
const KW_SETS = Object.fromEntries(Object.entries(KW).map(([k, v]) => [k, new Set(v.split(' '))]))

const ALIASES = {
  javascript: 'js',
  jsx: 'js',
  ts: 'js',
  typescript: 'js',
  tsx: 'js',
  mjs: 'js',
  cjs: 'js',
  json: 'json',
  jsonc: 'json',
  python: 'py',
  py: 'py',
  bash: 'sh',
  sh: 'sh',
  shell: 'sh',
  zsh: 'sh',
  console: 'sh',
  terminal: 'sh',
  go: 'go',
  golang: 'go',
  rust: 'rust',
  rs: 'rust',
  c: 'c',
  cpp: 'c',
  'c++': 'c',
  h: 'c',
  hpp: 'c',
  cs: 'java',
  csharp: 'java',
  java: 'java',
  kotlin: 'java',
  kt: 'java',
  swift: 'java',
  dart: 'java',
  ruby: 'rb',
  rb: 'rb',
  sql: 'sql',
  php: 'php',
  lua: 'lua',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'yaml',
  ini: 'yaml',
  dockerfile: 'sh',
  makefile: 'sh',
  diff: 'diff',
  patch: 'diff',
}

const COMMENTS = { js: '//', go: '//', rust: '//', c: '//', java: '//', php: '//', py: '#', sh: '#', rb: '#', yaml: '#', sql: '--', lua: '--' }

const tokenRes = new Map()
function tokenRe(lang) {
  if (tokenRes.has(lang)) return tokenRes.get(lang)
  const cm = COMMENTS[lang]
  const comment = cm ? `(${cm.replace(/[/]/g, '\\/')}.*$)` : '(\\b\\B)'
  const re = new RegExp(
    `${comment}|("(?:[^"\\\\]|\\\\.)*"?|'(?:[^'\\\\]|\\\\.)*'?|\`(?:[^\`\\\\]|\\\\.)*\`?)|(\\b0x[0-9a-fA-F]+\\b|\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)|([A-Za-z_$][\\w$]*)|(\\s+)|([^\\sA-Za-z_$\\d"'\`]+)`,
    'g',
  )
  tokenRes.set(lang, re)
  return re
}

/** Realça uma linha de código. */
export function highlightLine(line, langRaw = '') {
  const lang = ALIASES[langRaw.toLowerCase()] || langRaw.toLowerCase()
  if (lang === 'diff') {
    if (line.startsWith('+')) return t.added(line)
    if (line.startsWith('-')) return t.removed(line)
    if (line.startsWith('@@')) return t.info(line)
    return t.muted(line)
  }
  const kws = KW_SETS[lang]
  if (!kws && lang !== 'json' && lang !== 'yaml') return line
  const re = tokenRe(lang)
  re.lastIndex = 0
  let out = ''
  let m
  while ((m = re.exec(line))) {
    const [tok, comment, str, num, ident, space, punct] = m
    if (comment) out += italic(C.comment(comment))
    else if (str) {
      const isKey = lang === 'json' && /^\s*:/.test(line.slice(re.lastIndex))
      out += isKey ? C.type(str) : C.string(str)
    } else if (num) out += C.number(num)
    else if (ident) {
      if (kws?.has(ident)) out += C.keyword(ident)
      else if ((lang === 'json' || lang === 'yaml') && /^(true|false|null)$/.test(ident)) out += C.keyword(ident)
      else if (lang === 'yaml' && /^\s*:/.test(line.slice(re.lastIndex))) out += C.type(ident)
      else if (/^\s*\(/.test(line.slice(re.lastIndex))) out += C.func(ident)
      else if (/^[A-Z]/.test(ident) && lang !== 'sql') out += C.type(ident)
      else out += ident
    } else if (space) out += space
    else if (punct) out += C.punct(punct)
    else out += tok
    if (m.index === re.lastIndex) re.lastIndex++
  }
  return out
}

/** Estilos inline: **negrito**, *itálico*, `código`, ~~riscado~~, [links](url). */
export function renderInline(text) {
  const codes = []
  let s = String(text).replace(/(`+)([^`]*?)\1/g, (_, ticks, code) => {
    codes.push(code)
    return `\uE000${codes.length - 1}\uE001`
  })
  s = s.replace(/\[([^\]]+)\]\((\S+?)\)/g, (_, label, url) => underline(C.link(label)) + t.muted(` (${url})`))
  s = s.replace(/<(https?:\/\/[^>\s]+)>/g, (_, u) => underline(C.link(u)))
  s = s.replace(/\*\*\*(?=\S)(.+?)(?<=\S)\*\*\*/g, (_, x) => bold(italic(x)))
  s = s.replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, (_, x) => bold(x))
  s = s.replace(/__(?=\S)(.+?)(?<=\S)__/g, (_, x) => bold(x))
  s = s.replace(/(^|[^\w*\\])\*(?=[^\s*])(.+?)(?<=[^\s*\\])\*(?![\w*])/g, (_, pre, x) => pre + italic(x))
  s = s.replace(/(^|[^\w\\])_(?=[^\s_])(.+?)(?<=[^\s_])_(?!\w)/g, (_, pre, x) => pre + italic(x))
  s = s.replace(/~~(?=\S)(.+?)(?<=\S)~~/g, (_, x) => strike(x))
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1')
  return s.replace(/\uE000(\d+)\uE001/g, (_, i) => C.inlineCode(codes[Number(i)]))
}

function splitRow(line) {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
}

function isTableSep(cells) {
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c))
}

/**
 * Renderer de Markdown com estado (blocos de código e tabelas atravessam linhas).
 * Alimente linha a linha com `line()` e chame `end()` no final.
 */
export class MarkdownRenderer {
  constructor({ width = 80 } = {}) {
    this.width = Math.max(20, width)
    this.inCode = false
    this.fence = ''
    this.lang = ''
    this.table = []
  }

  codeLine(raw) {
    const prefix = t.borderDim('│ ')
    const body = highlightLine(raw.replace(/\t/g, '    '), this.lang)
    return wrapLine(body, this.width - 2).map((l) => prefix + l)
  }

  flushTable() {
    if (!this.table.length) return []
    const rows = this.table.map(splitRow)
    this.table = []
    let header = null
    let aligns = []
    let body = rows
    if (rows.length >= 2 && isTableSep(rows[1])) {
      header = rows[0]
      aligns = rows[1].map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left'))
      body = rows.slice(2)
    }
    const all = header ? [header, ...body] : body
    const ncol = Math.max(...all.map((r) => r.length))
    const rendered = all.map((r) => Array.from({ length: ncol }, (_, i) => renderInline(r[i] ?? '')))
    const widths = Array.from({ length: ncol }, (_, i) => Math.max(3, ...rendered.map((r) => strWidth(r[i]))))
    const avail = this.width - (ncol * 3 + 1)
    let total = widths.reduce((a, b) => a + b, 0)
    while (total > avail && Math.max(...widths) > 6) {
      const i = widths.indexOf(Math.max(...widths))
      widths[i]--
      total--
    }
    const b = t.borderDim
    const line = (l, m, r) => b(l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r)
    const fmtRow = (cells, isHeader) =>
      b('│') +
      cells
        .map((c, i) => {
          let cell = truncate(c, widths[i])
          const pad = widths[i] - strWidth(cell)
          if (aligns[i] === 'right') cell = ' '.repeat(pad) + cell
          else if (aligns[i] === 'center') cell = ' '.repeat(Math.floor(pad / 2)) + cell + ' '.repeat(pad - Math.floor(pad / 2))
          else cell = padEnd(cell, widths[i])
          return ' ' + (isHeader ? bold(t.primary(cell)) : cell) + ' '
        })
        .join(b('│')) +
      b('│')
    const out = [line('┌', '┬', '┐')]
    rendered.forEach((r, idx) => {
      out.push(fmtRow(r, header && idx === 0))
      if (header && idx === 0) out.push(line('├', '┼', '┤'))
    })
    out.push(line('└', '┴', '┘'))
    return out
  }

  /** Processa uma linha completa e devolve as linhas renderizadas. */
  line(raw) {
    const out = []
    const trimmed = raw.trim()
    if (this.inCode) {
      if (trimmed.startsWith(this.fence[0].repeat(3)) && trimmed.replace(/[`~]/g, '') === '' && trimmed.length >= this.fence.length) {
        this.inCode = false
        out.push(t.borderDim('╰─'))
        return out
      }
      return this.codeLine(raw)
    }
    const isTableLine = trimmed.startsWith('|') && trimmed.indexOf('|', 1) !== -1
    if (this.table.length && !isTableLine) out.push(...this.flushTable())
    if (isTableLine) {
      this.table.push(raw)
      return out
    }
    const fence = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(raw)
    if (fence) {
      this.inCode = true
      this.fence = fence[1]
      this.lang = fence[2] || ''
      out.push(t.borderDim('╭─') + (this.lang ? ' ' + t.muted(this.lang) : ''))
      return out
    }
    if (!trimmed) {
      out.push('')
      return out
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(raw)
    if (heading) {
      const level = heading[1].length
      const text = renderInline(heading[2])
      const styled = level === 1 ? bold(underline(t.primary(text))) : level === 2 ? bold(t.primary(text)) : level === 3 ? bold(t.emerald(text)) : bold(text)
      out.push(...wrapLine(styled, this.width))
      return out
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) {
      out.push(t.borderDim('─'.repeat(Math.min(this.width, 60))))
      return out
    }
    const quote = /^\s*>\s?(.*)$/.exec(raw)
    if (quote) {
      for (const l of wrapLine(italic(t.muted(renderInline(quote[1]))), this.width - 2)) out.push(t.border('▎ ') + l)
      return out
    }
    const list = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(raw)
    if (list) {
      const indent = Math.min(12, Math.floor(list[1].replace(/\t/g, '  ').length / 2) * 2)
      let marker = list[2]
      let body = list[3]
      const task = /^\[([ xX])\]\s+(.*)$/.exec(body)
      if (task) {
        marker = task[1] === ' ' ? t.muted('☐') : t.primary('☒')
        body = task[1] === ' ' ? task[2] : t.muted(task[2])
      } else if (/^[-*+]$/.test(marker)) marker = t.primary(indent ? '◦' : '•')
      else marker = t.primary(marker)
      const first = ' '.repeat(indent) + marker + ' '
      const rest = ' '.repeat(indent + strWidth(marker) + 1)
      const wrapped = wrapLine(renderInline(body), Math.max(10, this.width - strWidth(rest)))
      wrapped.forEach((l, i) => out.push((i ? rest : first) + l))
      return out
    }
    out.push(...wrapLine(renderInline(raw), this.width))
    return out
  }

  /** Prévia (sem alterar estado) de uma linha incompleta, usada durante o streaming. */
  preview(partial) {
    if (!partial) return []
    if (this.inCode) return this.codeLine(partial)
    if (partial.trim().startsWith('|')) return [t.muted(truncate(partial, this.width))]
    const saved = { inCode: this.inCode, fence: this.fence, lang: this.lang, table: this.table }
    this.table = []
    const lines = this.line(partial)
    Object.assign(this, saved)
    return lines
  }

  /** Fecha blocos pendentes. */
  end() {
    const out = [...this.flushTable()]
    if (this.inCode) {
      out.push(t.borderDim('╰─'))
      this.inCode = false
    }
    return out
  }
}

/** Renderiza um texto Markdown completo. */
export function renderMarkdown(text, width) {
  const r = new MarkdownRenderer({ width })
  const out = []
  for (const l of String(text).split('\n')) out.push(...r.line(l))
  out.push(...r.end())
  return out
}
