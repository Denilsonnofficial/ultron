// Loop do agente: conversa com o modelo, executa ferramentas, contabiliza tokens e compacta o contexto.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { deepMerge, paths, saveConfig } from '../config.js'
import { discoverAgents, discoverSkills } from './resources.js'
import { EDIT_TOOLS, permissionDecision, permissionTarget } from './permissions.js'
import { beginSnapshot, finishSnapshot, restoreSnapshots } from './snapshots.js'
import { Extensions } from './extensions.js'
import { resolvePath, truncateMiddle } from '../tools/util.js'
import { limitOutput } from '../tools/output.js'
import { withDiagnostics } from '../tools/diagnostics.js'
import { LspManager } from '../tools/lsp.js'
import { TerminalManager } from '../tools/pty.js'
import { DEFAULT_CONTEXT } from '../providers/catalog.js'
import { isAbortError, streamWithRetry } from '../providers/index.js'
import { findTool, getTools } from '../tools/index.js'
import { buildSystemPrompt, findInstructionFiles } from './prompt.js'
import { Session } from './session.js'
import { estimateMessagesTokens, estimateTokens } from './usage.js'

export function abortError() {
  return new DOMException('Interrompido pelo usuário', 'AbortError')
}

/** Fecha strings, objetos e listas abertos de um JSON truncado (comum em modelos grátis). */
export function repairJSON(s) {
  const stack = []
  let inStr = false
  let esc = false
  for (const ch of s) {
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') stack.push('}')
    else if (ch === '[') stack.push(']')
    else if ((ch === '}' || ch === ']') && stack[stack.length - 1] === ch) stack.pop()
  }
  let out = s
  if (inStr) out += esc ? '\\"' : '"'
  out = out.replace(/\s+$/, '')
  if (out.endsWith(',')) out = out.slice(0, -1)
  else if (out.endsWith(':')) out += 'null'
  return out + stack.reverse().join('')
}

export function parseArgs(raw) {
  if (raw == null || raw === '') return {}
  if (typeof raw === 'object') return raw
  const s = String(raw).trim()
  if (!s) return {}
  const attempts = [s]
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a !== -1 && b > a) attempts.push(s.slice(a, b + 1))
  if (a !== -1) attempts.push(repairJSON(s.slice(a)))
  for (const candidate of attempts) {
    try {
      const v = JSON.parse(candidate)
      if (v && typeof v === 'object' && !Array.isArray(v)) return v
    } catch {}
  }
  return null
}

function renderTranscript(messages, maxChars) {
  const parts = []
  for (const m of messages) {
    if (m.role === 'user') parts.push(`## Usuário\n${m.content}`)
    else if (m.role === 'assistant') {
      let s = `## Assistente\n${m.content || ''}`
      for (const tc of m.toolCalls || []) s += `\n[chamou ${tc.name}(${String(tc.args).slice(0, 600)})]`
      parts.push(s)
    } else if (m.role === 'tool') {
      const c = String(m.content || '')
      parts.push(`## Resultado de ${m.name}\n${c.length > 2000 ? c.slice(0, 1500) + '\n…\n' + c.slice(-400) : c}`)
    }
  }
  let text = parts.join('\n\n')
  if (text.length > maxChars) {
    const head = text.slice(0, Math.floor(maxChars * 0.25))
    const tail = text.slice(-Math.floor(maxChars * 0.7))
    text = `${head}\n\n… [parte intermediária omitida] …\n\n${tail}`
  }
  return text
}

const PRUNED = '[saída antiga omitida para economizar contexto — rode a ferramenta de novo se precisar dela]'

/**
 * Poda de saídas antigas (como no OpenCode): preserva as ~40k tokens de saída de ferramenta mais recentes e
 * troca as anteriores por um aviso curto, desde que isso libere pelo menos ~20k tokens. Roda no fim do
 * turno, então o prefixo enviado ao provedor muda no máximo uma vez por turno (bom para o cache).
 */
export function pruneToolOutputs(messages, { protect = 40000, minimum = 20000 } = {}) {
  let seen = 0
  const candidates = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'tool' || m.pruned || m.name === 'skill') continue
    const tokens = estimateTokens(m.content)
    seen += tokens
    if (seen > protect) candidates.push([m, tokens])
  }
  const freed = candidates.reduce((n, [, tokens]) => n + tokens, 0)
  if (freed < minimum) return 0
  for (const [m] of candidates) { m.content = PRUNED; m.pruned = true }
  return freed
}

export class Agent {
  constructor({ session, config, catalog, ui = {}, extraTools = [], subagent = false }) {
    this.session = session
    this.config = config
    this.catalog = catalog
    this.ui = ui
    this.extraTools = extraTools
    this.subagent = subagent
    this.mode = config.permissionMode || 'yolo'
    this.alwaysAllow = new Set()
    this.checkpoints = []
    this.readFiles = new Map()
    this.notes = []
    this.busy = false
    this.sessionRules = {}
    this.extensions = new Extensions(session.cwd, config)
    this.activeJobs = 0
    this.jobWaiters = []
    this.lsp = new LspManager(session.cwd, config.lsp)
    this.terminal = config.bgJobs !== false ? new TerminalManager(session, (job, chunk) => this.emit('terminal-output', { id: job.id, chunk })) : null
    if (!session.goal && config.goal?.status === 'active') session.goal = structuredClone(config.goal)
    if (!session.messages.length && config.agent) session.agent = config.agent
  }

  async initialize() {
    if (!this.ready) this.ready = this.extensions.load().then(async () => {
      this.emit('extensions', { commands: this.extensions.commands })
      for (const text of this.extensions.errors) this.emit('notice', { level: 'warn', text })
      await this.hook('sessionStart', { session: this.session.id })
    })
    await this.ready
  }
  async hook(name, data, signal) {
    const errors = await this.extensions.event(name, { session: this.session.id, cwd: this.session.cwd, ...data }, signal)
    for (const text of errors) this.emit('notice', { level: 'warn', text })
  }
  async close() { await this.hook('sessionEnd', {}); this.lsp?.close(); this.terminal?.closeAll() }
  recordUsage(ref, usage, options) {
    const entry = this.usage.record(ref, usage, options)
    this.ui.recordUsage?.(ref, usage, { ...options, updateContext: false })
    if (!this.subagent) {
      try { fs.mkdirSync(paths.home, { recursive: true }); fs.appendFileSync(paths.history, JSON.stringify({ type: 'usage', at: Date.now(), session: this.session.id, model: ref, ...entry }) + '\n', { mode: 0o600 }) } catch {}
    }
    return entry
  }
  agentDefinition() { return discoverAgents(this.session.cwd).find((a) => a.name === this.session.agent) || discoverAgents(this.session.cwd)[0] }

  get usage() {
    return this.session.usage
  }

  get model() {
    const ref = this.session.model || this.catalog.defaultRef(this.config)
    if (!ref) return { provider: 'none', id: 'selecione um modelo', name: 'Nenhum modelo selecionado', context: DEFAULT_CONTEXT, tools: false, free: false, pricing: null }
    const found = this.catalog.find(ref)
    if (found) return found
    const slash = ref.indexOf('/')
    return this.catalog.unknown(slash > 0 ? ref.slice(0, slash) : 'openrouter', slash > 0 ? ref.slice(slash + 1) : ref)
  }

  get modelRef() {
    const m = this.model
    return `${m.provider}/${m.id}`
  }

  emit(type, data = {}) {
    try {
      this.ui.emit?.(type, data)
    } catch {}
  }

  tools() {
    const definition = this.agentDefinition()
    const tools = getTools({ mode: definition.permission === 'plan' ? 'plan' : this.mode, disabled: this.config.disabledTools || [], extra: [...this.extraTools, ...this.extensions.tools, ...(this.lsp?.tools() || []), ...(this.terminal?.tools() || [])], subagent: this.subagent })
    return tools.filter((t) => !definition.tools || (Array.isArray(definition.tools) ? definition.tools.includes(t.name) : definition.tools[t.name] !== false))
  }

  /**
   * Prompt de sistema estável entre requisições (importante para o cache de prefixo/KV do provedor):
   * só é refeito quando muda o modo, o modelo, a pasta ou algum arquivo de instruções.
   */
  systemPrompt(model = this.model) {
    const cwd = this.session.cwd
    const stamp = findInstructionFiles(cwd)
      .map((f) => {
        try {
          return `${f}:${fs.statSync(f).mtimeMs}`
        } catch {
          return f
        }
      })
      .join(',')
    const skills = discoverSkills(cwd)
    const definition = this.agentDefinition()
    const key = [this.mode, model.provider, model.id, cwd, stamp, this.subagent, JSON.stringify([skills, definition, this.session.goal, this.session.skills, this.config.outputStyle, this.config.extraDirs])].join('|')
    if (this._system?.key === key) return this._system.text
    const text = buildSystemPrompt({ cwd, modelLabel: `${model.name || model.id} (${model.provider}/${model.id})`, mode: definition.permission === 'plan' ? 'plan' : this.mode, subagent: this.subagent, skills, activeSkills: this.session.skills, definition, goal: this.session.goal, outputStyle: this.config.outputStyle, extraDirs: this.config.extraDirs })
    this._system = { key, text }
    return text
  }

  contextLimit(model = this.model) {
    return model.context || DEFAULT_CONTEXT
  }

  /** Estimativa do contexto que será enviado na próxima requisição. */
  estimateContext(model = this.model, system = this.systemPrompt(model)) {
    const sys = estimateTokens(system)
    const tools = estimateTokens(JSON.stringify(this.tools().map((t) => [t.name, t.description, t.parameters])))
    return { system: sys, tools, messages: estimateMessagesTokens(this.session.messages) }
  }

  maxTokens(model, system) {
    const cfg = this.config.maxOutputTokens || 32000
    let max = Math.min(cfg, model.maxOutput || cfg)
    const e = this.estimateContext(model, system)
    const used = Math.max(this.usage.contextTokens, e.system + e.tools + e.messages)
    const room = this.contextLimit(model) - used - 1024
    if (room < 1) throw new Error('Contexto cheio. Use /compact, uma nova sessão ou um modelo com janela maior.')
    if (room < max) max = Math.max(1, Math.floor(room))
    return max
  }

  toolContext(signal, checkpoint, call) {
    const agent = this
    return {
      get cwd() {
        return agent.session.cwd
      },
      setCwd(dir) {
        agent.session.cwd = dir
        agent.emit('cwd', { cwd: dir })
      },
      signal,
      config: this.config,
      session: this.session,
      askQuestion: this.ui.askQuestion ? (args) => this.ui.askQuestion({ ...args, signal }) : null,
      checkpoint(abs, original) {
        if (!checkpoint.has(abs)) checkpoint.set(abs, original)
      },
      markRead(abs, mtime) {
        agent.readFiles.set(abs, mtime)
      },
      readAt(abs) {
        return agent.readFiles.get(abs)
      },
      notify(text) {
        agent.notify(text)
      },
      onProgress(chunk) {
        agent.emit('tool-progress', { call, chunk })
      },
      setTodos(todos) {
        agent.session.todos = todos
        agent.emit('todos', { todos })
      },
      runSubagent: this.subagent ? null : (args) => this.runSubagent(args, signal, call),
    }
  }

  async executeTool(call, signal, checkpoint) {
    const tools = this.tools()
    const tool = findTool(tools, call.name)
    if (!tool) {
      const result = { output: `Erro: ferramenta desconhecida "${call.name}". Ferramentas disponíveis: ${tools.map((t) => t.name).join(', ')}.`, isError: true }
      // mantém o histórico válido para APIs que validam nomes de função
      call.name = String(call.name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'desconhecida'
      this.emit('tool-start', { call, tool: null, args: {}, summary: '' })
      this.emit('tool-end', { call, tool: null, args: {}, result })
      return result
    }
    if (call.name !== tool.name) call.name = tool.name
    const rawArgs = call.args
    const args = parseArgs(rawArgs)
    // normaliza os argumentos guardados no histórico (JSON reparado ou vazio)
    call.args = args ? JSON.stringify(args) : '{}'
    const ctx = this.toolContext(signal, checkpoint, call)
    let summary = ''
    try {
      summary = args ? String(tool.summary?.(args, ctx) ?? '') : ''
    } catch {}
    this.emit('tool-start', { call, tool, args: args || {}, summary })
    let result
    if (!args) {
      result = { output: `Erro: os argumentos de ${tool.name} não são um JSON válido: ${String(rawArgs).slice(0, 300)}. Envie um objeto JSON válido.`, isError: true }
    } else if (this.mode === 'plan' && (!tool.readOnly || args.kill)) {
      result = { output: 'Bloqueado: modo plano (somente leitura). Apresente o plano ao usuário.', isError: true }
    } else {
      let decision = permissionDecision({ config: { ...this.config, permissions: deepMerge(this.config.permissions, typeof this.agentDefinition().permission === 'object' ? this.agentDefinition().permission : {}) }, mode: this.mode, tool, args, cwd: this.session.cwd, sessionRules: this.sessionRules })
      if (this.forceApproval && !tool.readOnly && decision !== 'deny') decision = 'ask'
      let allowed = decision !== 'deny'
      if (!allowed) result = { output: 'A regra de permissão negou esta ação. Não tente contornar a regra.', isError: true, denied: true }
      if (allowed && decision === 'ask' && !this.alwaysAllow.has(tool.name)) {
        const file = resolvePath(this.session.cwd, args.path || args.file_path || args.filePath)
        if (['edit', 'write', 'multiedit'].includes(tool.name) && fs.existsSync(file) && !this.readFiles.has(file)) summary += ' · arquivo não lido nesta sessão — confirme'
        await this.hook('permissionAsk', { tool: tool.name, args }, signal)
        const answer = (await this.ui.askPermission?.({ call, tool, args, summary, signal })) ?? 'deny'
        if (answer === 'always') this.alwaysAllow.add(tool.name)
        if (answer === 'pattern') {
          const pattern = permissionTarget(tool, args, this.session.cwd)
          this.sessionRules[tool.name] = { ...(this.sessionRules[tool.name] || {}), [pattern]: 'allow' }
        }
        if (!['allow', 'always', 'pattern'].includes(answer)) {
          allowed = false
          result = { output: 'O usuário negou esta ação. Não repita a mesma chamada; siga outra abordagem ou pergunte ao usuário.', isError: true, denied: true }
        }
      }
      if (allowed) {
        const started = Date.now()
        try {
          await this.hook('toolStart', { tool: tool.name, args }, signal)
          result = await tool.run(args, ctx)
          if (!result.isError && EDIT_TOOLS.includes(tool.name)) {
            const files = (tool.name === 'apply_patch' ? (result.display?.files || []).filter((l) => !l.startsWith('D ')).map((l) => l.replace(/^[AM] /, '').replace(/ \(movido de .*\)$/, '')) : [args.path || args.file_path || args.filePath]).map((f) => resolvePath(this.session.cwd, f))
            for (const f of files) {
              try { await this.extensions.format(f, signal) } catch (e) { this.emit('notice', { level: 'warn', text: e.message }) }
            }
            if (this.config.diagnostics !== false) result = await withDiagnostics(result, files)
          }
        } catch (err) {
          result = { output: `Erro ao executar ${tool.name}: ${err.message}`, isError: true }
        }
        result.elapsedMs = Date.now() - started
      }
    }
    this.session.event('tool', { name: tool.name, isError: !!result.isError, elapsedMs: result.elapsedMs })
    await this.hook('toolEnd', { tool: tool.name, isError: !!result.isError, elapsedMs: result.elapsedMs }, signal)
    this.emit('tool-end', { call, tool, args: args || {}, result })
    return result
  }

  async runSubagent(args, signal, call) {
    if (this.activeJobs >= (this.config.maxParallelSubagents || 3)) await new Promise((resolve, reject) => {
      const abort = () => { const i = this.jobWaiters.indexOf(ready); if (i >= 0) this.jobWaiters.splice(i, 1); reject(abortError()) }
      const ready = () => { signal?.removeEventListener('abort', abort); resolve() }
      this.jobWaiters.push(ready); signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
    if (signal?.aborted) throw abortError()
    this.activeJobs++
    try { return await this.runChild(args, signal, call) }
    finally { this.activeJobs--; this.jobWaiters.shift()?.() }
  }

  async runChild(args, signal, call) {
    const prompt = String(args.prompt || args.description)
    const definition = discoverAgents(this.session.cwd).find((a) => a.name === (args.subagent_type || 'general') && a.mode !== 'primary')
    if (!definition) throw new Error(`Tipo de subagente desconhecido: ${args.subagent_type}`)
    let job = args.job_id && this.session.jobs.find((j) => j.id === args.job_id)
    if (args.job_id && !job) throw new Error('Job não encontrado nesta sessão')
    const session = (job && Session.load(job.sessionId)) || Session.create({ cwd: this.session.cwd, model: definition.model || this.session.model, ephemeral: this.session.ephemeral })
    session.parentId = this.session.id
    session.agent = definition.name
    job ||= { id: crypto.randomUUID(), sessionId: session.id, parentMessageId: call?.id, type: definition.name, prompt, created: Date.now(), status: 'queued' }
    if (!this.session.jobs.includes(job)) this.session.jobs.push(job)
    job.status = 'running'; this.session.save()
    this.emit('sub-job-start', { job })
    const sub = new Agent({
      session,
      config: { ...this.config, agent: definition.name, snapshots: false, permissions: deepMerge(this.config.permissions, typeof definition.permission === 'object' ? definition.permission : {}) },
      catalog: this.catalog,
      extraTools: this.extraTools,
      subagent: true,
      ui: {
        emit: (type, data) => this.emit('sub', { parent: call, type, data }),
        askPermission: this.ui.askPermission,
        recordUsage: (ref, usage, options) => this.recordUsage(ref, usage, options),
      },
    })
    sub.mode = this.mode === 'plan' || definition.permission === 'plan' ? 'plan' : this.mode
    sub.alwaysAllow = this.alwaysAllow
    try {
      await sub.run(prompt, { signal })
      job.status = signal?.aborted ? 'failed' : 'done'
    } catch (e) { job.status = 'failed'; job.error = e.message; throw e }
    finally { job.finished = Date.now(); session.save(); this.session.save(); this.emit('sub-job-end', { job }); await sub.close() }
    const last = [...session.messages].reverse().find((m) => m.role === 'assistant' && m.content)
    const tools = session.messages.filter((m) => m.role === 'tool').length
    return {
      output: last?.content || '(o subagente terminou sem relatório)',
      display: { summary: `${definition.name} · ${job.id.slice(0, 8)} · ${tools} ferramenta(s)`, report: truncateMiddle(last?.content || '', 12000) },
    }
  }

  async maybeCompact(signal) {
    if (!this.config.autoCompact || this.subagent) return
    if (this.session.messages.length < 6) return
    const model = this.model
    const e = this.estimateContext(model)
    const current = Math.max(this.usage.contextTokens, e.system + e.tools + e.messages)
    if (current < this.contextLimit(model) * (this.config.compactThreshold || 0.85)) return
    await this.compact({ signal, auto: true })
  }

  /** Resume a conversa para liberar contexto. */
  async compact({ signal, instructions = '', auto = false } = {}) {
    const model = this.model
    const before = this.session.messages.length
    if (!before) return null
    this.emit('compact-start', { auto, model })
    await this.hook('compactStart', { auto }, signal)
    const maxChars = Math.floor(this.contextLimit(model) * 0.6 * 4)
    const transcript = renderTranscript(this.session.messages, Math.max(20000, maxChars))
    const prompt = `Summarize the coding session below so that another AI agent can seamlessly continue the work in a new context window. Write the summary in the same language the user used. Include:
1. The user's goals and explicit requests (quote important ones verbatim)
2. Key decisions, constraints and user preferences
3. Files created, modified or inspected (with paths) and the essential details of each change
4. Commands that were run and their important results (errors, test status)
5. Current state: what is done and what is in progress
6. Next steps / pending tasks
Be thorough but concise (at most ~1200 words).${instructions ? `\nAdditional instructions: ${instructions}` : ''}

<conversation>
${transcript}
</conversation>`
    const started = Date.now()
    const res = await streamWithRetry({
      model,
      system: 'You write precise, well-structured summaries of software engineering sessions.',
      messages: [{ role: 'user', content: prompt }],
      tools: [],
      signal,
      onEvent: (ev) => this.emit('compact-stream', ev),
    })
    const summary = (res.message.content || '').trim()
    if (!summary) throw new Error('o modelo devolveu um resumo vazio')
    const u = res.usage || { input: estimateTokens(prompt), output: estimateTokens(summary), cacheRead: 0, cacheWrite: 0 }
    this.recordUsage(`${model.provider}/${model.id}`, u, { pricing: model.pricing, free: model.free, apiMs: Date.now() - started, estimated: !res.usage, updateContext: false })
    const header = '[Contexto compactado — resumo da conversa anterior]'
    if (auto) {
      this.session.messages = [{ role: 'user', synthetic: true, content: `${header}\n\n${summary}\n\nContinue a tarefa em andamento a partir deste resumo.` }]
    } else {
      this.session.messages = [
        { role: 'user', synthetic: true, content: `${header}\n\n${summary}` },
        { role: 'assistant', content: 'Entendido. Tenho o resumo da conversa e vou continuar a partir dele.' },
      ]
    }
    const e = this.estimateContext(model)
    this.session.compactCount++
    this.session.summaries.push({ at: Date.now(), summary, instructions, auto })
    this.session.event('compact', { before, auto })
    this.usage.contextTokens = e.system + e.tools + e.messages
    this.session.save()
    this.emit('compact-end', { auto, summary, before, after: this.session.messages.length })
    await this.hook('compactEnd', { auto, summary }, signal)
    return summary
  }

  /** Desfaz as alterações de arquivo do último turno que mudou algo. */
  undo(n = 1) {
    return restoreSnapshots(this.session, n)
  }
  redo(n = 1) { return restoreSnapshots(this.session, n, true) }

  /**
   * Aviso assíncrono para o modelo (ex.: um processo em segundo plano terminou). Durante um turno ele entra
   * antes da próxima requisição; com o agente parado, a interface decide se inicia um turno com ele.
   */
  notify(text) {
    this.notes.push(String(text))
    this.emit('note', { text, busy: this.busy })
  }
  takeNotes() {
    const notes = this.notes.splice(0)
    for (const text of notes) this.session.messages.push({ role: 'user', synthetic: true, content: text })
    return notes.length
  }

  async aside(prompt, { signal, system, onEvent } = {}) {
    const model = this.model, started = Date.now()
    const res = await streamWithRetry({ model, system: system || this.systemPrompt(), messages: [{ role: 'user', content: prompt }], tools: [], signal, effort: this.config.effort, onEvent })
    this.recordUsage(this.modelRef, res.usage || { input: estimateTokens(prompt), output: estimateTokens(res.message.content) }, { pricing: model.pricing, free: model.free, estimated: !res.usage, apiMs: Date.now() - started, updateContext: false })
    this.session.save()
    return res.message.content || ''
  }

  /** Executa um turno completo a partir de uma mensagem do usuário. */
  async run(input, options = {}) {
    if (this.busy) throw new Error('Já existe um turno ativo nesta sessão')
    if (this.model.provider === 'none') throw new Error('Nenhum modelo verificado disponível. Selecione explicitamente com /models ou -m, ou execute snake check-models e snake bench.')
    this.busy = true
    try { await this.initialize(); return await this.runTurn(input, options) }
    finally { this.busy = false }
  }
  async runTurn(input, { signal = new AbortController().signal } = {}) {
    const s = this.session
    // input null: turno disparado por um aviso assíncrono (ex.: processo em segundo plano terminou)
    if (input != null) s.messages.push({ role: 'user', content: input })
    else if (!this.takeNotes()) return
    if (!s.title && input != null) s.title = String(input).replace(/\s+/g, ' ').slice(0, 70)
    s.event('turn-start', { model: this.modelRef })
    s.save()
    if (!this.subagent) this.usage.startTurn()
    const checkpoint = new Map()
    const before = this.config.snapshots !== false && !this.subagent ? await beginSnapshot(s.cwd) : null
    if (before?.error) this.emit('notice', { level: 'warn', text: `Snapshot indisponível neste turno (${before.error}); /undo cobre só write/edit.` })
    this.checkpoints.push(checkpoint)
    if (this.checkpoints.length > 30) this.checkpoints.shift()
    const turnStart = Date.now()
    const maxSteps = this.config.maxSteps || 100
    let lastSig = ''
    let repeats = 0
    let empties = 0
    let aborted = false
    this.emit('turn-start', { model: this.model })
    try {
      await this.hook('turnStart', { prompt: input }, signal)
      for (let step = 1; ; step++) {
        if (signal.aborted) throw abortError()
        if (s.goal?.status === 'active' && this.config.goalBudget > 0) {
          const spent = this.usage.total.input + this.usage.total.output + this.usage.total.cacheRead + this.usage.total.cacheWrite - (s.goal.startTokens || 0)
          if (spent >= this.config.goalBudget) {
            s.goal.status = 'budget_limited'; s.goal.spent = spent
            if (this.config.goal?.id === s.goal.id) { this.config.goal = s.goal; saveConfig({ goal: s.goal }) }
            this.emit('notice', { level: 'warn', text: 'Orçamento do objetivo atingido. Use /goal resume ou ajuste goalBudget.' }); break
          }
        }
        if (step > maxSteps) {
          this.emit('notice', { level: 'warn', text: `Limite de ${maxSteps} passos atingido neste turno. Envie "continue" para seguir.` })
          break
        }
        this.takeNotes()
        await this.maybeCompact(signal)
        const model = this.model
        const tools = this.tools()
        const system = this.systemPrompt(model)
        const reqStart = Date.now()
        let firstAt = 0
        let partial = ''
        let streamedChars = 0
        this.emit('request-start', { step, model })
        let res
        try {
          res = await streamWithRetry(
            {
              model,
              system,
              messages: s.messages,
              tools,
              signal,
              maxTokens: this.maxTokens(model, system),
              temperature: this.config.temperature ?? undefined,
              thinking: { enabled: !!this.config.thinking, budget: this.config.thinkingBudget },
              effort: this.config.effort,
              rateLimit: this.config.ratelimit?.[model.provider],
              firstByteTimeoutMs: this.config.firstByteTimeoutMs,
              idleTimeoutMs: this.config.streamIdleTimeoutMs,
              onEvent: (ev) => {
                if (ev.type === 'ratelimit') { this.usage.limits = ev; this.emit('ratelimit', ev); return }
                if (!firstAt) firstAt = Date.now()
                if (ev.type === 'text') partial += ev.delta
                if (ev.type === 'text' || ev.type === 'reasoning') streamedChars += ev.delta.length
                this.emit('stream', ev)
              },
            },
            { onRetry: (r) => this.emit('retry', r) },
          )
        } catch (err) {
          if (signal.aborted || isAbortError(err)) {
            if (partial.trim()) s.messages.push({ role: 'assistant', content: partial + '\n\n[resposta interrompida pelo usuário]', provider: model.provider, model: model.id })
            if (firstAt) {
              // a requisição foi processada em parte: registra uma estimativa do consumo
              const e = this.estimateContext(model, system)
              this.recordUsage(
                `${model.provider}/${model.id}`,
                { input: e.system + e.tools + e.messages, output: Math.ceil(streamedChars / 4), cacheRead: 0, cacheWrite: 0 },
                { pricing: model.pricing, free: !!model.free, apiMs: Date.now() - reqStart, estimated: true, updateContext: !this.subagent },
              )
            }
            throw abortError()
          }
          // erro no meio da resposta (provedor caiu ou parou): o texto já recebido não se perde
          if (partial.trim()) { s.messages.push({ role: 'assistant', content: partial + `\n\n[resposta interrompida: ${err.message}]`, provider: model.provider, model: model.id }); s.save() }
          throw err
        }
        const end = Date.now()
        const msg = { ...res.message, provider: model.provider, model: model.id }
        if (!msg.reasoning) delete msg.reasoning
        if (!msg.toolCalls) delete msg.toolCalls
        if (!msg.thinkingBlocks) delete msg.thinkingBlocks
        let u = res.usage
        const estimated = !u
        if (!u) {
          const e = this.estimateContext(model, system)
          u = {
            input: e.system + e.tools + e.messages,
            output: estimateTokens(msg.content) + estimateTokens(msg.reasoning) + (msg.toolCalls || []).reduce((n, tc) => n + estimateTokens(tc.args) + 8, 0),
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: estimateTokens(msg.reasoning),
          }
        }
        const rec = this.recordUsage(`${model.provider}/${model.id}`, u, {
          pricing: model.pricing,
          free: !!model.free,
          apiMs: end - reqStart,
          ttftMs: (firstAt || end) - reqStart,
          genMs: firstAt ? end - firstAt : 0,
          estimated,
          updateContext: !this.subagent,
        })
        s.messages.push(msg)
        this.emit('assistant', { message: msg, usage: rec, finishReason: res.finishReason, model, step })

        if (!msg.toolCalls?.length) {
          // Resposta vazia (comum em modelos de raciocínio grátis: pensam e param sem agir). Em vez de encerrar o
          // turno, tira a resposta vazia do histórico e pede para continuar — no máximo duas vezes.
          if (!msg.content?.trim() && res.finishReason !== 'length' && empties < 2) {
            empties++
            s.messages.pop()
            const thought = String(msg.reasoning || '').trim()
            s.messages.push({ role: 'user', synthetic: true, content: `[aviso automático do harness] Sua última resposta veio vazia (sem texto e sem chamada de ferramenta).${thought ? ` Seu raciocínio foi: "${thought.slice(-1500)}"` : ''} Continue a tarefa agora: chame as ferramentas necessárias ou responda ao usuário.` })
            this.emit('notice', { level: 'warn', text: `Resposta vazia do modelo — pedindo para continuar (${empties}/2).` })
            continue
          }
          if (this.mode === 'plan' || this.agentDefinition().permission === 'plan') s.plan = { text: msg.content, created: Date.now(), status: 'draft' }
          if (res.finishReason === 'length') this.emit('notice', { level: 'warn', text: 'A resposta foi cortada pelo limite de tokens de saída.' })
          if (!msg.content?.trim()) this.emit('notice', { level: 'warn', text: 'O modelo devolveu respostas vazias. Tente reformular ou trocar de modelo (/models).' })
          break
        }
        empties = 0

        const execute = async (call) => {
          if (signal.aborted) {
            return { role: 'tool', toolCallId: call.id, name: call.name, content: '[cancelado: o usuário interrompeu antes da execução]', isError: true }
          }
          const result = await this.executeTool(call, signal, checkpoint)
          let output = String(result.output ?? '')
          if (call.name !== 'skill' && !result.preserveOutput) {
            const limited = limitOutput(output, { maxBytes: Math.max(4096, this.config.outputCap || 0), keepTail: ['bash', 'bash_output', 'terminal'].includes(call.name) })
            output = limited.text
          }
          return { role: 'tool', toolCallId: call.id, name: call.name, content: output, isError: !!result.isError }
        }
        // Chamadas consecutivas somente leitura (read, grep, glob, webfetch, subagentes explore/plan…) rodam em
        // paralelo; qualquer coisa que altere estado roda sozinha e em ordem.
        const available = this.tools()
        const parallel = (call) => {
          if (call.name === 'task') return ['explore', 'plan'].includes(parseArgs(call.args)?.subagent_type)
          const tool = findTool(available, call.name)
          return !!tool?.readOnly && !['question', 'todowrite', 'skill'].includes(tool.name)
        }
        for (let i = 0; i < msg.toolCalls.length;) {
          const batch = [msg.toolCalls[i++]]
          if (parallel(batch[0])) while (i < msg.toolCalls.length && parallel(msg.toolCalls[i]) && batch.length < 8) batch.push(msg.toolCalls[i++])
          const results = await Promise.allSettled(batch.map(execute))
          results.forEach((r, index) => s.messages.push(r.status === 'fulfilled' ? r.value : { role: 'tool', toolCallId: batch[index].id, name: batch[index].name, content: String(r.reason?.message || r.reason), isError: true }))
          s.save()
        }
        if (signal.aborted) throw abortError()

        const sig = JSON.stringify(msg.toolCalls.map((c) => [c.name, c.args]))
        repeats = sig === lastSig ? repeats + 1 : 0
        lastSig = sig
        if (repeats >= 2) {
          // AG-10: parar e perguntar em vez de gastar cota em loop. Nunca chama a API de novo aqui.
          let answer = null
          try {
            if (this.ui.askQuestion) {
              answer = await this.ui.askQuestion({
                question: `Repeti a mesma chamada de ferramenta 3 vezes seguidas (${msg.toolCalls.map((c) => c.name).join(', ')}). Como prosseguir?`,
                options: ['Tentar outra abordagem', 'Encerrar o turno'],
                signal,
              })
            }
          } catch {}
          s.messages.push({
            role: 'user',
            synthetic: true,
            content: '[aviso automático do harness] Você repetiu exatamente a mesma chamada de ferramenta 3 vezes seguidas. Pare, reavalie a abordagem e tente algo diferente — ou explique o bloqueio ao usuário.' +
              (answer ? `\nResposta do usuário: ${answer}` : ''),
          })
          this.emit('notice', { level: 'warn', text: 'Três chamadas idênticas consecutivas: turno encerrado para evitar consumo em loop. Diga como prosseguir.' })
          break
        }
      }
    } catch (err) {
      if (isAbortError(err) || signal.aborted) {
        aborted = true
        throw abortError()
      }
      throw err
    } finally {
      if (before) {
        try { await finishSnapshot(s, before, checkpoint) }
        catch (e) { this.emit('notice', { level: 'warn', text: `Snapshot indisponível: ${e.message}` }) }
      }
      if (this.config.pruneOutputs !== false && !this.subagent) {
        const freed = pruneToolOutputs(s.messages)
        if (freed) this.emit('pruned', { tokens: freed })
      }
      s.event('turn-end', { elapsedMs: Date.now() - turnStart, aborted })
      s.save()
      this.emit('turn-end', { usage: this.usage.turn, elapsedMs: Date.now() - turnStart, aborted })
      await this.hook('turnEnd', { usage: this.usage.turn, elapsedMs: Date.now() - turnStart, aborted })
    }
  }
}
