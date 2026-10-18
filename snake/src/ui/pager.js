import { truncate, wrapText } from './ansi.js'
import { t } from '../theme.js'
export class Pager {
  constructor(title, text, onClose) { this.title = title; this.text = text; this.onClose = onClose; this.offset = 0; this.page = 10; this.total = 0 }
  render(cols, rows) {
    const lines = wrapText(this.text, Math.max(1, cols - 1))
    this.page = Math.max(1, rows - 2); this.total = lines.length
    this.offset = Math.min(this.offset, Math.max(0, lines.length - this.page))
    return [t.primary(truncate(this.title, cols - 1)), ...lines.slice(this.offset, this.offset + this.page), t.subtle(truncate(`${this.offset + 1}/${lines.length} · ↑↓ PgUp/PgDn · esc sair`, cols - 1))]
  }
  key(str, key) {
    if (['escape', 'q'].includes(key.name)) { this.onClose(); return true }
    const delta = { down: 1, up: -1, pagedown: this.page, pageup: -this.page, end: this.total, home: -this.total }[key.name]
    if (delta != null) this.offset = Math.max(0, this.offset + delta)
    return true
  }
}
