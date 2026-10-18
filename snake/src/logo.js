// Mascote do Snake: uma cobrinha em pixel art desenhada com meios-blocos (2 pixels por célula).
// A versão vetorial (assets/*.svg) segue a mesma pose e é gerada por scripts/gerar-logo.mjs.

import { bgCode, colorLevel, fgCode, palette, t } from './theme.js'
import { padEnd, truncate } from './ui/ansi.js'

export const SPRITE_COLORS = {
  G: palette.primary, // corpo
  g: palette.scale, // pintas do dorso
  B: palette.mint, // barriga
  W: palette.eye, // olho
  K: palette.pupil, // pupila
  R: palette.tongue, // língua bifurcada
}

// 23 x 12 pixels → 23 colunas x 6 linhas no terminal.
export const SPRITE = [
  '............GGGGG......',
  '..........GGGGGGGGG....',
  '.........GGWWGGGGGGG...',
  '.........GGWKGGGGGGGG.R',
  '.........GGGGGGGGGGGRR.',
  '..........BBBBBBBBB...R',
  '............GGGB.......',
  '..gGGg......GGGB.......',
  '.GGgGgG....GGgB........',
  'GGBBBBGG..GGGB.........',
  'GB....BGGGGGB..........',
  'B......BBBBB...........',
]

export const SPRITE_WIDTH = SPRITE[0].length

// Versão compacta (13 x 6 pixels → 3 linhas) para o cabeçalho da interface.
export const MINI_SPRITE = [
  '....GGGGG....',
  '...GWKGGGG..R',
  '...GGGGGGGRR.',
  '....BBBGG...R',
  '.gG....GGB...',
  'GBBGGGGGB....',
]
export const MINI_WIDTH = MINI_SPRITE[0].length

/** Cabeçalho fino: mascote de 3 linhas com até 3 linhas de texto ao lado (em telas muito estreitas, embaixo). */
export function headerLines(info, cols) {
  const sprite = spriteLines(MINI_SPRITE)
  const room = cols - MINI_WIDTH - 5
  if (room < 16) return [...sprite.map((l) => ' ' + l), ...info.map((l) => ' ' + truncate(l, cols - 2))]
  return Array.from({ length: Math.max(sprite.length, info.length) }, (_, i) => ' ' + padEnd(sprite[i] ?? '', MINI_WIDTH) + '   ' + (info[i] ? truncate(info[i], room) : ''))
}

/** Converte o sprite em linhas de terminal (cada célula = pixel de cima + pixel de baixo). */
export function spriteLines(sprite = SPRITE) {
  const level = colorLevel()
  const lines = []
  for (let y = 0; y < sprite.length; y += 2) {
    let line = ''
    for (let x = 0; x < sprite[y].length; x++) {
      let top = sprite[y][x]
      let bot = sprite[y + 1]?.[x] ?? '.'
      if (!level) {
        // Sem cores, o olho vira um "furo" para a silhueta continuar legível.
        if (top === 'W' || top === 'K') top = '.'
        if (bot === 'W' || bot === 'K') bot = '.'
      }
      const a = SPRITE_COLORS[top]
      const b = SPRITE_COLORS[bot]
      if (!a && !b) line += ' '
      else if (!level) line += a && b ? '█' : a ? '▀' : '▄'
      else if (a && b) line += a === b ? fgCode(a) + '█\x1b[39m' : fgCode(a) + bgCode(b) + '▀\x1b[39;49m'
      else line += fgCode(a || b) + (a ? '▀' : '▄') + '\x1b[39m'
    }
    lines.push(line.replace(/ +$/, ''))
  }
  return lines
}

/**
 * Mascote com linhas de texto à direita, centralizadas na altura do desenho.
 * Em telas estreitas o texto vai para baixo. Nenhuma linha passa de `cols - 2`.
 */
export function besideLogo(info, cols) {
  const sprite = spriteLines()
  const room = cols - SPRITE_WIDTH - 6
  if (room < 18) return [...sprite.map((l) => ' ' + l), '', ...info.map((l) => ' ' + truncate(l, cols - 3))]
  const top = Math.max(0, Math.floor((sprite.length - info.length) / 2))
  return Array.from({ length: Math.max(sprite.length, info.length) }, (_, i) => {
    const art = sprite[i] ?? ''
    const text = info[i - top]
    return ' ' + (text ? padEnd(art, SPRITE_WIDTH) + '   ' + truncate(text, room) : art)
  })
}

/** Mascote + letreiro (usado em `snake logo` e /logo). */
export function bigLogo({ tagline = '', cols = process.stdout.columns || 80 } = {}) {
  return besideLogo([t.bold(t.primary('snake')), tagline].filter(Boolean), cols)
}
