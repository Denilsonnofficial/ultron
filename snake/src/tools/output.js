// Limite de saída das ferramentas: o modelo recebe no máximo MAX_LINES linhas / MAX_BYTES bytes e,
// quando passa disso, a saída completa fica salva em ~/.snake/tool-output para ser lida depois com
// read (offset/limit) ou grep, em vez de ser perdida.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { paths } from '../config.js'

export const MAX_LINES = 2000
export const MAX_BYTES = 50 * 1024
const RETENTION_MS = 7 * 24 * 3600 * 1000

export const outputDir = () => path.join(paths.home, 'tool-output')

/**
 * Corta `text` nos limites. Mantém o começo (onde ficam cabeçalhos e o contexto) e, para saídas de
 * comando, também o fim (onde ficam erros e o código de saída).
 */
export function limitOutput(text, { maxLines = MAX_LINES, maxBytes = MAX_BYTES, keepTail = false, save = true } = {}) {
  text = String(text ?? '')
  const lines = text.split('\n')
  const bytes = Buffer.byteLength(text, 'utf8')
  if (lines.length <= maxLines && bytes <= maxBytes) return { text, truncated: false }
  let file = null
  if (save) {
    try {
      fs.mkdirSync(outputDir(), { recursive: true, mode: 0o700 })
      file = path.join(outputDir(), `tool_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}.txt`)
      fs.writeFileSync(file, text, { mode: 0o600 })
    } catch { file = null }
  }
  const take = (list, budgetLines, budgetBytes) => {
    const kept = []
    let used = 0
    for (const line of list) {
      const size = Buffer.byteLength(line, 'utf8') + 1
      if (kept.length >= budgetLines || used + size > budgetBytes) break
      kept.push(line)
      used += size
    }
    return kept
  }
  let head, tail = []
  if (keepTail) {
    head = take(lines, Math.floor(maxLines / 2), Math.floor(maxBytes * 0.4))
    tail = take([...lines].reverse(), Math.floor(maxLines / 2), Math.floor(maxBytes * 0.6) - 64).reverse()
    if (head.length + tail.length >= lines.length) tail = lines.slice(head.length)
  } else head = take(lines, maxLines, maxBytes)
  // uma única linha gigante (JSON minificado) ainda precisa mostrar alguma coisa
  if (!head.length && !tail.length) head = [Buffer.from(lines[0], 'utf8').subarray(0, maxBytes).toString('utf8')]
  const omitted = lines.length - head.length - tail.length
  const where = file ? `saída completa salva em ${file} — use read com offset/limit ou grep nesse arquivo` : 'saída completa não pôde ser salva'
  const marker = `\n… [${omitted} linha${omitted === 1 ? '' : 's'} omitida${omitted === 1 ? '' : 's'} de ${lines.length}; ${where}] …\n`
  return { text: head.join('\n') + marker + tail.join('\n'), truncated: true, file, totalLines: lines.length }
}

/** Remove saídas antigas (chamado uma vez ao iniciar). */
export function cleanupOutputs(now = Date.now()) {
  try {
    for (const name of fs.readdirSync(outputDir())) {
      if (!name.startsWith('tool_')) continue
      const file = path.join(outputDir(), name)
      try { if (now - fs.statSync(file).mtimeMs > RETENTION_MS) fs.rmSync(file, { force: true }) } catch {}
    }
  } catch {}
}
