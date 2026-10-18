// Leitor de Server-Sent Events e erros de provedor.

/** Lê um corpo de resposta SSE e produz eventos { event, data }. */
export async function* sseEvents(body) {
  const decoder = new TextDecoder()
  let buf = ''
  let event = ''
  let data = []

  function* dispatch() {
    if (data.length) yield { event: event || 'message', data: data.join('\n') }
    event = ''
    data = []
  }

  function* processLine(line) {
    if (line === '') {
      yield* dispatch()
      return
    }
    if (line.startsWith(':')) return
    const idx = line.indexOf(':')
    const field = idx === -1 ? line : line.slice(0, idx)
    let value = idx === -1 ? '' : line.slice(idx + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') {
      // Alguns servidores não separam eventos com linha em branco: se o dado anterior já
      // é um JSON completo, despacha antes de começar o próximo.
      if (data.length && isCompleteJSON(data.join('\n'))) yield* dispatch()
      data.push(value)
    } else if (field === 'event') {
      event = value
    }
  }

  for await (const chunk of body) {
    buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      let line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      yield* processLine(line)
    }
  }
  buf += decoder.decode()
  if (buf) yield* processLine(buf.replace(/\r$/, ''))
  yield* dispatch()
}

function isCompleteJSON(s) {
  const t = s.trim()
  if (t === '[DONE]') return true
  if (!t.startsWith('{') || !t.endsWith('}')) return false
  try {
    JSON.parse(t)
    return true
  } catch {
    return false
  }
}

export class ProviderError extends Error {
  constructor(message, { status = 0, body = '', retryAfterMs = null, provider = '', code = '' } = {}) {
    super(message)
    this.name = 'ProviderError'
    this.status = status
    this.body = body
    this.retryAfterMs = retryAfterMs
    this.provider = provider
    this.code = /(?:daily|monthly|insufficient|exhausted|exceeded)[\s\S]{0,40}quota|quota[\s\S]{0,40}(?:exceeded|exhausted)|daily[\s\S]{0,30}limit/i.test(message + ' ' + body)
      ? 'quota_exceeded' : code
  }

  get retryable() {
    if (this.code === 'quota_exceeded') return false
    if (!this.status) return true
    return [408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529].includes(this.status)
  }
}

function parseRetryAfter(headers, body) {
  const h = headers?.get?.('retry-after')
  if (h) {
    const secs = Number(h)
    if (Number.isFinite(secs) && secs >= 0) return secs * 1000
    const date = Date.parse(h)
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  }
  const m = /retry[_ -]?after["':\s]+(\d+(?:\.\d+)?)/i.exec(body || '')
  if (m) return Number(m[1]) * 1000
  return null
}

/** Cria um ProviderError a partir de uma resposta HTTP de erro. */
export async function errorFromResponse(res, provider) {
  let body = ''
  try {
    body = await res.text()
  } catch {}
  let message = body
  let code = ''
  try {
    const j = JSON.parse(body)
    const e = j.error || j
    message = e.message || e.error?.message || (typeof e === 'string' ? e : JSON.stringify(e))
    code = e.code || e.type || ''
    if (e.metadata?.raw) message += ` — ${typeof e.metadata.raw === 'string' ? e.metadata.raw : JSON.stringify(e.metadata.raw)}`
  } catch {}
  message = String(message || res.statusText || 'erro desconhecido').slice(0, 1200)
  return new ProviderError(`${provider}: HTTP ${res.status} — ${message}`, {
    status: res.status,
    body,
    retryAfterMs: parseRetryAfter(res.headers, body),
    provider,
    code: typeof code === 'string' ? code : String(code),
  })
}

/** Dica amigável em português para erros comuns. */
export function errorHint(err) {
  const s = err?.status
  const wait = err?.retryAfterMs > 0 ? ` Nova tentativa em ${retryDelayLabel(err.retryAfterMs)}.` : ''
  if (err?.code === 'quota_exceeded') return `Cota esgotada neste provedor.${wait} Trocar de modelo nele pode usar a mesma cota. Use /models para escolher outro provedor.`
  if (s === 401 || s === 403) return 'Verifique a chave de API (use /key <provedor>).'
  if (s === 402) return 'Sem créditos neste provedor. Troque para um modelo grátis com /models.'
  if (s === 404) return 'Modelo ou endpoint não encontrado. Escolha outro com /models.'
  if (s === 413) return 'Contexto grande demais. Use /compact ou um modelo com janela maior.'
  if (s === 429) return `Limite temporário de requisições.${wait} Consulte /models para escolher outro provedor.`
  if (s >= 500) return 'O provedor está instável. Tente de novo em instantes.'
  return ''
}

export function retryDelayLabel(ms) {
  const minutes = Math.ceil(ms / 60000)
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}min`
  return ms >= 60000 ? `${minutes}min` : `${Math.ceil(ms / 1000)}s`
}
