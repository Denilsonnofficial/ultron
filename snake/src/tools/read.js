import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { displayPath, isBinaryBuffer, pick, resolvePath } from './util.js'

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tiff'])
const MAX_LINE = 2000
const DEFAULT_LIMIT = 2000
const MAX_BYTES = 50 * 1024

function pdfText(abs) {
  const r = spawnSync('pdftotext', ['-layout', '-q', abs, '-'], { encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 * 1024 })
  return r.status === 0 ? r.stdout : null
}

function suggest(abs) {
  const dir = path.dirname(abs)
  const base = path.basename(abs).toLowerCase()
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().includes(base.slice(0, 4)) || base.includes(f.toLowerCase().split('.')[0]))
      .slice(0, 5)
      .map((f) => path.join(dir, f))
  } catch {
    return []
  }
}

export default {
  name: 'read',
  label: 'Read',
  readOnly: true,
  description:
    'Read a text file from disk. Returns the content with line numbers ("     N\\tline"; the prefix is NOT part of the file). Reads up to 2000 lines or 50 KB per call; use offset/limit to page through larger files. Lines longer than 2000 characters are truncated. Reading a directory lists its entries; PDFs are converted to text when pdftotext is installed. Read a file before editing it, and read several files in parallel when useful.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (relative to the working directory or absolute)' },
      offset: { type: 'integer', description: 'Line number to start from (1-based). Optional.' },
      limit: { type: 'integer', description: 'Maximum number of lines to read. Optional.' },
    },
    required: ['path'],
  },
  summary(args, ctx) {
    const p = pick(args, 'path', 'file_path', 'filePath', 'file')
    return p ? displayPath(ctx.cwd, resolvePath(ctx.cwd, p)) : ''
  },
  async run(args, ctx) {
    const p = pick(args, 'path', 'file_path', 'filePath', 'file')
    if (!p) return { output: 'Erro: parâmetro "path" é obrigatório.', isError: true }
    const abs = resolvePath(ctx.cwd, p)
    const rel = displayPath(ctx.cwd, abs)
    let st
    try {
      st = fs.statSync(abs)
    } catch {
      const alts = suggest(abs)
      return {
        output: `Erro: arquivo não encontrado: ${abs}${alts.length ? `\nVocê quis dizer:\n${alts.join('\n')}` : ''}`,
        isError: true,
        display: { summary: 'arquivo não encontrado' },
      }
    }
    if (st.isDirectory()) {
      let entries = fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)).map((e) => e.name + (e.isDirectory() ? '/' : ''))
      const total = entries.length
      entries = entries.slice(0, 300)
      return { output: `${abs} é um diretório:\n${entries.join('\n')}${total > entries.length ? `\n(… +${total - entries.length} entradas; use glob ou ls)` : ''}`, display: { summary: `diretório com ${total} entradas` } }
    }
    const ext = path.extname(abs).toLowerCase()
    if (IMAGE_EXT.has(ext)) {
      return { output: `[imagem ${rel}: ${st.size} bytes — este harness envia apenas texto ao modelo]`, display: { summary: `imagem (${st.size} bytes)` } }
    }
    if (st.size > 50 * 1024 * 1024) return { output: `Erro: arquivo grande demais (${st.size} bytes). Use grep ou bash (head/tail).`, isError: true }
    let text
    if (ext === '.pdf') {
      text = pdfText(abs)
      if (text == null) return { output: `[PDF ${rel}: ${st.size} bytes — instale poppler-utils (pdftotext) para extrair o texto]`, display: { summary: `PDF (${st.size} bytes)` } }
    } else {
      const buf = fs.readFileSync(abs)
      if (isBinaryBuffer(buf)) return { output: `[arquivo binário ${rel}: ${st.size} bytes]`, display: { summary: `binário (${st.size} bytes)` } }
      text = buf.toString('utf8')
    }
    ctx.markRead?.(abs, st.mtimeMs)
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    if (!text.length) return { output: '(arquivo vazio)', display: { summary: 'arquivo vazio' } }
    const all = text.split('\n')
    if (all.length > 1 && all[all.length - 1] === '') all.pop()
    const offset = Math.max(1, Number(pick(args, 'offset', 'start_line', 'line')) || 1)
    const limit = Math.max(1, Number(pick(args, 'limit', 'max_lines')) || DEFAULT_LIMIT)
    const wanted = all.slice(offset - 1, offset - 1 + limit)
    const width = String(offset + wanted.length).length
    const rows = []
    let bytes = 0
    for (const [i, line] of wanted.entries()) {
      const l = line.length > MAX_LINE ? line.slice(0, MAX_LINE) + `… [linha truncada em ${MAX_LINE} caracteres]` : line
      const row = `${String(offset + i).padStart(Math.max(6, width))}\t${l}`
      bytes += Buffer.byteLength(row, 'utf8') + 1
      if (bytes > MAX_BYTES && rows.length) break
      rows.push(row)
    }
    const slice = wanted.slice(0, rows.length)
    const body = rows.join('\n')
    const end = offset - 1 + slice.length
    const capped = slice.length < wanted.length
    const more = end < all.length ? `\n\n(mostrando linhas ${offset}-${end} de ${all.length}${capped ? ', limite de 50 KB por leitura' : ''}; use offset=${end + 1} para continuar)` : ''
    return {
      output: (slice.length ? body : `(offset ${offset} além do fim do arquivo: ${all.length} linhas)`) + more,
      display: { summary: `Leu ${slice.length} linha${slice.length === 1 ? '' : 's'}${end < all.length || offset > 1 ? ` (${offset}-${end} de ${all.length})` : ''}` },
    }
  },
}
