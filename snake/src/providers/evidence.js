import path from 'node:path'
import crypto from 'node:crypto'
import { paths, readJSON, writeJSON } from '../config.js'
import { PROVIDERS } from './registry.js'
export const EVIDENCE_TTL = 24 * 3600 * 1000
export function evidenceKey(model) {
  const p = PROVIDERS[model.provider]
  const endpoint = p?.chatURL || p?.baseURL || ''
  return `${model.provider}/${model.id}@${crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 12)}`
}
// A interface chama isto para cada modelo do catálogo a cada redesenho; sem cache eram centenas de leituras de disco por quadro.
const FILE_CACHE_MS = 2000
const fileCache = new Map()
const keyCache = new Map()
function readEvidenceFile(file) {
  const hit = fileCache.get(file)
  if (hit && Date.now() - hit.at < FILE_CACHE_MS) return hit.data
  const data = readJSON(file, {})
  fileCache.set(file, { at: Date.now(), data })
  return data
}
function cachedEvidenceKey(model) {
  const p = PROVIDERS[model.provider]
  const id = `${model.provider}/${model.id}@${p?.chatURL || p?.baseURL || ''}`
  let key = keyCache.get(id)
  if (!key) keyCache.set(id, (key = evidenceKey(model)))
  return key
}
export function readEvidence(kind, model, now = Date.now()) {
  const record = readEvidenceFile(path.join(paths.cache, `${kind}.json`))[cachedEvidenceKey(model)]
  return record && now - record.at < EVIDENCE_TTL ? record : null
}
export function writeEvidence(kind, model, value) {
  const file = path.join(paths.cache, `${kind}.json`), data = readJSON(file, {})
  data[evidenceKey(model)] = { at: Date.now(), ...value }; writeJSON(file, data, 0o600); fileCache.delete(file)
  return data[evidenceKey(model)]
}
