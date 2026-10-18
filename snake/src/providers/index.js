// Ponto único para conversar com qualquer provedor, com novas tentativas automáticas.

import { streamAnthropic } from './anthropic.js'
import { streamOpenAI } from './openai.js'
import { PROVIDERS, resolveKey } from './registry.js'
import { ProviderError } from './sse.js'
import { assertAvailable, recordFailure } from './availability.js'

const requestWindows = new Map()
export function enforceRateLimit(provider, rule, now = Date.now()) {
  if (!rule) return
  if (!Number.isSafeInteger(rule.requests) || rule.requests < 1 || !Number.isFinite(rule.windowMs) || rule.windowMs < 1) throw new ProviderError('ratelimit exige requests inteiro positivo e windowMs positivo', { status: 400, provider })
  const recent = (requestWindows.get(provider) || []).filter((at) => now - at < rule.windowMs)
  requestWindows.set(provider, recent)
  if (recent.length >= rule.requests) throw new ProviderError(`Limite local de ${provider} atingido`, { status: 429, provider, retryAfterMs: Math.max(0, recent[0] + rule.windowMs - now) })
  recent.push(now)
}

export async function streamCompletion(opts) {
  const provider = PROVIDERS[opts.model.provider]
  if (!provider) throw new ProviderError(`Provedor desconhecido: ${opts.model.provider}`, { status: 404 })
  const key = resolveKey(provider.id)?.key
  if (provider.keyRequired && !key) {
    throw new ProviderError(`${provider.name} precisa de uma chave de API. Use /key ${provider.id} (crie em ${provider.keyURL}).`, {
      status: 401,
      provider: provider.id,
      code: 'missing_key',
    })
  }
  const fn = provider.kind === 'anthropic' ? streamAnthropic : streamOpenAI
  enforceRateLimit(provider.id, opts.rateLimit)
  return fn({ ...opts, provider, apiKey: key })
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      },
      { once: true },
    )
  })
}

export function isAbortError(err) {
  return err?.name === 'AbortError' || err?.code === 'ABORT_ERR'
}

export const FIRST_BYTE_TIMEOUT = 180000
export const IDLE_TIMEOUT = 120000

/**
 * Vigia de inatividade: um provedor que aceita a conexão e para de mandar dados (comum em endpoints grátis)
 * deixava o turno preso para sempre. Sem nenhum evento em `firstMs` (início) ou `idleMs` (no meio da resposta),
 * a requisição é abortada e vira um erro que pode ser tentado de novo.
 */
export function watchdog(signal, { firstMs = FIRST_BYTE_TIMEOUT, idleMs = IDLE_TIMEOUT } = {}) {
  const ctl = new AbortController()
  const onAbort = () => ctl.abort(signal.reason)
  if (signal?.aborted) ctl.abort(signal.reason)
  else signal?.addEventListener('abort', onAbort, { once: true })
  let timer = null
  let stalled = 0
  const arm = (ms) => {
    clearTimeout(timer)
    if (!ms) return
    timer = setTimeout(() => { stalled = ms; ctl.abort(new DOMException('Provedor parou de responder', 'AbortError')) }, ms)
    timer.unref?.()
  }
  arm(firstMs)
  return {
    signal: ctl.signal,
    touch: () => arm(idleMs),
    get stalled() { return stalled },
    done: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) },
  }
}

/** Faz a chamada com novas tentativas em erros transitórios (429, 5xx, rede, conexão parada) antes do primeiro token. */
export async function streamWithRetry(opts, { retries = 4, onRetry } = {}) {
  assertAvailable(opts.model)
  let attempt = 0
  for (;;) {
    let started = false
    const wd = watchdog(opts.signal, { firstMs: opts.firstByteTimeoutMs ?? FIRST_BYTE_TIMEOUT, idleMs: opts.idleTimeoutMs ?? IDLE_TIMEOUT })
    const onEvent = (e) => {
      wd.touch()
      if (e.type !== 'ratelimit') started = true
      opts.onEvent?.(e)
    }
    try {
      return await streamCompletion({ ...opts, signal: wd.signal, onEvent })
    } catch (caught) {
      let err = caught
      if (opts.signal?.aborted) throw err
      if (wd.stalled) err = new ProviderError(`${opts.model.provider}: o provedor parou de responder por ${Math.round(wd.stalled / 1000)}s (conexão parada)`, { provider: opts.model.provider, code: 'stalled' })
      else if (isAbortError(err)) throw err
      const pe =
        err instanceof ProviderError
          ? err
          : new ProviderError(`${opts.model.provider}: ${err.cause?.code || err.cause?.message || err.message || err}`, { provider: opts.model.provider })
      if (started || !pe.retryable || attempt >= retries) {
        recordFailure(opts.model, pe)
        throw pe
      }
      const delay = pe.retryAfterMs ?? Math.min(30000, 1000 * 2 ** attempt) + Math.random() * 500
      if (delay > 90000) {
        recordFailure(opts.model, pe)
        throw pe
      }
      attempt++
      onRetry?.({ attempt, delay, error: pe })
      await sleep(delay, opts.signal)
    } finally {
      wd.done()
    }
  }
}
