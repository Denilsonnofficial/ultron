// Editor de linha com múltiplas linhas, histórico, movimentação por palavra e colagens grandes.

import fs from 'node:fs'
import { paths } from '../config.js'
import { plainWidth, wrapPlainChars } from './ansi.js'

const PASTE_RE = /\[Colado #(\d+) · \+\d+ linhas\]/g

export function loadHistory(limit = 500) {
  try {
    return fs
      .readFileSync(paths.history, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l).text
        } catch {
          return null
        }
      })
      .filter((s) => typeof s === 'string')
      .slice(-limit)
  } catch {
    return []
  }
}

export function appendHistory(text) {
  try {
    fs.appendFileSync(paths.history, JSON.stringify({ text, at: Date.now() }) + '\n')
  } catch {}
}

function prevCharIndex(s, i) {
  if (i <= 0) return 0
  const c = s.charCodeAt(i - 1)
  return c >= 0xdc00 && c <= 0xdfff && i >= 2 ? i - 2 : i - 1
}

function nextCharIndex(s, i) {
  if (i >= s.length) return s.length
  const c = s.charCodeAt(i)
  return c >= 0xd800 && c <= 0xdbff ? i + 2 : i + 1
}

export class LineEditor {
  constructor({ history = [] } = {}) {
    this.text = ''
    this.cursor = 0
    this.history = history
    this.histIndex = -1
    this.draft = ''
    this.pastes = new Map()
    this.pasteCount = 0
    this.preferredCol = null
  }

  get empty() {
    return this.text.length === 0
  }

  setText(text, cursor = text.length) {
    this.text = text
    this.cursor = Math.max(0, Math.min(cursor, text.length))
    this.preferredCol = null
  }

  clear() {
    this.setText('')
    this.pastes.clear()
    this.histIndex = -1
  }

  insert(s) {
    if (!s) return
    this.text = this.text.slice(0, this.cursor) + s + this.text.slice(this.cursor)
    this.cursor += s.length
    this.preferredCol = null
  }

  /** Colagem: textos grandes viram um marcador compacto expandido no envio. */
  paste(raw) {
    const s = raw.replace(/\r\n?/g, '\n')
    const lines = s.split('\n').length
    if (s.length > 800 || lines > 12) {
      const n = ++this.pasteCount
      this.pastes.set(n, s)
      this.insert(`[Colado #${n} · +${lines} linhas]`)
    } else this.insert(s)
  }

  backspace() {
    if (!this.cursor) return
    const before = this.text.slice(0, this.cursor)
    const m = /\[Colado #\d+ · \+\d+ linhas\]$/.exec(before)
    const start = m ? this.cursor - m[0].length : prevCharIndex(this.text, this.cursor)
    this.text = this.text.slice(0, start) + this.text.slice(this.cursor)
    this.cursor = start
    this.preferredCol = null
  }

  del() {
    if (this.cursor >= this.text.length) return
    const end = nextCharIndex(this.text, this.cursor)
    this.text = this.text.slice(0, this.cursor) + this.text.slice(end)
  }

  left() {
    this.cursor = prevCharIndex(this.text, this.cursor)
    this.preferredCol = null
  }

  right() {
    this.cursor = nextCharIndex(this.text, this.cursor)
    this.preferredCol = null
  }

  lineStart() {
    return this.text.lastIndexOf('\n', this.cursor - 1) + 1
  }

  lineEnd() {
    const i = this.text.indexOf('\n', this.cursor)
    return i === -1 ? this.text.length : i
  }

  home() {
    this.cursor = this.lineStart()
    this.preferredCol = null
  }

  end() {
    this.cursor = this.lineEnd()
    this.preferredCol = null
  }

  wordLeft() {
    let i = this.cursor
    while (i > 0 && /\s/.test(this.text[i - 1])) i--
    while (i > 0 && !/\s/.test(this.text[i - 1])) i--
    this.cursor = i
  }

  wordRight() {
    let i = this.cursor
    while (i < this.text.length && /\s/.test(this.text[i])) i++
    while (i < this.text.length && !/\s/.test(this.text[i])) i++
    this.cursor = i
  }

  deleteWordBack() {
    const end = this.cursor
    this.wordLeft()
    this.text = this.text.slice(0, this.cursor) + this.text.slice(end)
  }

  killToStart() {
    const start = this.lineStart()
    const from = start === this.cursor && start > 0 ? start - 1 : start
    this.text = this.text.slice(0, from) + this.text.slice(this.cursor)
    this.cursor = from
  }

  killToEnd() {
    const end = this.lineEnd()
    const to = end === this.cursor && end < this.text.length ? end + 1 : end
    this.text = this.text.slice(0, this.cursor) + this.text.slice(to)
  }

  /** Move uma linha visual para cima/baixo; devolve false se já estiver na borda. */
  moveVertical(dir, width) {
    const lay = this.layout(width)
    const target = lay.cursorRow + dir
    if (target < 0 || target >= lay.rows.length) return false
    const col = this.preferredCol ?? lay.cursorCol
    const row = lay.rows[target]
    let idx = row.start
    let w = 0
    for (const ch of row.text) {
      const cw = plainWidth(ch)
      if (w + cw > col) break
      w += cw
      idx += ch.length
    }
    this.cursor = idx
    this.preferredCol = col
    return true
  }

  historyPrev() {
    if (!this.history.length) return false
    if (this.histIndex === -1) {
      this.draft = this.text
      this.histIndex = this.history.length
    }
    if (this.histIndex <= 0) return false
    this.histIndex--
    this.setText(this.history[this.histIndex])
    return true
  }

  historyNext() {
    if (this.histIndex === -1) return false
    this.histIndex++
    if (this.histIndex >= this.history.length) {
      this.histIndex = -1
      this.setText(this.draft)
    } else this.setText(this.history[this.histIndex])
    return true
  }

  /** Texto final (com colagens expandidas); registra no histórico e limpa. */
  submit() {
    const raw = this.text
    const expanded = raw.replace(PASTE_RE, (m, n) => this.pastes.get(Number(n)) ?? m)
    if (raw.trim() && this.history[this.history.length - 1] !== raw) {
      this.history.push(raw)
      if (!raw.includes('[Colado #')) appendHistory(raw)
    }
    this.clear()
    return expanded
  }

  /** Disposição visual do texto quebrado em `width` colunas, com a posição do cursor. */
  layout(width) {
    const rows = []
    let offset = 0
    let cursorRow = 0
    let cursorCol = 0
    const logical = this.text.split('\n')
    logical.forEach((line, li) => {
      const wrapped = wrapPlainChars(line, Math.max(1, width))
      wrapped.forEach((r, ri) => {
        const start = offset + r.start
        const end = offset + r.end
        const isLastOfLine = ri === wrapped.length - 1
        if (this.cursor >= start && (this.cursor < end || (isLastOfLine && this.cursor === end))) {
          cursorRow = rows.length
          cursorCol = plainWidth(this.text.slice(start, this.cursor))
        }
        rows.push({ text: r.text, start, end })
      })
      offset += line.length + (li < logical.length - 1 ? 1 : 0)
    })
    return { rows, cursorRow, cursorCol }
  }

  /** Palavra (token) sob o cursor — usada no autocompletar de @arquivos. */
  tokenAtCursor() {
    let s = this.cursor
    while (s > 0 && !/\s/.test(this.text[s - 1])) s--
    let e = this.cursor
    while (e < this.text.length && !/\s/.test(this.text[e])) e++
    return { start: s, end: e, text: this.text.slice(s, e) }
  }

  replaceRange(start, end, s) {
    this.text = this.text.slice(0, start) + s + this.text.slice(end)
    this.cursor = start + s.length
  }
}
