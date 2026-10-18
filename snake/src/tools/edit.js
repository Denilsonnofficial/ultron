// Edição de arquivos: edit (um trecho), multiedit (vários trechos no mesmo arquivo, tudo ou nada)
// e apply_patch (vários arquivos no formato "*** Begin Patch", usado por modelos da família GPT).
//
// A busca do trecho é tolerante em camadas, como no OpenCode: exata → aspas/travessões/espaços
// tipográficos normalizados → linha a linha ignorando espaços nas pontas → espaços colapsados.
// Quebras de linha CRLF e BOM do arquivo são preservadas.

import fs from 'node:fs'
import path from 'node:path'
import { diffLines } from './diff.js'
import { displayPath, pick, resolvePath } from './util.js'

const BOM = '﻿'

function findAll(haystack, needle) {
  const spans = []
  let i = haystack.indexOf(needle)
  while (i !== -1) {
    spans.push([i, i + needle.length])
    i = haystack.indexOf(needle, i + needle.length)
  }
  return spans
}

function lineStarts(lines) {
  const starts = []
  let off = 0
  for (const l of lines) {
    starts.push(off)
    off += l.length + 1
  }
  return starts
}

// Troca de 1 caractere por 1 caractere: os deslocamentos continuam valendo no texto original.
export function normalizeTypography(s) {
  return s
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/[  -   　]/g, ' ')
}

// Tolerância: compara linha a linha ignorando espaços no início/fim.
function lineTrimmedMatches(content, find) {
  const cLines = content.split('\n')
  let fLines = find.split('\n')
  while (fLines.length && fLines[fLines.length - 1].trim() === '') fLines = fLines.slice(0, -1)
  while (fLines.length && fLines[0].trim() === '') fLines = fLines.slice(1)
  if (!fLines.length) return []
  const starts = lineStarts(cLines)
  const spans = []
  const norm = (l) => normalizeTypography(l.trim())
  for (let i = 0; i + fLines.length <= cLines.length; i++) {
    let ok = true
    for (let j = 0; j < fLines.length; j++) {
      if (norm(cLines[i + j]) !== norm(fLines[j])) {
        ok = false
        break
      }
    }
    if (ok) {
      const last = i + fLines.length - 1
      spans.push([starts[i], starts[last] + cLines[last].length])
    }
  }
  return spans
}

// Tolerância: colapsa qualquer sequência de espaços em branco.
function whitespaceMatches(content, find) {
  const norm = (s) => normalizeTypography(s).replace(/\s+/g, ' ').trim()
  const target = norm(find)
  if (!target) return []
  const cLines = content.split('\n')
  const starts = lineStarts(cLines)
  const n = Math.max(1, find.trim().split('\n').length)
  const spans = []
  for (let i = 0; i + n <= cLines.length; i++) {
    const windowText = cLines.slice(i, i + n).join('\n')
    if (norm(windowText) === target) spans.push([starts[i], starts[i + n - 1] + cLines[i + n - 1].length])
  }
  return spans
}

/** Remove o prefixo "     12\t" da saída de read, que modelos às vezes copiam para old_string/new_string. */
export function stripLinePrefixes(oldStr, newStr, content) {
  const re = /^ *\d+\t/
  const lines = oldStr.split('\n').filter((l) => l !== '')
  if (!lines.length || !lines.every((l) => re.test(l)) || content.includes(lines[0])) return [oldStr, newStr]
  const strip = (s) => s.split('\n').map((l) => l.replace(re, '')).join('\n')
  const newLines = newStr.split('\n').filter((l) => l !== '')
  return [strip(oldStr), newLines.length && newLines.every((l) => re.test(l)) ? strip(newStr) : newStr]
}

/** Aplica uma substituição em `content` (texto com \n). Devolve { updated, count, fuzzy, at } ou { error }. */
export function applyEdit(content, oldStr, newStr, { replaceAll = false, rel = 'arquivo' } = {}) {
  oldStr = String(oldStr).replace(/\r\n/g, '\n')
  newStr = String(newStr).replace(/\r\n/g, '\n')
  ;[oldStr, newStr] = stripLinePrefixes(oldStr, newStr, content)
  if (oldStr === newStr) return { error: 'old_string e new_string são idênticos; nada a fazer.' }
  if (oldStr === '') {
    if (content.trim()) return { error: 'old_string vazio só é permitido para arquivos vazios ou novos (use write para sobrescrever).' }
    return { updated: newStr, count: 1, fuzzy: false, at: 0 }
  }
  let spans = findAll(content, oldStr)
  let fuzzy = false
  if (!spans.length) {
    spans = findAll(normalizeTypography(content), normalizeTypography(oldStr))
    if (!spans.length) spans = lineTrimmedMatches(content, oldStr)
    if (!spans.length) spans = whitespaceMatches(content, oldStr)
    fuzzy = spans.length > 0
    if (fuzzy && newStr.endsWith('\n') && oldStr.endsWith('\n')) newStr = newStr.slice(0, -1)
  }
  if (!spans.length) return { error: `old_string não encontrado em ${rel}. Leia o arquivo de novo (read) e copie o trecho exato, incluindo a indentação e sem o número da linha.`, summary: 'trecho não encontrado' }
  if (spans.length > 1 && !replaceAll) return { error: `old_string aparece ${spans.length} vezes em ${rel}. Inclua mais linhas de contexto para torná-lo único ou use replace_all: true.`, summary: `${spans.length} ocorrências — ambíguo` }
  const targets = replaceAll ? spans : [spans[0]]
  let updated = content
  for (const [s, e] of [...targets].reverse()) updated = updated.slice(0, s) + newStr + updated.slice(e)
  return { updated, count: targets.length, fuzzy, at: targets[0][0], newStr }
}

/** Lê o arquivo separando BOM e CRLF, para editar sempre a visão com \n que o read mostra. */
function readText(abs) {
  let raw = fs.readFileSync(abs, 'utf8')
  const bom = raw.startsWith(BOM)
  if (bom) raw = raw.slice(1)
  const crlf = raw.includes('\r\n') && raw.split('\r\n').length - 1 >= (raw.split('\n').length - 1) / 2
  return { raw: (bom ? BOM : '') + raw, content: raw.replace(/\r\n/g, '\n'), bom, crlf }
}
function writeText(abs, text, { bom, crlf }) {
  fs.writeFileSync(abs, (bom ? BOM : '') + (crlf ? text.replace(/\r?\n/g, '\r\n') : text))
}

function snippetAround(updated, at, newStr) {
  const firstLine = updated.slice(0, at).split('\n').length
  const newLines = updated.split('\n')
  const from = Math.max(1, firstLine - 3)
  const to = Math.min(newLines.length, firstLine + String(newStr).split('\n').length + 2)
  return newLines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(6)}\t${l}`).join('\n')
}

const pathOf = (args) => pick(args, 'path', 'file_path', 'filePath', 'file')

const edit = {
  name: 'edit',
  label: 'Edit',
  readOnly: false,
  description:
    'Edit a file by replacing an exact string. `old_string` must match the file content exactly (including indentation) and be unique, unless `replace_all` is true. Include enough surrounding lines to make it unique and never include the line-number prefix shown by read. If there is no exact match, the edit retries ignoring typographic quote/dash/space variants and then leading/trailing whitespace per line. The file keeps its CRLF/LF endings. To create a new file, use `write` (or an empty `old_string` on a missing/empty file). For several changes in one file prefer `multiedit`.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (relative or absolute)' },
      old_string: { type: 'string', description: 'Exact text to replace' },
      new_string: { type: 'string', description: 'Replacement text (must differ from old_string)' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  summary(args, ctx) {
    const p = pathOf(args)
    return p ? displayPath(ctx.cwd, resolvePath(ctx.cwd, p)) : ''
  },
  async run(args, ctx) {
    const p = pathOf(args)
    const oldStr = pick(args, 'old_string', 'oldString', 'old_str', 'search')
    const newStr = pick(args, 'new_string', 'newString', 'new_str', 'replace')
    if (!p) return { output: 'Erro: parâmetro "path" é obrigatório.', isError: true }
    if (oldStr === undefined || newStr === undefined) return { output: 'Erro: "old_string" e "new_string" são obrigatórios.', isError: true }
    const abs = resolvePath(ctx.cwd, p)
    const rel = displayPath(ctx.cwd, abs)

    if (!fs.existsSync(abs)) {
      if (String(oldStr) !== '') return { output: `Erro: arquivo não existe: ${abs}. Para criar, use a ferramenta write.`, isError: true, display: { summary: 'arquivo não existe' } }
      ctx.checkpoint?.(abs, null)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, String(newStr))
      ctx.markRead?.(abs, fs.statSync(abs).mtimeMs)
      const diff = diffLines('', String(newStr), { maxLines: 400 })
      return { output: `Arquivo criado: ${rel}.`, display: { summary: `Criou ${rel} (+${diff.added})`, diff, path: rel } }
    }
    if (fs.statSync(abs).isDirectory()) return { output: `Erro: ${abs} é um diretório.`, isError: true }
    const file = readText(abs)
    const r = applyEdit(file.content, oldStr, newStr, { replaceAll: !!pick(args, 'replace_all', 'replaceAll'), rel })
    if (r.error) return { output: `Erro: ${r.error}`, isError: true, display: { summary: r.summary || 'falhou' } }
    if (r.updated === file.content) return { output: `Erro: a edição não muda ${rel}.`, isError: true }

    ctx.checkpoint?.(abs, file.raw)
    writeText(abs, r.updated, file)
    ctx.markRead?.(abs, fs.statSync(abs).mtimeMs)
    const diff = diffLines(file.content, r.updated, { maxLines: 400 })
    return {
      output: `Editado ${rel}: ${r.count} substituição${r.count === 1 ? '' : 'ões'}${r.fuzzy ? ' (correspondência tolerante)' : ''}.\nTrecho atualizado:\n${snippetAround(r.updated, r.at, r.newStr)}`,
      display: { summary: `${rel} +${diff.added} −${diff.removed}`, diff, path: rel },
    }
  },
}

export const multiedit = {
  name: 'multiedit',
  label: 'MultiEdit',
  readOnly: false,
  description:
    'Apply several find-and-replace edits to ONE file in a single atomic operation. Edits run in order, each on the result of the previous one; if any edit fails, nothing is written. Each edit follows the same rules as `edit` (exact unique old_string unless replace_all).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (relative or absolute)' },
      edits: {
        type: 'array',
        description: 'Edits to apply in order',
        items: {
          type: 'object',
          properties: {
            old_string: { type: 'string' },
            new_string: { type: 'string' },
            replace_all: { type: 'boolean' },
          },
          required: ['old_string', 'new_string'],
        },
      },
    },
    required: ['path', 'edits'],
  },
  summary(args, ctx) {
    const p = pathOf(args)
    const n = Array.isArray(args?.edits) ? args.edits.length : 0
    return p ? `${displayPath(ctx.cwd, resolvePath(ctx.cwd, p))} · ${n} edição${n === 1 ? '' : 'ões'}` : ''
  },
  async run(args, ctx) {
    const p = pathOf(args)
    let edits = args?.edits
    if (typeof edits === 'string') try { edits = JSON.parse(edits) } catch {}
    if (!p) return { output: 'Erro: parâmetro "path" é obrigatório.', isError: true }
    if (!Array.isArray(edits) || !edits.length) return { output: 'Erro: "edits" deve ser uma lista não vazia de {old_string, new_string}.', isError: true }
    const abs = resolvePath(ctx.cwd, p)
    const rel = displayPath(ctx.cwd, abs)
    const exists = fs.existsSync(abs)
    if (exists && fs.statSync(abs).isDirectory()) return { output: `Erro: ${abs} é um diretório.`, isError: true }
    const file = exists ? readText(abs) : { raw: null, content: '', bom: false, crlf: false }
    if (!exists && pick(edits[0], 'old_string', 'oldString') !== '') return { output: `Erro: arquivo não existe: ${abs}. A primeira edição precisa ter old_string vazio para criá-lo.`, isError: true }
    let content = file.content
    let total = 0
    for (const [i, e] of edits.entries()) {
      const r = applyEdit(content, pick(e, 'old_string', 'oldString') ?? '', pick(e, 'new_string', 'newString') ?? '', { replaceAll: !!pick(e, 'replace_all', 'replaceAll'), rel })
      if (r.error) return { output: `Erro na edição ${i + 1} de ${edits.length} (nada foi gravado): ${r.error}`, isError: true, display: { summary: `edição ${i + 1} falhou` } }
      content = r.updated
      total += r.count
    }
    ctx.checkpoint?.(abs, file.raw)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    writeText(abs, content, file)
    ctx.markRead?.(abs, fs.statSync(abs).mtimeMs)
    const diff = diffLines(file.content, content, { maxLines: 400 })
    return {
      output: `${exists ? 'Editado' : 'Criado'} ${rel}: ${edits.length} edição(ões), ${total} substituição(ões) (+${diff.added} −${diff.removed}).`,
      display: { summary: `${rel} +${diff.added} −${diff.removed}`, diff, path: rel },
    }
  },
}

// ───────────────────────────── apply_patch ─────────────────────────────

/** Interpreta o texto do patch. Lança Error com mensagem legível para o modelo. */
export function parsePatch(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n')
  let i = lines.findIndex((l) => l.trim() === '*** Begin Patch')
  if (i === -1) throw new Error('o patch precisa começar com "*** Begin Patch"')
  i++
  const ops = []
  let cur = null
  for (; i < lines.length; i++) {
    const line = lines[i]
    const t = line.trim()
    if (t === '*** End Patch') { cur = null; break }
    let m
    if ((m = /^\*\*\* Add File: (.+)$/.exec(t))) { cur = { type: 'add', path: m[1].trim(), lines: [] }; ops.push(cur); continue }
    if ((m = /^\*\*\* Delete File: (.+)$/.exec(t))) { cur = { type: 'delete', path: m[1].trim() }; ops.push(cur); continue }
    if ((m = /^\*\*\* Update File: (.+)$/.exec(t))) { cur = { type: 'update', path: m[1].trim(), chunks: [] }; ops.push(cur); continue }
    if (!cur) { if (t) throw new Error(`linha fora de uma seção de arquivo: "${line.slice(0, 80)}"`); continue }
    if (cur.type === 'add') {
      if (line.startsWith('+')) cur.lines.push(line.slice(1))
      else if (t) throw new Error(`em "Add File: ${cur.path}", toda linha precisa começar com "+"`)
      continue
    }
    if (cur.type === 'delete') { if (t) throw new Error(`"Delete File: ${cur.path}" não aceita conteúdo`); continue }
    if ((m = /^\*\*\* Move to: (.+)$/.exec(t))) { cur.moveTo = m[1].trim(); continue }
    if (t === '*** End of File') { if (cur.chunks.length) cur.chunks.at(-1).eof = true; continue }
    if (line.startsWith('@@')) { cur.chunks.push({ header: line.slice(2).trim(), old: [], new: [] }); continue }
    if (!cur.chunks.length) cur.chunks.push({ header: '', old: [], new: [] })
    const chunk = cur.chunks.at(-1)
    const sign = line[0]
    const body = line.slice(1)
    if (sign === '-') chunk.old.push(body)
    else if (sign === '+') chunk.new.push(body)
    else if (sign === ' ' || line === '') { chunk.old.push(sign === ' ' ? body : ''); chunk.new.push(sign === ' ' ? body : '') }
    else throw new Error(`linha inválida em "Update File: ${cur.path}": "${line.slice(0, 80)}" (use espaço, "-" ou "+" no início)`)
  }
  if (!ops.length) throw new Error('patch vazio: nenhuma seção Add/Update/Delete File')
  return ops
}

function seek(lines, block, from) {
  if (!block.length) return -1
  const tiers = [(s) => s, (s) => s.trimEnd(), (s) => normalizeTypography(s.trim())]
  for (const norm of tiers) {
    const target = block.map(norm)
    for (let i = from; i + block.length <= lines.length; i++) {
      let ok = true
      for (let j = 0; j < block.length; j++) if (norm(lines[i + j]) !== target[j]) { ok = false; break }
      if (ok) return i
    }
  }
  return -1
}

/** Aplica os trechos de um "Update File" ao conteúdo. */
export function applyChunks(content, chunks, rel) {
  const hadNewline = content.endsWith('\n')
  const lines = content.split('\n')
  if (hadNewline) lines.pop()
  let cursor = 0
  for (const [n, chunk] of chunks.entries()) {
    const headerAt = chunk.header ? seek(lines, [chunk.header], cursor) : -1
    if (headerAt !== -1) cursor = headerAt
    let old = chunk.old
    let neu = chunk.new
    if (!old.length) {
      // só inserções: logo depois da linha do cabeçalho @@, ou no fim do arquivo
      const at = headerAt !== -1 ? headerAt + 1 : lines.length
      lines.splice(at, 0, ...neu)
      cursor = at + neu.length
      continue
    }
    let at = seek(lines, old, cursor)
    if (at === -1) {
      // contexto com linhas em branco nas pontas costuma vir errado; tenta sem elas
      while (old.length && !old[0].trim() && !neu[0]?.trim()) { old = old.slice(1); neu = neu.slice(1) }
      while (old.length && !old.at(-1).trim() && !neu.at(-1)?.trim()) { old = old.slice(0, -1); neu = neu.slice(0, -1) }
      at = seek(lines, old, cursor)
      if (at === -1) at = seek(lines, old, 0)
    }
    if (at === -1) throw new Error(`trecho ${n + 1} não encontrado em ${rel}:\n${chunk.old.slice(0, 6).join('\n')}`)
    lines.splice(at, old.length, ...neu)
    cursor = at + neu.length
  }
  return lines.join('\n') + (hadNewline || !content ? '\n' : '')
}

export const applyPatch = {
  name: 'apply_patch',
  label: 'Patch',
  readOnly: false,
  description: `Apply a patch that adds, updates, moves or deletes one or more files. Format:
*** Begin Patch
*** Add File: path/new.txt
+first line of the new file
*** Update File: src/app.py
*** Move to: src/main.py        (optional rename)
@@ def greet():                  (optional context line to locate the change)
 unchanged context line
-line to remove
+line to add
*** Delete File: obsolete.txt
*** End Patch
Every line inside Add File starts with "+". In Update File chunks, context lines start with a space, removed lines with "-", added lines with "+". Include 1-3 lines of context around each change. All files are validated before anything is written.`,
  parameters: {
    type: 'object',
    properties: { patch: { type: 'string', description: 'Full patch text, from "*** Begin Patch" to "*** End Patch"' } },
    required: ['patch'],
  },
  summary(args) {
    try {
      const ops = parsePatch(pick(args, 'patch', 'patchText', 'input') || '')
      return ops.map((o) => `${o.type === 'add' ? 'A' : o.type === 'delete' ? 'D' : 'M'} ${o.moveTo || o.path}`).join(', ')
    } catch { return '' }
  },
  async run(args, ctx) {
    const text = pick(args, 'patch', 'patchText', 'input')
    if (!text) return { output: 'Erro: parâmetro "patch" é obrigatório.', isError: true }
    let ops
    try { ops = parsePatch(text) } catch (e) { return { output: `Erro: patch inválido: ${e.message}`, isError: true, display: { summary: 'patch inválido' } } }
    // 1) valida e calcula tudo em memória
    const plan = []
    for (const op of ops) {
      const abs = resolvePath(ctx.cwd, op.path)
      const rel = displayPath(ctx.cwd, abs)
      const exists = fs.existsSync(abs)
      try {
        if (op.type === 'add') {
          if (exists) throw new Error(`${rel} já existe (use Update File)`)
          plan.push({ op, abs, rel, before: null, after: op.lines.join('\n') + (op.lines.length ? '\n' : '') })
        } else if (op.type === 'delete') {
          if (!exists) throw new Error(`${rel} não existe`)
          const file = readText(abs)
          plan.push({ op, abs, rel, before: file, after: null })
        } else {
          if (!exists) throw new Error(`${rel} não existe (use Add File)`)
          const file = readText(abs)
          const after = applyChunks(file.content, op.chunks, rel)
          const dest = op.moveTo ? resolvePath(ctx.cwd, op.moveTo) : abs
          if (op.moveTo && fs.existsSync(dest)) throw new Error(`destino ${displayPath(ctx.cwd, dest)} já existe`)
          plan.push({ op, abs, rel, before: file, after, dest })
        }
      } catch (e) {
        return { output: `Erro: ${e.message}. Nenhum arquivo foi alterado. Leia os arquivos de novo e refaça o patch.`, isError: true, display: { summary: 'patch não aplicado' } }
      }
    }
    // 2) grava
    const report = []
    let added = 0
    let removed = 0
    const diffs = []
    for (const p of plan) {
      ctx.checkpoint?.(p.abs, p.before ? p.before.raw : null)
      if (p.op.type === 'delete') {
        fs.rmSync(p.abs, { force: true })
        report.push(`D ${p.rel}`)
        removed += p.before.content.split('\n').length
        continue
      }
      const dest = p.dest || p.abs
      if (dest !== p.abs) ctx.checkpoint?.(dest, null)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      writeText(dest, p.after, p.before || { bom: false, crlf: false })
      if (dest !== p.abs) fs.rmSync(p.abs, { force: true })
      ctx.markRead?.(dest, fs.statSync(dest).mtimeMs)
      const d = diffLines(p.before?.content || '', p.after, { maxLines: 200 })
      added += d.added
      removed += d.removed
      diffs.push(d)
      report.push(`${p.op.type === 'add' ? 'A' : 'M'} ${displayPath(ctx.cwd, dest)}${dest !== p.abs ? ` (movido de ${p.rel})` : ''}`)
    }
    return {
      output: `Patch aplicado:\n${report.join('\n')}`,
      display: { summary: `${plan.length} arquivo${plan.length === 1 ? '' : 's'} +${added} −${removed}`, diff: diffs.length === 1 ? diffs[0] : undefined, files: report },
    }
  },
}

export default edit
