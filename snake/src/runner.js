import fs from 'node:fs'
import path from 'node:path'
import { Agent } from './agent/agent.js'
import { Session } from './agent/session.js'
import { deepMerge, findProjectConfig } from './config.js'
import { McpManager } from './mcp/client.js'

export class Runner {
  constructor({ config, catalog, cwd, emit = () => {}, askPermission, askQuestion }) { Object.assign(this, { config, catalog, cwd, emit, askPermission, askQuestion }); this.entries = new Map() }
  create({ cwd = this.cwd, model = this.catalog.defaultRef(this.config), mcp } = {}) {
    cwd = path.resolve(cwd)
    if (!fs.statSync(cwd).isDirectory()) throw new Error('Diretório inválido')
    const session = Session.create({ cwd, model }); session.save()
    this.add(session, mcp); return session
  }
  add(session, mcpConfig) {
    if (this.entries.has(session.id)) return this.entries.get(session.id)
    const config = deepMerge(this.config, findProjectConfig(session.cwd)?.data || {})
    // Opções de invocação/servidor prevalecem sobre defaults; projeto continua disponível.
    config.providers = this.config.providers
    if (this.config.permissionMode) config.permissionMode = this.config.permissionMode
    const mcp = new McpManager(mcpConfig || config.mcp, { cwd: session.cwd })
    const agent = new Agent({ session, config, catalog: this.catalog, ui: {
      emit: (type, data) => this.emit(session.id, type, data),
      askPermission: this.askPermission && ((req) => this.askPermission(session.id, req)),
      askQuestion: this.askQuestion && ((req) => this.askQuestion(session.id, req)),
    } })
    const entry = { session, agent, mcp, active: null, controller: null }
    this.entries.set(session.id, entry); return entry
  }
  get(id) {
    if (this.entries.has(id)) return this.entries.get(id)
    const session = Session.load(id); if (!session) throw Object.assign(new Error('Sessão não encontrada'), { status: 404 })
    return this.add(session)
  }
  prompt(id, prompt) {
    const entry = this.get(id)
    if (entry.active) throw Object.assign(new Error('Sessão ocupada'), { status: 409 })
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Prompt vazio')
    entry.controller = new AbortController()
    const task = async () => {
      try {
        if (!entry.connected) { await entry.mcp.startAll(); entry.agent.extraTools = entry.mcp.tools(); entry.connected = true }
        await entry.agent.run(prompt, { signal: entry.controller.signal })
        return { stopReason: entry.controller.signal.aborted ? 'cancelled' : 'end_turn', result: [...entry.session.messages].reverse().find((m) => m.role === 'assistant')?.content || '', sessionId: id }
      } catch (e) {
        if (entry.controller.signal.aborted) return { stopReason: 'cancelled', sessionId: id }
        throw e
      } finally { entry.active = null; entry.controller = null }
    }
    entry.active = Promise.resolve().then(task)
    return entry.active
  }
  cancel(id) { this.get(id).controller?.abort() }
  async close(id) {
    const entries = id ? [this.get(id)] : [...this.entries.values()]
    for (const entry of entries) {
      entry.controller?.abort(); await entry.active?.catch(() => {}); entry.mcp.closeAll(); await entry.agent.close(); entry.session.save(); this.entries.delete(entry.session.id)
    }
  }
}
