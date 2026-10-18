import path from 'node:path'
import { paths, readJSON, writeJSON } from '../config.js'
export function captureLimits(model, headers, emit = () => {}) {
  const limits = {}
  for (const [name, value] of headers) if (/^(x-)?ratelimit-|^retry-after$|^anthropic-ratelimit-/.test(name)) limits[name] = value
  if (!Object.keys(limits).length) return null
  const entry = { at: Date.now(), headers: limits }
  try { const file = path.join(paths.cache, 'ratelimits.json'); const all = readJSON(file, {}); all[`${model.provider}/${model.id}`] = entry; writeJSON(file, all, 0o600) } catch {}
  emit({ type: 'ratelimit', ...entry })
  return entry
}
