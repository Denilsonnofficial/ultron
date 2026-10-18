// Paleta verde do Snake e helpers de cor ANSI (truecolor com fallback para 256 cores).

const env = process.env

export const palette = {
  primary: '#4ade80', // verde serpente
  scale: '#22c55e', // verde escama
  accent: '#a3e635', // lima (veneno)
  emerald: '#34d399',
  jade: '#10b981',
  mint: '#bbf7d0',
  text: '#dcfce7',
  muted: '#7fa58b',
  subtle: '#81988a',
  border: '#2f8a55',
  borderDim: '#25523a',
  dark: '#166534',
  forest: '#14532d',
  deep: '#052e16',
  eye: '#f0fdf4',
  pupil: '#0a0f0c',
  tongue: '#fb7185',
  error: '#f87171',
  warn: '#facc15',
  info: '#5eead4',
  added: '#4ade80',
  addedBg: '#0d3320',
  removed: '#f87171',
  removedBg: '#3d1717',
}

const green = { ...palette }
export const themes = {
  serpente: green,
  escuro: { ...green, text: '#e2e8f0', muted: '#94a3b8', subtle: '#94a3b8', border: '#475569', deep: '#0f172a' },
  claro: { ...green, primary: '#166534', accent: '#3f6212', text: '#17251d', muted: '#476652', subtle: '#476652', border: '#15803d', deep: '#f0fdf4', warn: '#92400e', error: '#b91c1c', info: '#0f766e' },
  monocromo: Object.fromEntries(Object.keys(green).map((k) => [k, /Bg|deep|pupil|forest/.test(k) ? '#111111' : '#cccccc'])),
  daltonismo: { ...green, primary: '#56b4e9', accent: '#f0e442', scale: '#0072b2', added: '#56b4e9', removed: '#e69f00', error: '#e69f00', tongue: '#cc79a7' },
}

export function setTheme(name = 'serpente') {
  if (!themes[name]) throw new Error(`Tema desconhecido: ${name}. Use ${Object.keys(themes).join(', ')}`)
  Object.assign(palette, themes[name])
  cache.clear()
  for (const key of Object.keys(palette)) if (key in t) t[key] = (s) => fg(palette[key])(s)
}

export function detectColorLevel(stream = process.stdout) {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 0
  const force = env.FORCE_COLOR
  if (force !== undefined) {
    if (force === '0' || force === 'false') return 0
    if (force === '3' || force === 'truecolor') return 3
    if (force === '2') return 2
    return Math.max(1, Number(force) || 1)
  }
  if (!stream || !stream.isTTY) return 0
  if (env.TERM === 'dumb') return 0
  const colorterm = (env.COLORTERM || '').toLowerCase()
  if (colorterm === 'truecolor' || colorterm === '24bit') return 3
  if (['iTerm.app', 'vscode', 'WezTerm', 'Hyper', 'ghostty', 'Tabby', 'rio'].includes(env.TERM_PROGRAM)) return 3
  if (env.WT_SESSION) return 3
  if (/kitty|alacritty|foot|wezterm|ghostty|direct/.test(env.TERM || '')) return 3
  return 2
}

let level = detectColorLevel()

export function setColorLevel(value) {
  level = value
  cache.clear()
}

export function colorLevel() {
  return level
}

const cache = new Map()

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function rgbTo256([r, g, b]) {
  if (r === g && g === b) {
    if (r < 8) return 16
    if (r > 248) return 231
    return Math.round(((r - 8) / 247) * 24) + 232
  }
  const q = (v) => (v < 48 ? 0 : v < 115 ? 1 : Math.floor((v - 35) / 40))
  return 16 + 36 * q(r) + 6 * q(g) + q(b)
}

function rgbTo16([r, g, b]) {
  const bright = Math.max(r, g, b) > 170
  const code = (b > 127 ? 4 : 0) | (g > 127 ? 2 : 0) | (r > 127 ? 1 : 0)
  return (bright ? 90 : 30) + (code || (bright ? 7 : 0))
}

export function fgCode(hex) {
  if (!level) return ''
  const key = 'f' + hex
  let code = cache.get(key)
  if (code === undefined) {
    const rgb = hexToRgb(hex)
    code = level >= 3 ? `\x1b[38;2;${rgb.join(';')}m` : level === 2 ? `\x1b[38;5;${rgbTo256(rgb)}m` : `\x1b[${rgbTo16(rgb)}m`
    cache.set(key, code)
  }
  return code
}

export function bgCode(hex) {
  if (!level) return ''
  const key = 'b' + hex
  let code = cache.get(key)
  if (code === undefined) {
    const rgb = hexToRgb(hex)
    code = level >= 3 ? `\x1b[48;2;${rgb.join(';')}m` : level === 2 ? `\x1b[48;5;${rgbTo256(rgb)}m` : `\x1b[${rgbTo16(rgb) + 10}m`
    cache.set(key, code)
  }
  return code
}

export const fg = (hex) => (s) => (level ? fgCode(hex) + s + '\x1b[39m' : String(s))
export const bg = (hex) => (s) => (level ? bgCode(hex) + s + '\x1b[49m' : String(s))
const sgr = (open, close) => (s) => (level ? `\x1b[${open}m${s}\x1b[${close}m` : String(s))

export const bold = sgr(1, 22)
export const dim = sgr(2, 22)
export const italic = sgr(3, 23)
export const underline = sgr(4, 24)
export const inverse = sgr(7, 27)
export const strike = sgr(9, 29)

/** Interpola entre duas cores hex (t de 0 a 1). */
export function mix(a, b, t) {
  const x = hexToRgb(a)
  const y = hexToRgb(b)
  const c = x.map((v, i) => Math.round(v + (y[i] - v) * t))
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('')
}

/** Aplica um degradê horizontal (lista de cores) caractere a caractere. */
export function gradient(text, colors) {
  if (!level) return text
  if (colors.length < 2) return fg(colors[0])(text)
  const chars = [...text]
  const n = Math.max(1, chars.length - 1)
  return (
    chars
      .map((ch, i) => {
        if (ch === ' ') return ch
        const pos = (i / n) * (colors.length - 1)
        const idx = Math.min(colors.length - 2, Math.floor(pos))
        return fgCode(mix(colors[idx], colors[idx + 1] ?? colors[idx], pos - idx)) + ch
      })
      .join('') + '\x1b[39m'
  )
}

/** Atalhos semânticos do tema. */
export const t = {
  primary: fg(palette.primary),
  scale: fg(palette.scale),
  accent: fg(palette.accent),
  emerald: fg(palette.emerald),
  mint: fg(palette.mint),
  text: fg(palette.text),
  muted: fg(palette.muted),
  subtle: fg(palette.subtle),
  border: fg(palette.border),
  borderDim: fg(palette.borderDim),
  dark: fg(palette.dark),
  error: fg(palette.error),
  warn: fg(palette.warn),
  info: fg(palette.info),
  tongue: fg(palette.tongue),
  added: fg(palette.added),
  removed: fg(palette.removed),
  bold,
  dim,
  italic,
  underline,
  inverse,
  strike,
}
