// Lista selecionável com filtro (usada para modelos, sessões, permissões e confirmações).

import { t } from '../theme.js'
import { padEnd, strWidth, truncate, wrapText } from './ansi.js'

export class Picker {
  /**
   * items: [{ label, detail?, value, group?, hint?, tone?: 'free', disabled? }]
   */
  constructor({ title, items, onSelect, onCancel, filterable = true, initial = 0, footer, header = [], maxVisible = 12, emptyText = 'nada encontrado', placeholder = 'digite para filtrar', color = t.border }) {
    this.title = title
    this.items = items
    this.onSelect = onSelect
    this.onCancel = onCancel
    this.filterable = filterable
    this.filter = ''
    this.index = Math.max(0, initial)
    this.footer = footer
    this.header = header
    this.maxVisible = maxVisible
    this.emptyText = emptyText
    this.placeholder = placeholder
    this.color = color
    this.scroll = 0
  }

  get filtered() {
    if (!this.filter.trim()) return this.items
    const words = this.filter.toLowerCase().split(/\s+/).filter(Boolean)
    return this.items.filter((it) => {
      const hay = `${it.label} ${it.detail || ''} ${it.group || ''} ${it.search || ''}`.toLowerCase()
      return words.every((w) => hay.includes(w))
    })
  }

  /** Trata uma tecla. Retorna true se consumiu. */
  key(str, key = {}) {
    const list = this.filtered
    const name = key.name
    if (name === 'escape' || (key.ctrl && name === 'c')) {
      this.onCancel?.()
      return true
    }
    if (name === 'return' || name === 'enter') {
      const item = list[this.index]
      if (item && !item.disabled) this.onSelect?.(item)
      return true
    }
    if (name === 'up' || (key.ctrl && name === 'p')) this.index = Math.max(0, this.index - 1)
    else if (name === 'down' || (key.ctrl && name === 'n') || name === 'tab') this.index = Math.min(list.length - 1, this.index + 1)
    else if (name === 'pageup') this.index = Math.max(0, this.index - this.maxVisible)
    else if (name === 'pagedown') this.index = Math.min(list.length - 1, this.index + this.maxVisible)
    else if (name === 'home') this.index = 0
    else if (name === 'end') this.index = list.length - 1
    else if (this.filterable && name === 'backspace') {
      this.filter = this.filter.slice(0, -1)
      this.index = 0
    } else if (!this.filterable && str && /^[1-9]$/.test(str) && Number(str) <= list.length) {
      this.index = Number(str) - 1
      this.onSelect?.(list[this.index])
    } else if (this.filterable && str && !key.ctrl && !key.meta && str >= ' ' && str.length === 1) {
      this.filter += str
      this.index = 0
    } else return false
    this.index = Math.max(0, Math.min(this.index, Math.max(0, this.filtered.length - 1)))
    return true
  }

  render(cols, maxRows = 20) {
    const c = this.color
    const w = Math.max(8, cols - 1)
    const inner = w - 4
    const list = this.filtered
    const twoLine = inner < 36
    const row = (s = '') => c('│ ') + padEnd(truncate(s, inner), inner) + c(' │')
    const border = (left, text, right) => {
      const title = truncate(' ' + text + ' ', w - 4)
      return c(left) + title + c('─'.repeat(Math.max(0, w - 3 - strWidth(title)))) + c(right)
    }
    const lines = [border('╭─', t.bold(t.primary(this.title)), '╮')]
    for (const h of this.header.slice(0, Math.max(0, maxRows - 9))) lines.push(row(h))
    if (this.filterable) lines.push(row(t.muted('Busca: ') + (this.filter ? t.text(this.filter) : t.subtle(this.placeholder)) + t.primary('▏')))
    this.index = Math.max(0, Math.min(this.index, list.length - 1))
    const selected = list[this.index]
    const hintLines = selected?.hint && maxRows >= 12 ? wrapText(selected.hint, inner).slice(0, 2) : []
    const budget = Math.max(1, maxRows - lines.length - 2 - hintLines.length)
    const itemRows = (it, i, lastGroup) => {
      const result = []
      if (it.group && it.group !== lastGroup) result.push(row(t.bold(t.muted(it.group))))
      const sel = i === this.index
      const color = it.disabled ? t.subtle : sel ? t.primary : t.text
      const pointer = sel ? t.primary('› ') : '  '
      const label = sel ? t.bold(color(it.label)) : color(it.label)
      const detail = it.detail ? (it.disabled ? t.warn : it.tone === 'free' ? t.accent : t.muted)(it.detail) : ''
      if (!detail) {
        // Sem detalhe (ex.: opções de permissão): quebra o texto em vez de cortar.
        wrapText(label, inner - 2).forEach((l, j) => result.push(row((j ? '  ' : pointer) + l)))
      } else if (twoLine) {
        result.push(row(pointer + label))
        result.push(row('  ' + detail))
      } else {
        const dw = Math.min(strWidth(detail), Math.floor(inner / 2))
        const lw = inner - 4 - dw
        result.push(row(pointer + padEnd(truncate(label, lw), lw) + '  ' + truncate(detail, dw)))
      }
      return result
    }
    // O orçamento conta linhas físicas (grupos e detalhes), não só itens.
    const page = (start) => {
      const body = []
      let lastGroup
      let end = start - 1
      for (let i = start; i < list.length && i < start + this.maxVisible; i++) {
        let rows = itemRows(list[i], i, lastGroup)
        if (rows.length > budget && i === start) {
          rows = rows.slice(list[i].group ? 1 : 0, budget + (list[i].group ? 1 : 0))
        }
        if (body.length + rows.length > budget) break
        body.push(...rows)
        lastGroup = list[i].group
        end = i
      }
      return { body, end }
    }
    this.scroll = Math.max(0, Math.min(this.scroll, this.index))
    let visible = page(this.scroll)
    while (visible.end < this.index && this.scroll < this.index) visible = page(++this.scroll)
    if (!list.length) lines.push(row(t.muted(this.emptyText)))
    else lines.push(...visible.body)
    lines.push(...hintLines.map((text) => row(t.subtle(text))))
    const count = list.length ? `${this.index + 1}/${list.length}` : '0'
    lines.push(row(t.subtle(cols < 50 ? `↑↓  enter  esc · ${count}` : `${this.footer || '↑↓ mover · enter escolher · esc sair'} · ${count}`)))
    lines.push(c('╰' + '─'.repeat(w - 2) + '╯'))
    return lines
  }

}

/** Entrada de texto modal (ex.: chave de API), opcionalmente mascarada. */
export class Prompt {
  constructor({ title, label, secret = false, onSubmit, onCancel, color = t.border }) {
    this.title = title
    this.label = label
    this.secret = secret
    this.value = ''
    this.onSubmit = onSubmit
    this.onCancel = onCancel
    this.color = color
  }

  key(str, key = {}) {
    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) this.onCancel?.()
    else if (key.name === 'return' || key.name === 'enter') this.onSubmit?.(this.value.trim())
    else if (key.name === 'backspace') this.value = this.value.slice(0, -1)
    else if (key.ctrl && key.name === 'u') this.value = ''
    else if (str && !key.ctrl && !key.meta) this.value += str.replace(/[\r\n]/g, '')
    else return false
    return true
  }

  paste(text) {
    this.value += text.replace(/[\r\n]/g, '').trim()
  }

  render(cols) {
    const c = this.color
    const w = cols - 1
    const inner = w - 4
    const label = truncate(this.label, Math.max(1, inner - 8))
    const available = Math.max(1, inner - strWidth(label) - 2)
    const shown = this.secret ? '•'.repeat(Math.min(this.value.length, available)) : truncate(this.value, available)
    const border = (left, content, right) => {
      const text = truncate(' ' + content + ' ', w - 4)
      return c(left) + text + c('─'.repeat(Math.max(0, w - 3 - strWidth(text)))) + c(right)
    }
    return {
      lines: [
        border('╭─', t.bold(t.primary(this.title)), '╮'),
        c('│ ') + padEnd(t.muted(label) + ' ' + t.text(shown), inner) + c(' │'),
        border('╰─', t.muted('enter confirmar · esc cancelar'), '╯'),
      ],
      cursor: { row: 1, col: Math.min(w - 3, 3 + strWidth(label) + strWidth(shown)) },
    }
  }
}
