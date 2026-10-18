// Motor de renderização: conteúdo permanente rola normalmente (fica no histórico do terminal)
// e um "rodapé" dinâmico (prévia do streaming, caixa de entrada, barra de status) é redesenhado
// sempre abaixo dele.

import { plainWidth, stripAnsi, strWidth, truncate, wrapText } from './ansi.js'

const SYNC_START = '\x1b[?2026h'
const SYNC_END = '\x1b[?2026l'
const HIDE = '\x1b[?25l'
const SHOW = '\x1b[?25h'

export class Terminal {
  constructor(out = process.stdout) {
    this.out = out
    this.height = 0 // linhas do rodapé desenhado
    this.cursorRow = 0 // linha (dentro do rodapé) onde o cursor ficou
    this.cursorCol = 0
    this.lineWidths = []
    this.footer = () => ({ lines: [], cursor: null })
    this.enabled = true
    this.timer = null
    this.lastCols = this.cols
  }

  get cols() {
    return this.out.columns || 80
  }

  get rows() {
    return this.out.rows || 24
  }

  setFooter(fn) {
    this.footer = fn
  }

  eraseSeq() {
    if (!this.height) return '\r'
    let up = this.cursorRow
    // Se a largura mudou, o terminal pode ter reorganizado as linhas antigas.
    if (this.cols !== this.lastCols && this.cols < this.lastCols) {
      up = 0
      for (let i = 0; i < this.cursorRow; i++) up += Math.max(1, Math.ceil((this.lineWidths[i] || 0) / this.cols))
      up += Math.floor(this.cursorCol / this.cols)
    }
    return (up > 0 ? `\x1b[${up}A` : '') + '\r\x1b[J'
  }

  drawSeq() {
    let lines = []
    let cursor = null
    try {
      const r = this.footer(this.cols, this.rows) || {}
      lines = r.lines || []
      cursor = r.cursor || null
    } catch (err) {
      lines = [`[erro ao desenhar: ${err.message}]`]
    }
    const maxH = Math.max(3, this.rows - 1)
    let cut = 0
    if (lines.length > maxH) {
      cut = lines.length - maxH
      lines = lines.slice(cut)
    }
    const limit = this.cols - 1
    lines = lines.map((l) => (strWidth(l) > limit ? truncate(l, limit) : l))
    this.lineWidths = lines.map((l) => strWidth(l))
    this.lastCols = this.cols
    this.height = lines.length
    let seq = lines.join('\r\n') + '\x1b[0m'
    let row = Math.max(0, lines.length - 1)
    let col = this.lineWidths[row] || 0
    if (cursor && cursor.row - cut >= 0 && cursor.row - cut < lines.length) {
      const target = cursor.row - cut
      if (row - target > 0) seq += `\x1b[${row - target}A`
      const targetCol = Math.max(0, Math.min(cursor.col, limit - 1))
      seq += '\r' + (targetCol > 0 ? `\x1b[${targetCol}C` : '') + SHOW
      row = target
      col = targetCol
    } else {
      seq += HIDE
    }
    this.cursorRow = row
    this.cursorCol = col
    return seq
  }

  /** Redesenha o rodapé. */
  render() {
    if (!this.enabled) return
    clearTimeout(this.timer)
    this.timer = null
    this.out.write(SYNC_START + HIDE + this.eraseSeq() + this.drawSeq() + SYNC_END)
  }

  /** Agenda um redesenho (agrupa várias atualizações em ~30 fps). */
  schedule(ms = 33) {
    if (!this.enabled || this.timer) return
    this.timer = setTimeout(() => this.render(), ms)
  }

  /** Escreve conteúdo permanente acima do rodapé. */
  log(text = '') {
    const body = wrapText(String(text).replace(/\r\n/g, '\n'), Math.max(1, this.cols - 1)).join('\r\n') + '\r\n'
    if (!this.enabled) {
      this.out.write(body)
      return
    }
    clearTimeout(this.timer)
    this.timer = null
    this.out.write(SYNC_START + HIDE + this.eraseSeq() + body + this.drawSeq() + SYNC_END)
  }

  /** Apaga o rodapé (antes de sair ou suspender). */
  clearFooter() {
    if (!this.height) return
    this.out.write(this.eraseSeq() + SHOW)
    this.height = 0
    this.cursorRow = 0
  }

  clearScreen() {
    this.out.write('\x1b[2J\x1b[3J\x1b[H')
    this.height = 0
    this.cursorRow = 0
    this.render()
  }
}

export { plainWidth, stripAnsi }
