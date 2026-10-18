import { captureLimits } from './limits.js'
// Adaptador nativo para a Messages API da Anthropic (streaming, ferramentas, cache de prompt e thinking).

import { VERSION } from '../config.js'
import { ProviderError, errorFromResponse, sseEvents } from './sse.js'

const EPHEMERAL = { type: 'ephemeral' }

function sanitizeId(id) {
  return String(id || 'toolu_x').replace(/[^a-zA-Z0-9_-]/g, '_')
}

function safeParse(s) {
  if (s && typeof s === 'object') return s
  try {
    const v = JSON.parse(s || '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? v : { value: v }
  } catch {
    return { _raw: String(s) }
  }
}

/** Converte mensagens internas para o formato da Messages API. */
export function toAnthropicMessages(messages, { keepThinking = false } = {}) {
  const out = []
  const push = (role, blocks) => {
    const last = out[out.length - 1]
    if (last && last.role === role) last.content.push(...blocks)
    else out.push({ role, content: blocks })
  }
  for (const m of messages) {
    if (m.role === 'user') {
      push('user', [{ type: 'text', text: m.content || '(vazio)' }])
    } else if (m.role === 'assistant') {
      const blocks = []
      if (keepThinking && m.provider === 'anthropic' && m.thinkingBlocks?.length) blocks.push(...m.thinkingBlocks)
      if (m.content) blocks.push({ type: 'text', text: m.content })
      for (const tc of m.toolCalls || []) blocks.push({ type: 'tool_use', id: sanitizeId(tc.id), name: tc.name, input: safeParse(tc.args) })
      if (!blocks.length) blocks.push({ type: 'text', text: '(vazio)' })
      push('assistant', blocks)
    } else if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: sanitizeId(m.toolCallId), content: m.content || '(sem saída)' }
      if (m.isError) block.is_error = true
      push('user', [block])
    }
  }
  // tool_result precisa vir antes de texto dentro da mesma mensagem do usuário
  for (const msg of out) {
    if (msg.role === 'user' && msg.content.some((b) => b.type === 'tool_result')) {
      msg.content.sort((a, b) => Number(b.type === 'tool_result') - Number(a.type === 'tool_result'))
    }
  }
  if (out[0]?.role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '(início da conversa)' }] })
  const last = out[out.length - 1]
  if (last) {
    const block = last.content[last.content.length - 1]
    if (block && block.type !== 'thinking' && block.type !== 'redacted_thinking') block.cache_control = EPHEMERAL
  }
  return out
}

export function normalizeAnthropicUsage(u) {
  if (!u) return null
  return {
    input: u.input_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheWrite: u.cache_creation_input_tokens || 0,
    output: u.output_tokens || 0,
    reasoning: 0,
  }
}

export async function streamAnthropic({ provider, model, apiKey, system, messages, tools, signal, maxTokens, temperature, thinking, effort, onEvent = () => {} }) {
  const url = `${provider.baseURL.replace(/\/+$/, '')}/messages`
  const max = maxTokens || Math.min(model.maxOutput || 32000, 32000)
  const desired = effort && effort !== 'auto' ? ({ low: 2048, medium: 8000, high: 16000, max: 24000 }[effort] || 8000) : thinking?.enabled ? Math.max(1024, thinking.budget || 8000) : 0
  const budget = desired && max > 2048 ? Math.min(desired, max - 1024) : 0
  const body = {
    model: model.id,
    max_tokens: max,
    stream: true,
    messages: toAnthropicMessages(messages, { keepThinking: !!budget }),
  }
  if (system) body.system = [{ type: 'text', text: system, cache_control: EPHEMERAL }]
  if (tools?.length) {
    body.tools = tools.map((t, i) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
      ...(i === tools.length - 1 ? { cache_control: EPHEMERAL } : {}),
    }))
  }
  if (budget) body.thinking = { type: 'enabled', budget_tokens: budget }
  else if (temperature != null) body.temperature = temperature

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'user-agent': `snake-harness/${VERSION}`,
      ...(provider.headers || {}),
    },
    body: JSON.stringify(body),
    signal,
  })
  captureLimits(model, res.headers, onEvent)
  if (!res.ok) throw await errorFromResponse(res, provider.id)

  const blocks = []
  let usage = {}
  let stop = null
  let responseModel = null
  for await (const ev of sseEvents(res.body)) {
    let data
    try {
      data = JSON.parse(ev.data)
    } catch {
      continue
    }
    switch (data.type) {
      case 'message_start':
        usage = { ...(data.message?.usage || {}) }
        responseModel = data.message?.model
        break
      case 'content_block_start': {
        const b = { ...data.content_block }
        if (b.type === 'text') b.text = b.text || ''
        if (b.type === 'thinking') b.thinking = b.thinking || ''
        if (b.type === 'tool_use') {
          b.partial = ''
          onEvent({ type: 'toolcall-start', index: data.index })
          onEvent({ type: 'toolcall-name', index: data.index, name: b.name })
        }
        blocks[data.index] = b
        if (b.type === 'text' && b.text) onEvent({ type: 'text', delta: b.text })
        break
      }
      case 'content_block_delta': {
        const b = blocks[data.index]
        const d = data.delta || {}
        if (!b) break
        if (d.type === 'text_delta') {
          b.text += d.text
          onEvent({ type: 'text', delta: d.text })
        } else if (d.type === 'input_json_delta') {
          b.partial += d.partial_json
          onEvent({ type: 'toolcall-delta', index: data.index, name: b.name, length: b.partial.length })
        } else if (d.type === 'thinking_delta') {
          b.thinking += d.thinking
          onEvent({ type: 'reasoning', delta: d.thinking })
        } else if (d.type === 'signature_delta') {
          b.signature = (b.signature || '') + d.signature
        }
        break
      }
      case 'message_delta':
        if (data.delta?.stop_reason) stop = data.delta.stop_reason
        if (data.usage) Object.assign(usage, Object.fromEntries(Object.entries(data.usage).filter(([, v]) => v != null)))
        break
      case 'error': {
        const e = data.error || {}
        throw new ProviderError(`anthropic: ${e.message || e.type || 'erro no stream'}`, {
          provider: provider.id,
          status: e.type === 'overloaded_error' ? 529 : e.type === 'rate_limit_error' ? 429 : 500,
          code: e.type || '',
        })
      }
      default:
        break
    }
  }

  const list = blocks.filter(Boolean)
  const text = list
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
  const toolCalls = list
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, args: b.partial || JSON.stringify(b.input || {}) }))
  const thinkingBlocks = list
    .filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking')
    .map((b) => (b.type === 'thinking' ? { type: 'thinking', thinking: b.thinking, signature: b.signature || '' } : { type: 'redacted_thinking', data: b.data }))
  const reasoning = list
    .filter((b) => b.type === 'thinking')
    .map((b) => b.thinking)
    .join('\n')
  return {
    message: {
      role: 'assistant',
      content: text,
      reasoning: reasoning || undefined,
      thinkingBlocks: thinkingBlocks.length ? thinkingBlocks : undefined,
      toolCalls: toolCalls.length ? toolCalls : undefined,
    },
    usage: normalizeAnthropicUsage(usage),
    finishReason: stop === 'tool_use' ? 'tool_calls' : stop === 'max_tokens' ? 'length' : stop,
    responseModel,
  }
}
