// Contabilidade de tokens (entrada, saída, cache/KV), custo e tempos.

const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'cost', 'costIn', 'costOut', 'costCacheRead', 'costCacheWrite', 'apiMs', 'genMs', 'ttftMs']

export function emptyUsage() {
  return {
    requests: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    cost: 0,
    costIn: 0,
    costOut: 0,
    costCacheRead: 0,
    costCacheWrite: 0,
    apiMs: 0,
    genMs: 0,
    ttftMs: 0,
    estimated: false,
    costUnknown: false,
    costEstimated: false,
  }
}

/** Custo em USD a partir de preços por 1M de tokens. */
export function costOf(u, pricing) {
  if (!pricing) return null
  const p = pricing
  return (
    ((u.input || 0) * (p.input || 0) +
      (u.output || 0) * (p.output || 0) +
      (u.cacheRead || 0) * (p.cacheRead ?? p.input ?? 0) +
      (u.cacheWrite || 0) * (p.cacheWrite ?? p.input ?? 0)) /
    1e6
  )
}

export function estimateTokens(text) {
  if (!text) return 0
  return Math.ceil(String(text).length / 4)
}

export function estimateMessagesTokens(messages) {
  let n = 0
  for (const m of messages) {
    n += 4 + estimateTokens(m.content)
    for (const tc of m.toolCalls || []) n += 8 + estimateTokens(tc.args) + estimateTokens(tc.name)
  }
  return n
}

function addInto(target, e) {
  target.requests += e.requests ?? 1
  for (const k of FIELDS) target[k] += e[k] || 0
  if (e.estimated) target.estimated = true
  if (e.costUnknown) target.costUnknown = true
  if (e.costEstimated) target.costEstimated = true
}

export function promptTokens(u) {
  return (u?.input || 0) + (u?.cacheRead || 0) + (u?.cacheWrite || 0)
}

export function cacheHitRate(u) {
  const p = promptTokens(u)
  return p ? (u.cacheRead || 0) / p : 0
}

export class UsageTracker {
  constructor(data) {
    this.total = emptyUsage()
    this.byModel = {}
    this.turn = emptyUsage()
    this.contextTokens = 0
    this.last = null
    this.limits = data?.limits || null
    if (data) {
      Object.assign(this.total, data.total || {})
      for (const [k, v] of Object.entries(data.byModel || {})) this.byModel[k] = Object.assign(emptyUsage(), v)
      this.contextTokens = data.contextTokens || 0
    }
  }

  startTurn() {
    this.turn = emptyUsage()
  }

  /**
   * Registra uma requisição. `u` = { input, output, cacheRead, cacheWrite, reasoning, cost? }.
   */
  record(modelRef, u, { pricing = null, free = false, apiMs = 0, ttftMs = 0, genMs = 0, estimated = false, updateContext = true } = {}) {
    const reported = typeof u.cost === 'number' ? u.cost : null
    const computed = free ? 0 : costOf(u, pricing)
    const cost = reported ?? computed
    const p = free ? null : pricing
    const entry = {
      requests: 1,
      input: u.input || 0,
      output: u.output || 0,
      cacheRead: u.cacheRead || 0,
      cacheWrite: u.cacheWrite || 0,
      reasoning: u.reasoning || 0,
      cost: cost ?? 0,
      costIn: p ? ((u.input || 0) * (p.input || 0)) / 1e6 : 0,
      costOut: p ? ((u.output || 0) * (p.output || 0)) / 1e6 : 0,
      costCacheRead: p ? ((u.cacheRead || 0) * (p.cacheRead ?? p.input ?? 0)) / 1e6 : 0,
      costCacheWrite: p ? ((u.cacheWrite || 0) * (p.cacheWrite ?? p.input ?? 0)) / 1e6 : 0,
      costUnknown: cost == null,
      costEstimated: reported == null && computed != null && !free,
      estimated,
      apiMs,
      ttftMs,
      genMs,
    }
    addInto(this.total, entry)
    addInto(this.turn, entry)
    addInto((this.byModel[modelRef] ||= emptyUsage()), entry)
    if (updateContext) this.contextTokens = entry.input + entry.cacheRead + entry.cacheWrite + entry.output
    this.last = { model: modelRef, ...entry }
    return entry
  }

  toJSON() {
    return { total: this.total, byModel: this.byModel, contextTokens: this.contextTokens, limits: this.limits }
  }
}
