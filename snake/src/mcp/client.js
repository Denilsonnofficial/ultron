// Cliente MCP (Model Context Protocol): servidores locais via stdio e remotos via HTTP (streamable).
// As ferramentas dos servidores viram ferramentas do agente com o nome mcp__<servidor>__<ferramenta>.

import { spawn } from 'node:child_process'
import { VERSION } from '../config.js'
import { sseEvents } from '../providers/sse.js'
import { mcpToken } from './oauth.js'

const PROTOCOL = '2025-06-18'

class StdioTransport {
  constructor({ command, args = [], env = {}, cwd }) {
    this.command = command
    this.args = args
    this.env = env
    this.cwd = cwd
    this.onMessage = () => {}
    this.onClose = () => {}
    this.stderr = ''
  }

  start() {
    this.child = spawn(this.command, this.args, { cwd: this.cwd, env: { ...process.env, ...this.env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let buf = ''
    this.child.stdout.on('data', (d) => {
      buf += d.toString('utf8')
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        try {
          this.onMessage(JSON.parse(line))
        } catch {}
      }
    })
    this.child.stderr.on('data', (d) => {
      this.stderr = (this.stderr + d.toString('utf8')).slice(-4000)
    })
    this.child.on('error', (e) => this.onClose(e))
    this.child.on('exit', (code) => this.onClose(new Error(`processo saiu (código ${code})${this.stderr ? ': ' + this.stderr.trim().split('\n').pop() : ''}`)))
  }

  send(msg) {
    if (!this.child?.stdin.writable) throw new Error('servidor MCP não está rodando')
    this.child.stdin.write(JSON.stringify(msg) + '\n')
  }

  close() {
    try {
      this.child?.kill('SIGTERM')
    } catch {}
  }
}

class HttpTransport {
  constructor({ url, headers = {} }) {
    this.url = url
    this.headers = headers
    this.sessionId = null
    this.onMessage = () => {}
    this.onClose = () => {}
  }

  start() {}

  send(msg) {
    this.post(msg).catch((err) => {
      if (msg.id != null) this.onMessage({ jsonrpc: '2.0', id: msg.id, error: { code: -1, message: err.cause?.code || err.message } })
    })
  }

  async post(msg) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL,
      ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
      ...this.headers,
    }
    const res = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(msg) })
    const sid = res.headers.get('mcp-session-id')
    if (sid) this.sessionId = sid
    if (res.status === 202 || res.status === 204) return
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      if (msg.id != null) this.onMessage({ jsonrpc: '2.0', id: msg.id, error: { code: res.status, message: `HTTP ${res.status} ${text.slice(0, 200)}` } })
      return
    }
    const ct = res.headers.get('content-type') || ''
    if (ct.includes('text/event-stream')) {
      for await (const ev of sseEvents(res.body)) {
        try {
          this.onMessage(JSON.parse(ev.data))
        } catch {}
      }
    } else {
      const j = await res.json()
      for (const m of Array.isArray(j) ? j : [j]) this.onMessage(m)
    }
  }

  close() {
    if (this.sessionId) fetch(this.url, { method: 'DELETE', headers: { 'Mcp-Session-Id': this.sessionId, ...this.headers } }).catch(() => {})
  }
}

function sanitize(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_')
}

export function resultToText(res) {
  const parts = []
  for (const c of res?.content || []) {
    if (c.type === 'text') parts.push(c.text)
    else if (c.type === 'image') parts.push(`[imagem ${c.mimeType || ''}]`)
    else if (c.type === 'audio') parts.push(`[áudio ${c.mimeType || ''}]`)
    else if (c.type === 'resource') parts.push(c.resource?.text ?? `[recurso ${c.resource?.uri}]`)
    else if (c.type === 'resource_link') parts.push(`[link ${c.uri}${c.name ? ` — ${c.name}` : ''}]`)
    else parts.push(JSON.stringify(c))
  }
  if (!parts.length && res?.structuredContent) parts.push(JSON.stringify(res.structuredContent, null, 2))
  return parts.join('\n') || '(sem conteúdo)'
}

export class McpClient {
  constructor(name, cfg, { cwd = process.cwd() } = {}) {
    this.name = name
    this.cfg = cfg
    this.cwd = cwd
    this.pending = new Map()
    this.nextId = 1
    this.tools = []
    this.status = 'parado'
    this.error = ''
    this.serverInfo = null
    this.transport = cfg.url ? new HttpTransport({ url: cfg.url, headers: cfg.headers }) : new StdioTransport({ command: cfg.command, args: cfg.args, env: cfg.env, cwd: cfg.cwd || cwd })
    this.transport.onMessage = (m) => this.handle(m)
    this.transport.onClose = (err) => {
      this.status = 'erro'
      this.error = err?.message || 'encerrado'
      for (const p of this.pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error(`MCP ${this.name}: ${this.error}`))
      }
      this.pending.clear()
    }
  }

  handle(msg) {
    if (msg.id != null && (msg.result !== undefined || msg.error) && !msg.method) {
      const p = this.pending.get(msg.id)
      if (!p) return
      clearTimeout(p.timer)
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(`MCP ${this.name}: ${msg.error.message || JSON.stringify(msg.error)}`))
      else p.resolve(msg.result)
      return
    }
    if (msg.method && msg.id != null) {
      if (msg.method === 'ping') this.transport.send({ jsonrpc: '2.0', id: msg.id, result: {} })
      else if (msg.method === 'roots/list') this.transport.send({ jsonrpc: '2.0', id: msg.id, result: { roots: [{ uri: `file://${this.cwd}`, name: 'workspace' }] } })
      else this.transport.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } })
      return
    }
    if (msg.method === 'notifications/tools/list_changed') this.listTools().catch(() => {})
  }

  request(method, params = {}, { timeout = 60000, signal } = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP ${this.name}: tempo esgotado em ${method}`))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      signal?.addEventListener(
        'abort',
        () => {
          if (!this.pending.has(id)) return
          clearTimeout(timer)
          this.pending.delete(id)
          try {
            this.notify('notifications/cancelled', { requestId: id, reason: 'interrompido pelo usuário' })
          } catch {}
          reject(new DOMException('Interrompido', 'AbortError'))
        },
        { once: true },
      )
      try {
        this.transport.send({ jsonrpc: '2.0', id, method, params })
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err)
      }
    })
  }

  notify(method, params = {}) {
    this.transport.send({ jsonrpc: '2.0', method, params })
  }

  async connect() {
    this.status = 'conectando'
    try {
      if (this.cfg.url) {
        const token = await mcpToken(this.name, this.cfg)
        if (token) this.transport.headers = { ...this.transport.headers, Authorization: `Bearer ${token}` }
      }
      this.transport.start()
      const init = await this.request(
        'initialize',
        { protocolVersion: PROTOCOL, capabilities: { roots: { listChanged: false } }, clientInfo: { name: 'snake', version: VERSION } },
        { timeout: this.cfg.timeout || 30000 },
      )
      this.serverInfo = init?.serverInfo || null
      this.notify('notifications/initialized')
      await this.listTools()
      this.status = 'ok'
    } catch (err) {
      this.status = 'erro'
      this.error = err.message
      this.close()
    }
    return this
  }

  async listTools() {
    const tools = []
    let cursor
    do {
      const res = await this.request('tools/list', cursor ? { cursor } : {})
      tools.push(...(res?.tools || []))
      cursor = res?.nextCursor
    } while (cursor)
    this.tools = tools
    return tools
  }

  async callTool(name, args, { signal } = {}) {
    return this.request('tools/call', { name, arguments: args || {} }, { timeout: this.cfg.toolTimeout || 300000, signal })
  }

  /** Ferramentas no formato do agente. */
  agentTools() {
    const server = sanitize(this.name)
    return this.tools.map((tool) => ({
      name: `mcp__${server}__${sanitize(tool.name)}`.slice(0, 64),
      label: `${this.name}:${tool.name}`,
      readOnly: !!tool.annotations?.readOnlyHint,
      mcp: true,
      description: `[MCP ${this.name}] ${tool.description || tool.title || tool.name}`.slice(0, 1024),
      parameters: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} },
      summary: (args) => {
        const s = JSON.stringify(args || {})
        return s.length > 80 ? s.slice(0, 79) + '…' : s
      },
      run: async (args, ctx) => {
        try {
          const res = await this.callTool(tool.name, args, { signal: ctx.signal })
          const text = resultToText(res)
          return { output: text.length > 50000 ? text.slice(0, 50000) + '\n…[truncado]' : text, isError: !!res?.isError, display: { summary: res?.isError ? 'erro' : `${text.split('\n').length} linha(s)`, output: text } }
        } catch (err) {
          return { output: `Erro MCP: ${err.message}`, isError: true }
        }
      },
    }))
  }

  close() {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(`MCP ${this.name}: conexão encerrada`)) }
    this.pending.clear()
    this.transport.close()
  }
}

export class McpManager {
  constructor(configs = {}, { cwd } = {}) {
    this.clients = Object.entries(configs)
      .filter(([, cfg]) => cfg && cfg.enabled !== false && (cfg.command || cfg.url))
      .map(([name, cfg]) => new McpClient(name, cfg, { cwd }))
  }

  get size() {
    return this.clients.length
  }

  async startAll() {
    await Promise.all(this.clients.map((c) => c.connect()))
    return this
  }

  tools() {
    return this.clients.filter((c) => c.status === 'ok').flatMap((c) => c.agentTools())
  }

  closeAll() {
    for (const c of this.clients) c.close()
  }
}
