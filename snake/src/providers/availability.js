import crypto from 'node:crypto'
import path from 'node:path'
import { paths, readJSON, writeJSON } from '../config.js'
import { resolveKey } from './registry.js'
import { ProviderError, retryDelayLabel } from './sse.js'

const file = () => path.join(paths.cache, 'availability.json')
function scope(model) {
  // Uma chave nova não herda a cota de outra conta. Nunca persistimos a chave.
  const account = crypto.createHash('sha256').update(resolveKey(model.provider)?.key || 'anonymous').digest('hex').slice(0, 20)
  return `${model.provider}/${account}`
}

export function availability(model, now = Date.now()) {
  const states = readJSON(file(), {})
  const key = scope(model)
  const state = states[key] || states[`${key}/${model.id}`]
  if (!state || state.until <= now) return null
  return { ...state, remaining: state.until - now, label: `${state.code === 'quota_exceeded' ? 'cota esgotada' : 'limite temporário'}${state.hasRetryAfter ? ' · ' + retryDelayLabel(state.until - now) : ''}` }
}

export function recordFailure(model, err, now = Date.now()) {
  if (err.status !== 429 && err.code !== 'quota_exceeded') return
  const states = readJSON(file(), {})
  for (const [key, state] of Object.entries(states)) if (state.until <= now) delete states[key]
  const key = scope(model) + (err.code === 'quota_exceeded' ? '' : `/${model.id}`)
  states[key] = { until: now + (err.retryAfterMs ?? 60000), hasRetryAfter: err.retryAfterMs != null, code: err.code, status: err.status }
  try { writeJSON(file(), states) } catch { /* cache indisponível não substitui o erro da API */ }
}

export function assertAvailable(model) {
  const state = availability(model)
  if (!state) return
  throw new ProviderError(`${model.provider}: ${state.label}`, { provider: model.provider, status: state.status, code: state.code, retryAfterMs: state.remaining })
}
