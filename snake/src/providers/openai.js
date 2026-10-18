import { captureLimits } from './limits.js'
// Adaptador para APIs compatíveis com OpenAI Chat Completions (OpenRouter, Groq, Gemini, Ollama...).

import crypto from 'node:crypto'
import { VERSION } from '../config.js'
import { ProviderError, errorFromResponse, sseEvents } from './sse.js'

function fixToolId(id, format, map) {
  if (!id) return id
  if (format !== 'alnum9') return id
  if (/^[a-zA-Z0-9]{9}$/.test(id)) return id
  if (!map.has(id)) map.set(id, crypto.createHash('sha1').update(id).digest('hex').slice(0, 9))
  return map.get(id)
}

function applyCacheControl(msgs) {
  const mark = (m) => {
    if (typeof m.content === 'string' && m.content) m.content = [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }]
  }
  const sys = msgs.find((m) => m.role === 'system')
  if (sys) mark(sys)
  let n = 0
  for (let i = msgs.length - 1; i >= 0 && n < 2; i--) {
    if (msgs[i].role === 'user' || msgs[i].role === 'tool') {
      mark(msgs[i])
      n++
    }
  }
}

/** Converte as mensagens internas do Snake para o formato Chat Completions. */
export function toOpenAIMessages(system, messages, { provider = {}, model = {} } = {}) {
  const out = []
  if (system) out.push({ role: 'system', content: system })
  const idMap = new Map()
  const fmt = provider.compat?.toolIdFormat
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content })
    } else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.content || (m.toolCalls?.length ? null : '') }
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: fixToolId(tc.id, fmt, idMap),
          type: 'function',
          function: { name: tc.name, arguments: tc.args || '{}' },
        }))
      }
      out.push(msg)
    } else if (m.role === 'tool') {
      const msg = { role: 'tool', tool_call_id: fixToolId(m.toolCallId, fmt, idMap), content: m.content || '(sem saída)' }
      if (provider.compat?.toolMessageName) msg.name = m.name
      out.push(msg)
    }
  }
  if (typeof provider.cacheControl === 'function' && provider.cacheControl(model.id || '')) applyCacheControl(out)
  return out
}

/** Normaliza o objeto `usage` (vários dialetos) para { input, cacheRead, cacheWrite, output, reasoning, cost }. */
export function normalizeOpenAIUsage(u) {
  if (!u) return null
  const prompt = u.prompt_tokens ?? u.input_tokens ?? 0
  const cacheRead = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? u.cache_read_input_tokens ?? u.input_tokens_details?.cached_tokens ?? 0
  const cacheWrite = u.prompt_tokens_details?.cache_write_tokens ?? u.cache_creation_input_tokens ?? 0
  const output = u.completion_tokens ?? u.output_tokens ?? 0
  const reasoning = u.completion_tokens_details?.reasoning_tokens ?? u.output_tokens_details?.reasoning_tokens ?? 0
  return {
    input: Math.max(0, prompt - cacheRead - cacheWrite),
    cacheRead,
    cacheWrite,
    output,
    reasoning,
    cost: typeof u.cost === 'number' ? u.cost : undefined,
  }
}

function newState() {
  return { text: '', reasoning: '', toolCalls: [], usage: null, finish: null, model: null, thinkMode: undefined, pending: '' }
}

function emitText(st, text, onEvent) {
  if (!text) return
  st.text += text
  onEvent({ type: 'text', delta: text })
}

function emitReasoning(st, text, onEvent) {
  if (!text) return
  st.reasoning += text
  onEvent({ type: 'reasoning', delta: text })
}

// Alguns modelos (Qwen, DeepSeek-R1 via Ollama...) mandam o raciocínio dentro de <think>...</think>.
function handleContent(text, st, onEvent) {
  if (st.thinkMode === 'none' || st.thinkMode === 'out') return emitText(st, text, onEvent)
  st.pending += text
  if (st.thinkMode === undefined) {
    const trimmed = st.pending.trimStart()
    if (!trimmed) return
    if (trimmed.length < 7 && '<think>'.startsWith(trimmed)) return
    if (trimmed.startsWith('<think>')) {
      st.thinkMode = 'in'
      st.pending = trimmed.slice(7)
    } else {
      st.thinkMode = 'none'
      const t = st.pending
      st.pending = ''
      return emitText(st, t, onEvent)
    }
  }
  if (st.thinkMode === 'in') {
    const end = st.pending.indexOf('</think>')
    if (end === -1) {
      const safe = st.pending.length - 8
      if (safe > 0) {
        emitReasoning(st, st.pending.slice(0, safe), onEvent)
        st.pending = st.pending.slice(safe)
      }
      return
    }
    emitReasoning(st, st.pending.slice(0, end), onEvent)
    const rest = st.pending.slice(end + 8).replace(/^\s+/, '')
    st.pending = ''
    st.thinkMode = 'out'
    emitText(st, rest, onEvent)
  }
}

function handleToolCalls(list, st, onEvent) {
  list.forEach((tc, pos) => {
    let idx = typeof tc.index === 'number' ? tc.index : pos
    let cur = st.toolCalls[idx]
    if (cur && tc.id && cur.id && tc.id !== cur.id) {
      idx = st.toolCalls.length
      cur = undefined
    }
    if (!cur) {
      cur = st.toolCalls[idx] = { id: tc.id || '', name: '', args: '' }
      onEvent({ type: 'toolcall-start', index: idx })
    }
    if (tc.id && !cur.id) cur.id = tc.id
    const fn = tc.function || {}
    if (fn.name && !cur.name) {
      cur.name = fn.name
      onEvent({ type: 'toolcall-name', index: idx, name: fn.name })
    }
    if (fn.arguments != null) {
      const piece = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments)
      cur.args += piece
      onEvent({ type: 'toolcall-delta', index: idx, name: cur.name, length: cur.args.length })
    }
  })
}

function handleChunk(chunk, st, onEvent) {
  if (chunk.model) st.model = chunk.model
  const u = chunk.usage || chunk.x_groq?.usage
  if (u) st.usage = u
  const choice = chunk.choices?.[0]
  if (!choice) return
  const d = choice.delta || choice.message || {}
  const reasoning = d.reasoning_content ?? d.reasoning ?? null
  if (typeof reasoning === 'string') emitReasoning(st, reasoning, onEvent)
  if (typeof d.content === 'string') handleContent(d.content, st, onEvent)
  if (Array.isArray(d.tool_calls)) handleToolCalls(d.tool_calls, st, onEvent)
  if (choice.finish_reason) st.finish = choice.finish_reason
}

function finalize(st, onEvent) {
  if (st.pending) {
    if (st.thinkMode === 'in') emitReasoning(st, st.pending, onEvent)
    else emitText(st, st.pending, onEvent)
    st.pending = ''
  }
  const toolCalls = st.toolCalls
    .filter(Boolean)
    .filter((tc) => tc.name)
    .map((tc) => ({ id: tc.id || `call_${crypto.randomBytes(6).toString('hex')}`, name: tc.name, args: tc.args || '{}' }))
  return {
    message: { role: 'assistant', content: st.text, reasoning: st.reasoning || undefined, toolCalls: toolCalls.length ? toolCalls : undefined },
    usage: normalizeOpenAIUsage(st.usage),
    finishReason: st.finish,
    responseModel: st.model,
  }
}

export async function streamOpenAI({ provider, model, apiKey, system, messages, tools, signal, maxTokens, temperature, effort, onEvent = () => {} }) {
  const url = provider.chatURL || `${provider.baseURL.replace(/\/+$/, '')}/chat/completions`
  const body = { model: model.id, messages: toOpenAIMessages(system, messages, { provider, model }), stream: model.stream !== false }
  if (body.stream && provider.compat?.streamOptions !== false) body.stream_options = { include_usage: true }
  if (tools?.length) {
    body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
  }
  if (maxTokens) body[provider.compat?.maxTokensField || 'max_tokens'] = maxTokens
  if (temperature != null) body.temperature = temperature
  if (effort && effort !== 'auto' && model.reasoning !== false) {
    const level = effort === 'max' ? 'high' : effort
    if (provider.id === 'openrouter') body.reasoning = { effort: level }
    else if (provider.id === 'cohere') body.reasoning_effort = 'high'
    // Ultron: o Ollama aceita reasoning_effort ("none" desliga o pensamento do Qwen/Gemma)
    else if (model.reasoning || provider.id === 'openai' || provider.id === 'ollama') body.reasoning_effort = level
  }
  if (provider.extraBody) Object.assign(body, provider.extraBody)

  const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'User-Agent': `snake-harness/${VERSION}`, ...(provider.headers || {}) }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal })
  captureLimits(model, res.headers, onEvent)
  if (!res.ok) throw await errorFromResponse(res, provider.id)

  const st = newState()
  const ctype = res.headers.get('content-type') || ''
  if (!ctype.includes('event-stream')) {
    const text = await res.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {
      throw new ProviderError(`${provider.id}: resposta inválida (${text.slice(0, 200)})`, { provider: provider.id })
    }
    if (json.error) throw new ProviderError(`${provider.id}: ${json.error.message || JSON.stringify(json.error)}`, { provider: provider.id, status: Number(json.error.code) || 0 })
    handleChunk(json, st, onEvent)
    return finalize(st, onEvent)
  }

  for await (const ev of sseEvents(res.body)) {
    const data = ev.data.trim()
    if (!data) continue
    if (data === '[DONE]') break
    let chunk
    try {
      chunk = JSON.parse(data)
    } catch {
      continue
    }
    if (chunk.error) {
      const e = chunk.error
      throw new ProviderError(`${provider.id}: ${e.message || JSON.stringify(e)}`, { provider: provider.id, status: Number(e.code) || 0, code: String(e.type || e.code || '') })
    }
    handleChunk(chunk, st, onEvent)
  }
  return finalize(st, onEvent)
}
