// Formatação de números, tokens, custos, tempos e barras.

export function fmtTokens(n) {
  n = Number(n) || 0
  if (n < 1000) return String(Math.round(n))
  if (n < 10_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  if (n < 1_000_000) return Math.round(n / 1000) + 'k'
  if (n < 10_000_000) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M'
  return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'
}

export function fmtInt(n) {
  return Math.round(Number(n) || 0).toLocaleString('pt-BR')
}

export function fmtCost(usd, { free = false, unknown = false, estimated = false } = {}) {
  if (unknown) return usd ? `≥${fmtCost(usd)}` : '$?'
  if (estimated) return `~${fmtCost(usd)}`
  if (free && !usd) return 'grátis'
  usd = Number(usd) || 0
  if (usd === 0) return '$0'
  if (usd < 0.0001) return '<$0.0001'
  if (usd < 1) return '$' + usd.toFixed(4)
  if (usd < 100) return '$' + usd.toFixed(2)
  return '$' + Math.round(usd)
}

export function fmtPrice(perMillion) {
  if (perMillion == null) return '?'
  if (perMillion === 0) return '0'
  if (perMillion < 0.1) return perMillion.toFixed(3).replace(/0+$/, '')
  if (perMillion < 10) return perMillion.toFixed(2).replace(/\.?0+$/, '')
  return perMillion.toFixed(1).replace(/\.0$/, '')
}

export function fmtDuration(ms) {
  ms = Math.max(0, Number(ms) || 0)
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`
  const m = Math.floor(s / 60)
  const r = Math.round(s % 60)
  if (m < 60) return `${m}m ${String(r).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export function fmtPercent(f, digits = 0) {
  return `${(Math.max(0, f) * 100).toFixed(digits)}%`
}

export function fmtAgo(ts) {
  const d = Date.now() - ts
  if (d < 60_000) return 'agora'
  if (d < 3600_000) return `${Math.floor(d / 60_000)} min atrás`
  if (d < 86400_000) return `${Math.floor(d / 3600_000)} h atrás`
  const days = Math.floor(d / 86400_000)
  return days === 1 ? 'ontem' : `${days} dias atrás`
}

/** Barra de progresso: ▰▰▰▱▱▱ */
export function bar(fraction, width = 10, full = '▰', empty = '▱') {
  const f = Math.max(0, Math.min(1, Number(fraction) || 0))
  const n = Math.round(f * width)
  return full.repeat(n) + empty.repeat(width - n)
}

export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`
}
