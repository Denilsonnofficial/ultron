import readline from 'node:readline'
import { Runner } from './runner.js'
import { Session } from './agent/session.js'
import { VERSION, PERMISSION_MODES } from './config.js'

// ACP v1 estável, JSON-RPC delimitado por LF. stdout é exclusivo do protocolo.
export async function runAcp({ config, catalog, cwd, input = process.stdin, output = process.stdout }) {
  const send = (msg) => output.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
  const update = (sessionId, value) => send({ method: 'session/update', params: { sessionId, update: value } })
  const pending = new Map(); let next = 0, initialized = false
  const clientRequest = (method, params, signal) => new Promise((resolve, reject) => {
    const id = `snake-${++next}`
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); pending.delete(id) }
    const abort = () => { finish(); resolve({ outcome: { outcome: 'cancelled' } }) }
    const timer = setTimeout(() => { finish(); reject(new Error('Cliente ACP não respondeu')) }, 300000)
    pending.set(id, { resolve, reject, finish }); signal?.addEventListener('abort', abort, { once: true })
    send({ id, method, params }); if (signal?.aborted) abort()
  })
  const runner = new Runner({ config, catalog, cwd,
    emit: (id, type, data) => {
      if (type === 'stream' && ['text', 'reasoning'].includes(data.type)) update(id, { sessionUpdate: data.type === 'text' ? 'agent_message_chunk' : 'agent_thought_chunk', content: { type: 'text', text: data.delta } })
      if (type === 'tool-start') update(id, { sessionUpdate: 'tool_call', toolCallId: data.call.id, title: data.summary || data.call.name, kind: ['read', 'grep', 'glob'].includes(data.call.name) ? 'read' : ['write', 'edit'].includes(data.call.name) ? 'edit' : 'other', status: 'in_progress', rawInput: data.args })
      if (type === 'tool-end') update(id, { sessionUpdate: 'tool_call_update', toolCallId: data.call.id, status: data.result.isError ? 'failed' : 'completed', content: [{ type: 'content', content: { type: 'text', text: String(data.result.output || '') } }] })
      if (type === 'notice') update(id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `\n${data.text}\n` } })
    },
    askPermission: async (id, req) => {
      const result = await clientRequest('session/request_permission', { sessionId: id, toolCall: { toolCallId: req.call.id, title: req.summary, status: 'pending', rawInput: req.args }, options: [{ optionId: 'allow', name: 'Permitir uma vez', kind: 'allow_once' }, { optionId: 'always', name: 'Permitir nesta sessão', kind: 'allow_always' }, { optionId: 'deny', name: 'Recusar', kind: 'reject_once' }] }, runner.get(id).controller?.signal)
      return result?.outcome?.outcome === 'selected' ? result.outcome.optionId : 'deny'
    },
  })
  const mcpConfigs = (servers = []) => Object.fromEntries(servers.map((server) => [server.name, server.url ? { url: server.url, headers: Object.fromEntries((server.headers || []).map((h) => [h.name, h.value])) } : { command: server.command, args: server.args || [], env: Object.fromEntries((server.env || []).map((e) => [e.name, e.value])) }]))
  const modes = (entry) => ({ currentModeId: entry.agent.mode, availableModes: PERMISSION_MODES.map((id) => ({ id, name: id })) })
  const handle = async (msg) => {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') { send({ id: msg?.id ?? null, error: { code: -32600, message: 'Invalid Request' } }); return }
    if (!msg.method) { const p = pending.get(msg.id); if (p) { p.finish(); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result) } return }
    const p = msg.params || {}
    let result
    try {
      if (!initialized && msg.method !== 'initialize') throw Object.assign(new Error('Initialize first'), { code: -32002 })
      switch (msg.method) {
        case 'initialize':
          initialized = true
          result = { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true, image: false, audio: false }, mcpCapabilities: { http: true, sse: false } }, agentInfo: { name: 'snake', version: VERSION }, authMethods: [] }; break
        case 'session/new': {
          const s = runner.create({ cwd: p.cwd || cwd, mcp: mcpConfigs(p.mcpServers) }); result = { sessionId: s.id, modes: modes(runner.get(s.id)) }; break
        }
        case 'session/load': {
          const entry = runner.get(p.sessionId)
          for (const m of entry.session.messages) if (['user', 'assistant'].includes(m.role) && m.content) update(p.sessionId, { sessionUpdate: m.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk', content: { type: 'text', text: m.content } })
          result = { modes: modes(entry) }; break
        }
        case 'session/set_mode': {
          if (!PERMISSION_MODES.includes(p.modeId)) throw new Error('Modo inválido')
          runner.get(p.sessionId).agent.mode = p.modeId; result = {}; break
        }
        case 'session/prompt': {
          if (!Array.isArray(p.prompt)) throw new Error('prompt deve ser uma lista de blocos')
          const text = p.prompt.map((b) => { if (b.type === 'text') return b.text; if (b.type === 'resource_link') return `[Recurso ${b.name || ''}] ${b.uri}`; if (b.type === 'resource' && typeof b.resource?.text === 'string') return `[${b.resource.uri}]\n${b.resource.text}`; throw new Error(`Conteúdo ACP não suportado: ${b.type}`) }).join('\n')
          const r = await runner.prompt(p.sessionId, text); result = { stopReason: r.stopReason }; break
        }
        case 'session/cancel': runner.cancel(p.sessionId); result = {}; break
        case 'session/list': result = { sessions: Session.list().map((s) => ({ sessionId: s.id, cwd: s.cwd, title: s.title, updatedAt: new Date(s.updated).toISOString() })) }; break
        default: throw Object.assign(new Error(`Method not found: ${msg.method}`), { code: -32601 })
      }
      if (msg.id != null) send({ id: msg.id, result })
    } catch (e) { if (msg.id != null) send({ id: msg.id, error: { code: e.code || -32602, message: e.message } }) }
  }
  const rl = readline.createInterface({ input, crlfDelay: Infinity })
  const jobs = new Set()
  for await (const line of rl) {
    let value; try { value = JSON.parse(line) } catch { send({ id: null, error: { code: -32700, message: 'Parse error' } }); continue }
    const job = (async () => { for (const item of Array.isArray(value) ? value : [value]) await handle(item) })()
    jobs.add(job); job.finally(() => jobs.delete(job))
  }
  for (const entry of runner.entries.values()) entry.controller?.abort()
  for (const p of pending.values()) { p.finish(); p.resolve({ outcome: { outcome: 'cancelled' } }) }
  await Promise.allSettled(jobs); await runner.close(); return 0
}
