// Catálogo de modelos: junta metadados (contexto, preços, suporte a ferramentas) de várias fontes,
// com cache em ~/.snake/cache.

import fs from 'node:fs'
import path from 'node:path'
import { paths, readJSON, writeJSON } from '../config.js'
import { PROVIDERS, isUsable, resolveKey } from './registry.js'
import { isZeroPrice, tokenPricing } from './pricing.js'
import { readEvidence } from './evidence.js'
import { availability } from './availability.js'

export const CACHE_VERSION = 4
const HOUR = 3600_000
// Depois disso o cache não serve mais para afirmar preço (a atualização roda em segundo plano).
const MAX_AGE = 24 * HOUR
export const DEFAULT_CONTEXT = 128_000

const SOURCES = {
  modelsdev: { url: 'https://models.dev/api.json', ttl: 24 * HOUR, transform: trimModelsDev },
  openrouter: { url: 'https://openrouter.ai/api/v1/models', ttl: 6 * HOUR, transform: normalizeOpenRouter },
  pollinations: { url: 'https://text.pollinations.ai/models', ttl: 6 * HOUR, transform: normalizePollinations },
  llm7: { url: 'https://api.llm7.io/v1/models', ttl: 6 * HOUR, transform: normalizeLLM7 },
}

const FALLBACK = {
  pollinations: [
    { provider: 'pollinations', id: 'openai-fast', name: 'GPT-OSS 20B (Pollinations)', context: 131072, free: true, access: 'anon', tools: true, reasoning: true, pricing: zeroPrice() },
  ],
  llm7: [
    { provider: 'llm7', id: 'gpt-oss:20b', name: 'GPT-OSS 20B (LLM7)', context: 128000, free: false, access: 'unknown', tools: true, pricing: null },
  ],
  github: [
    'openai/gpt-4.1',
    'openai/gpt-4.1-mini',
    'openai/gpt-4o',
    'openai/gpt-4o-mini',
    'deepseek/deepseek-v3-0324',
    'meta/llama-4-maverick-17b-128e-instruct-fp8',
    'mistral-ai/codestral-2501',
    'xai/grok-3-mini',
  ].map((id) => ({ provider: 'github', id, name: id, context: 128000, free: false, access: 'unknown', tools: true, pricing: null })),
}

function zeroPrice() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

function perMillion(v) {
  if (v == null || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n * 1e6 : undefined
}

export function trimModelsDev(json) {
  const wanted = new Set(Object.values(PROVIDERS).map((p) => p.modelsDev).filter(Boolean))
  const out = {}
  for (const [pid, p] of Object.entries(json || {})) {
    if (!wanted.has(pid)) continue
    out[pid] = Object.values(p.models || {})
      .filter((m) => m.tool_call !== false)
      .map((m) => ({
        id: m.id,
        name: m.name || m.id,
        context: m.limit?.context || undefined,
        maxOutput: m.limit?.output || undefined,
        pricing: tokenPricing(m.cost?.input, m.cost?.output, m.cost?.cache_read, m.cost?.cache_write),
        free: isZeroPrice(tokenPricing(m.cost?.input, m.cost?.output, m.cost?.cache_read, m.cost?.cache_write)),
        tools: m.tool_call !== false,
        reasoning: !!m.reasoning,
        released: m.release_date || m.last_updated || '',
      }))
  }
  return out
}

export function normalizeOpenRouter(json) {
  return (json?.data || [])
    .filter((m) => (m.supported_parameters || []).includes('tools') && (m.architecture?.output_modalities || ['text']).includes('text'))
    .map((m) => {
      const pr = m.pricing || {}
      const input = perMillion(pr.prompt)
      const output = perMillion(pr.completion)
      const pricing = tokenPricing(input, output, perMillion(pr.input_cache_read), perMillion(pr.input_cache_write))
      const extraCharge = Object.values(pr).some((v) => Number(v) > 0)
      const free = !extraCharge && isZeroPrice(pricing)
      return {
        provider: 'openrouter',
        id: m.id,
        name: m.name || m.id,
        context: m.context_length || undefined,
        maxOutput: m.top_provider?.max_completion_tokens || undefined,
        pricing: pricing || (free ? zeroPrice() : null),
        free,
        tools: true,
        reasoning: (m.supported_parameters || []).includes('reasoning'),
        released: m.created ? new Date(m.created * 1000).toISOString().slice(0, 10) : '',
      }
    })
}

export function normalizePollinations(json) {
  return (Array.isArray(json) ? json : [])
    .filter((m) => m.tools && (m.output_modalities || ['text']).includes('text'))
    .map((m) => {
      const pricing = tokenPricing(m.pricing?.input, m.pricing?.output)
      // Tier anônimo: sem conta não há cobrança possível. Outros tiers exigem conta/créditos.
      const anon = m.tier === 'anonymous' && !m.paid_only && !m.pricing
      return {
        provider: 'pollinations',
        id: m.name,
        name: m.description || m.name,
        context: m.context_length || 131072,
        free: anon || isZeroPrice(pricing),
        access: anon ? 'anon' : m.pricing || m.paid_only ? 'paid' : 'unknown',
        tools: true,
        reasoning: !!m.reasoning,
        pricing: anon ? zeroPrice() : pricing,
        tier: m.tier,
      }
    })
}

export function normalizeLLM7(json) {
  return (json?.data || [])
    .filter((m) => (m.model_type || 'chat') === 'chat' && (m.tools_calling || m.capabilities?.tools))
    .map((m) => {
      const pricing = (m.pricing?.currency && m.pricing.currency !== 'USD') || (m.pricing?.unit && m.pricing.unit !== '1M tokens')
        ? null : tokenPricing(m.pricing?.input, m.pricing?.output, m.pricing?.cached_input)
      const free = isZeroPrice(pricing)
      return {
        provider: 'llm7',
        id: m.id,
        stream: m.stream !== false,
        name: m.id,
        context: m.context_window?.tokens || undefined,
        free,
        tools: true,
        reasoning: !!m.reasoning,
        access: free ? 'free' : m.usage_based_only === false ? 'quota' : pricing ? 'paid' : 'unknown',
        pricing,
      }
    })
}

async function fetchJSON(url, { headers = {}, timeout = 15000 } = {}) {
  const res = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeout) })
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`)
  return res.json()
}

export class Catalog {
  constructor() {
    this.data = {}
    this.fetchedAt = {}
    this.live = {}
    this.pending = new Map()
    this.errors = {}
    this.removed = []
  }

  cacheFile(name) {
    return path.join(paths.cache, `${name}.json`)
  }

  /** Carrega os caches do disco (rápido, síncrono). */
  load() {
    for (const name of Object.keys(SOURCES)) {
      const cached = readJSON(this.cacheFile(name), null)
      if (cached?.version === CACHE_VERSION && cached?.data) {
        this.data[name] = cached.data
        this.fetchedAt[name] = cached.fetchedAt || 0
      }
    }
    return this
  }

  isStale(name) {
    return !this.data[name] || Date.now() - (this.fetchedAt[name] || 0) > SOURCES[name].ttl
  }

  async refresh(name) {
    if (this.pending.has(name)) return this.pending.get(name)
    const src = SOURCES[name]
    const job = (async () => {
      try {
        const json = await fetchJSON(src.url, { timeout: name === 'modelsdev' ? 30000 : 15000 })
        const data = src.transform(json)
        const flatten = (v) => Array.isArray(v) ? v : Object.entries(v || {}).flatMap(([p, list]) => list.map((m) => ({ ...m, id: `${p}/${m.id}` })))
        const nextIds = new Set(flatten(data).map((m) => m.id))
        this.removed.push(...flatten(this.data[name]).filter((m) => !nextIds.has(m.id)).map((m) => `${name}/${m.id}`))
        this.data[name] = data
        this.fetchedAt[name] = Date.now()
        writeJSON(this.cacheFile(name), { version: CACHE_VERSION, fetchedAt: this.fetchedAt[name], data })
        delete this.errors[name]
        return data
      } catch (err) {
        this.errors[name] = err.message
        return this.data[name]
      } finally {
        this.pending.delete(name)
      }
    })()
    this.pending.set(name, job)
    return job
  }

  /** Atualiza as fontes vencidas. Por padrão não bloqueia. */
  refreshStale({ wait = false, only } = {}) {
    const names = (only || Object.keys(SOURCES)).filter((n) => this.isStale(n))
    const jobs = names.map((n) => this.refresh(n))
    return wait ? Promise.all(jobs) : Promise.resolve()
  }

  /** Consulta provedores locais e listas dinâmicas que exigem chave. */
  async loadLive({ timeout = 1500 } = {}) {
    const jobs = []
    for (const p of Object.values(PROVIDERS)) {
      if (p.catalog === 'ollama') {
        jobs.push(
          fetchJSON(p.baseURL.replace(/\/v1$/, '') + '/api/tags', { timeout })
            .then((j) => {
              this.live[p.id] = (j.models || []).map((m) => ({
                provider: p.id,
                id: m.name,
                name: `${m.name}${m.details?.parameter_size ? ` (${m.details.parameter_size})` : ''}`,
                context: 32768,
                free: true, access: 'local',
                tools: true,
                pricing: zeroPrice(),
              }))
            })
            .catch(() => {
              this.live[p.id] = []
            }),
        )
      } else if (p.catalog === 'openai-list' && (p.free === 'local' || isUsable(p.id))) {
        const key = resolveKey(p.id)?.key
        jobs.push(
          fetchJSON(p.baseURL.replace(/\/$/, '') + '/models', { timeout, headers: key ? { Authorization: `Bearer ${key}` } : {} })
            .then((j) => {
              this.live[p.id] = (j.data || []).map((m) => ({
                provider: p.id,
                id: m.id,
                name: m.id,
                context: m.context_length || m.max_context_length || DEFAULT_CONTEXT,
                free: p.free === 'local', access: p.free === 'local' ? 'local' : 'unknown',
                tools: true,
                pricing: p.free === 'local' ? zeroPrice() : null,
              }))
            })
            .catch(() => {
              this.live[p.id] = []
            }),
        )
      } else if (p.catalog === 'github' && isUsable(p.id)) {
        const key = resolveKey(p.id)?.key
        jobs.push(
          fetchJSON('https://models.github.ai/catalog/models', { timeout: 5000, headers: { Authorization: `Bearer ${key}` } })
            .then((j) => {
              if (!Array.isArray(j)) return
              this.live[p.id] = j
                .filter((m) => (m.capabilities || []).includes('tool-calling'))
                .map((m) => ({
                  provider: p.id,
                  id: m.id,
                  name: m.name || m.id,
                  context: m.limits?.max_input_tokens || DEFAULT_CONTEXT,
                  maxOutput: m.limits?.max_output_tokens,
                  free: false,
                  access: 'quota',
                  tools: true,
                  pricing: null,
                }))
            })
            .catch(() => {}),
        )
      }
    }
    await Promise.all(jobs)
  }

  /** Modelos conhecidos de um provedor. */
  models(providerId) {
    const p = PROVIDERS[providerId]
    if (!p) return []
    let list
    switch (p.catalog) {
      case 'pollinations':
        list = this.data.pollinations ?? FALLBACK.pollinations.map((m) => ({ ...m, free: false, pricing: null, catalogStale: true }))
        break
      case 'llm7':
        list = this.data.llm7 ?? FALLBACK.llm7
        break
      case 'openrouter':
        list = this.data.openrouter ?? p.preferred.map((id) => ({ provider: 'openrouter', id, name: id, free: false, tools: true, pricing: null, catalogStale: true }))
        break
      case 'modelsdev':
        list = (this.data.modelsdev?.[p.modelsDev] || []).map((m) => ({ ...m, provider: p.id }))
        if (!this.data.modelsdev) list = p.preferred.map((id) => ({ provider: p.id, id, name: id, tools: true, pricing: null, catalogStale: true }))
        break
      case 'github':
        list = this.live.github?.length ? this.live.github : FALLBACK.github
        break
      case 'config':
        list = Object.entries(p.configModels || {}).map(([id, m]) => ({
          provider: p.id,
          id,
          name: m?.name || id,
          context: m?.context || DEFAULT_CONTEXT,
          maxOutput: m?.maxOutput,
          free: p.free === 'local' || isZeroPrice(tokenPricing(m?.input, m?.output, m?.cacheRead, m?.cacheWrite)),
          access: p.free === 'local' ? 'local' : 'unknown',
          tools: m?.tools !== false,
          pricing: p.free === 'local' ? zeroPrice() : tokenPricing(m?.input, m?.output, m?.cacheRead, m?.cacheWrite),
        }))
        break
      default:
        list = this.live[p.id] || []
    }
    const fetched = this.fetchedAt[p.catalog]
    if (fetched && Date.now() - fetched > MAX_AGE) {
      return list.map((m) => ({ ...m, free: false, pricing: null, catalogStale: true }))
    }
    return list.filter((m) => m.tools !== false).map((m) => ({ ...m, lastUpdated: fetched || null, toolCheck: readEvidence('toolcheck', m), benchmark: readEvidence('bench', m) }))
  }

  allModels() {
    return Object.keys(PROVIDERS).flatMap((id) => this.models(id))
  }

  /** Procura o modelo por referência "provedor/modelo" (ou só "modelo"). */
  find(ref) {
    if (!ref) return null
    const slash = ref.indexOf('/')
    if (slash > 0) {
      const providerId = ref.slice(0, slash)
      const modelId = ref.slice(slash + 1)
      if (PROVIDERS[providerId]) {
        const meta = this.models(providerId).find((m) => m.id === modelId)
        return meta ? { ...meta } : this.unknown(providerId, modelId)
      }
    }
    const candidates = this.allModels().filter((m) => m.id === ref || `${m.provider}/${m.id}`.endsWith('/' + ref))
    if (!candidates.length) return null
    candidates.sort((a, b) => Number(isUsable(b.provider)) - Number(isUsable(a.provider)) || Number(!!b.free) - Number(!!a.free))
    return { ...candidates[0] }
  }

  unknown(providerId, modelId) {
    const p = PROVIDERS[providerId]
    const free = p?.free === 'local'
    return { provider: providerId, id: modelId, name: modelId, context: DEFAULT_CONTEXT, free, access: p?.free === 'local' ? 'local' : 'unknown', tools: true, pricing: free ? zeroPrice() : null, unknown: true }
  }

  has(providerId, modelId) {
    return this.models(providerId).some((m) => m.id === modelId)
  }

  /** Escolhe o melhor modelo padrão de um provedor. */
  defaultFor(providerId) {
    const p = PROVIDERS[providerId]
    if (!p) return null
    const list = this.models(providerId)
    for (const id of p.preferred || []) if (list.some((m) => m.id === id)) return `${providerId}/${id}`
    const free = list.find((m) => m.free && m.tools)
    const any = free || list.find((m) => m.tools) || list[0]
    return any ? `${providerId}/${any.id}` : null
  }

  /**
   * Padrão: o modelo salvo na configuração, se o provedor dele puder ser usado; senão um modelo
   * :free do OpenRouter (com chave) ou o Pollinations anônimo. Nunca cai para um modelo pago.
   */
  defaultRef(config = {}) {
    // Modelo escolhido explicitamente pelo usuário vale sempre; a qualificação por benchmark só decide o padrão automático.
    if (config.model && String(config.model).includes('/')) return config.model
    const eligible = this.allModels().filter((m) => !m.catalogStale && isUsable(m.provider) && !availability(m) && m.toolCheck?.ok && m.benchmark?.score >= 75)
    const free = eligible.filter((m) => m.free && isZeroPrice(m.pricing)).sort((a, b) => b.benchmark.score - a.benchmark.score)[0]
    return free ? `${free.provider}/${free.id}` : null
  }
}

export function clearCache() {
  try {
    for (const f of fs.readdirSync(paths.cache)) fs.rmSync(path.join(paths.cache, f), { force: true })
  } catch {}
}
