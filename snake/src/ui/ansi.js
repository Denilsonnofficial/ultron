// Utilitários para texto com sequências ANSI: largura visível, quebra de linha e truncamento.

const ANSI_RE = /\x1b\[[0-9;?:]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
const TOKEN_RE = /(\x1b\[[0-9;?:]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_])|(\s+)|([^\s\x1b]+)/g

export function stripAnsi(s) {
  return String(s).replace(ANSI_RE, '')
}

function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x231a && cp <= 0x231b) ||
    (cp >= 0x23e9 && cp <= 0x23ec) ||
    cp === 0x23f0 ||
    cp === 0x23f3 ||
    (cp >= 0x25fd && cp <= 0x25fe) ||
    (cp >= 0x2614 && cp <= 0x2615) ||
    (cp >= 0x2648 && cp <= 0x2653) ||
    cp === 0x267f ||
    cp === 0x2693 ||
    cp === 0x26a1 ||
    (cp >= 0x26aa && cp <= 0x26ab) ||
    (cp >= 0x26bd && cp <= 0x26be) ||
    (cp >= 0x26c4 && cp <= 0x26c5) ||
    cp === 0x26ce ||
    cp === 0x26d4 ||
    cp === 0x26ea ||
    (cp >= 0x26f2 && cp <= 0x26f3) ||
    cp === 0x26f5 ||
    cp === 0x26fa ||
    cp === 0x26fd ||
    cp === 0x2705 ||
    (cp >= 0x270a && cp <= 0x270b) ||
    cp === 0x2728 ||
    cp === 0x274c ||
    cp === 0x274e ||
    (cp >= 0x2753 && cp <= 0x2755) ||
    cp === 0x2757 ||
    (cp >= 0x2795 && cp <= 0x2797) ||
    cp === 0x27b0 ||
    cp === 0x27bf ||
    (cp >= 0x2b1b && cp <= 0x2b1c) ||
    cp === 0x2b50 ||
    cp === 0x2b55 ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    cp === 0x1f004 ||
    cp === 0x1f0cf ||
    cp === 0x1f18e ||
    (cp >= 0x1f191 && cp <= 0x1f19a) ||
    (cp >= 0x1f200 && cp <= 0x1f251) ||
    (cp >= 0x1f300 && cp <= 0x1f320) ||
    (cp >= 0x1f32d && cp <= 0x1f335) ||
    (cp >= 0x1f337 && cp <= 0x1f37c) ||
    (cp >= 0x1f37e && cp <= 0x1f393) ||
    (cp >= 0x1f3a0 && cp <= 0x1f3ca) ||
    (cp >= 0x1f3cf && cp <= 0x1f3d3) ||
    (cp >= 0x1f3e0 && cp <= 0x1f3f0) ||
    cp === 0x1f3f4 ||
    (cp >= 0x1f3f8 && cp <= 0x1f43e) ||
    cp === 0x1f440 ||
    (cp >= 0x1f442 && cp <= 0x1f4fc) ||
    (cp >= 0x1f4ff && cp <= 0x1f53d) ||
    (cp >= 0x1f54b && cp <= 0x1f54e) ||
    (cp >= 0x1f550 && cp <= 0x1f567) ||
    cp === 0x1f57a ||
    (cp >= 0x1f595 && cp <= 0x1f596) ||
    cp === 0x1f5a4 ||
    (cp >= 0x1f5fb && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6c5) ||
    cp === 0x1f6cc ||
    (cp >= 0x1f6d0 && cp <= 0x1f6d2) ||
    (cp >= 0x1f6d5 && cp <= 0x1f6d7) ||
    (cp >= 0x1f6dc && cp <= 0x1f6df) ||
    (cp >= 0x1f6eb && cp <= 0x1f6ec) ||
    (cp >= 0x1f6f4 && cp <= 0x1f6fc) ||
    (cp >= 0x1f7e0 && cp <= 0x1f7eb) ||
    cp === 0x1f7f0 ||
    (cp >= 0x1f90c && cp <= 0x1f93a) ||
    (cp >= 0x1f93c && cp <= 0x1f945) ||
    (cp >= 0x1f947 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
}

/** Largura (em colunas do terminal) de um code point. */
export function charWidth(cp) {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0
  if (
    (cp >= 0x300 && cp <= 0x36f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    cp === 0x2060 ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  )
    return 0
  return isWide(cp) ? 2 : 1
}

/** Largura visível de um texto simples (sem ANSI). */
export function plainWidth(s) {
  let w = 0
  for (const ch of s) w += charWidth(ch.codePointAt(0))
  return w
}

/** Largura visível de um texto com ANSI. */
export function strWidth(s) {
  return plainWidth(stripAnsi(s))
}

export function padEnd(s, width) {
  const w = strWidth(s)
  return w >= width ? s : s + ' '.repeat(width - w)
}

export function padStart(s, width) {
  const w = strWidth(s)
  return w >= width ? s : ' '.repeat(width - w) + s
}

export function center(s, width) {
  const w = strWidth(s)
  if (w >= width) return s
  const left = Math.floor((width - w) / 2)
  return ' '.repeat(left) + s + ' '.repeat(width - w - left)
}

function isReset(code) {
  return code === '\x1b[0m' || code === '\x1b[m'
}

/** Trunca um texto com ANSI para caber em `width` colunas. */
export function truncate(s, width, ellipsis = '…') {
  s = String(s)
  if (strWidth(s) <= width) return s
  if (width <= 0) return ''
  const ellW = plainWidth(ellipsis)
  const target = Math.max(0, width - ellW)
  let out = ''
  let w = 0
  let styled = false
  TOKEN_RE.lastIndex = 0
  let m
  outer: while ((m = TOKEN_RE.exec(s))) {
    if (m[1]) {
      out += m[1]
      styled = !isReset(m[1])
      continue
    }
    for (const ch of m[0]) {
      const cw = charWidth(ch.codePointAt(0))
      if (w + cw > target) break outer
      out += ch
      w += cw
    }
  }
  return out + ellipsis + (styled ? '\x1b[0m' : '')
}

/** Trunca texto simples pelo começo (bom para caminhos): "…/pasta/arquivo". */
export function truncateStart(s, width, ellipsis = '…') {
  s = String(s)
  if (plainWidth(s) <= width) return s
  const chars = [...s]
  let w = plainWidth(ellipsis)
  let i = chars.length
  while (i > 0 && w + charWidth(chars[i - 1].codePointAt(0)) <= width) w += charWidth(chars[--i].codePointAt(0))
  return ellipsis + chars.slice(i).join('')
}

/**
 * Quebra uma linha (sem \n) com ANSI em várias linhas de no máximo `width` colunas.
 * Mantém o estilo ativo ao continuar na linha seguinte.
 */
export function wrapLine(line, width, { hard = true } = {}) {
  if (width <= 0) return [line]
  if (strWidth(line) <= width) return [line]
  const lines = []
  let cur = ''
  let curW = 0
  let active = ''
  const pushLine = () => {
    lines.push(cur.replace(/\s+$/, '') + (active ? '\x1b[0m' : ''))
    cur = active
    curW = 0
  }
  TOKEN_RE.lastIndex = 0
  let m
  while ((m = TOKEN_RE.exec(line))) {
    const [, esc, space, word] = m
    if (esc) {
      cur += esc
      if (isReset(esc)) active = ''
      else if (esc.endsWith('m')) active += esc
      continue
    }
    if (space) {
      const sw = plainWidth(space.replace(/\t/g, '    '))
      if (curW + sw <= width) {
        cur += space.replace(/\t/g, '    ')
        curW += sw
      } else if (curW > 0) {
        pushLine()
      }
      continue
    }
    const ww = plainWidth(word)
    if (curW + ww <= width) {
      cur += word
      curW += ww
      continue
    }
    if (ww <= width && curW > 0) {
      pushLine()
      cur += word
      curW += ww
      continue
    }
    if (!hard && curW === 0) {
      cur += word
      curW += ww
      continue
    }
    if (curW > 0) pushLine()
    for (const ch of word) {
      const cw = charWidth(ch.codePointAt(0))
      if (curW + cw > width && curW > 0) pushLine()
      cur += ch
      curW += cw
    }
  }
  if (stripAnsi(cur).length || !lines.length) lines.push(cur.replace(/\s+$/, '') + (active ? '\x1b[0m' : ''))
  return lines
}

/** Quebra texto (com possíveis \n) respeitando a largura. */
export function wrapText(text, width, opts) {
  return String(text)
    .split('\n')
    .flatMap((l) => wrapLine(l, width, opts))
}

/** Quebra com recuo: a primeira linha recebe `first`, as demais `rest`. */
export function wrapIndent(text, width, first = '', rest = first) {
  const avail = Math.max(10, width - Math.max(strWidth(first), strWidth(rest)))
  const out = []
  for (const l of String(text).split('\n')) {
    for (const w of wrapLine(l, avail)) out.push((out.length ? rest : first) + w)
  }
  return out
}

/** Quebra texto simples (sem ANSI) por caracteres, devolvendo trechos e offsets. Usado no editor. */
export function wrapPlainChars(text, width) {
  const rows = []
  let w = 0
  let offset = 0
  let rowStart = 0
  let row = ''
  for (const ch of text) {
    const cw = charWidth(ch.codePointAt(0))
    if (w + cw > width && w > 0) {
      rows.push({ text: row, start: rowStart, end: offset })
      row = ''
      w = 0
      rowStart = offset
    }
    row += ch
    w += cw
    offset += ch.length
  }
  rows.push({ text: row, start: rowStart, end: offset })
  return rows
}
