// Interface interativa do Snake (TUI).

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { Agent } from '../agent/agent.js'
import { findInstructionFiles } from '../agent/prompt.js'
import { Session } from '../agent/session.js'
import { cacheHitRate, estimateTokens } from '../agent/usage.js'
import { COMMANDS, COMMAND_GROUPS, findCommand, loadCustomCommands, matchCommands } from '../commands.js'
import { VERSION, paths, saveConfig, setKey, shortPath, PERMISSION_MODES } from '../config.js'
import { bigLogo, headerLines } from '../logo.js'
import { McpManager } from '../mcp/client.js'
import { DEFAULT_CONTEXT } from '../providers/catalog.js'
import { costLabel, priceSentence } from '../providers/pricing.js'
import { availability } from '../providers/availability.js'
import { isAbortError } from '../providers/index.js'
import { PROVIDERS, freeLabel, isUsable, resolveKey } from '../providers/registry.js'
import { errorHint } from '../providers/sse.js'
import { bg, bgCode, fg, italic, palette, strike, t, setTheme } from '../theme.js'
import { backgroundJobs, bash, cleanOutput, killAllBackground } from '../tools/bash.js'
import { isBinaryBuffer, resolvePath, ripgrep, walk, walkAsync } from '../tools/util.js'
import { padEnd, stripAnsi, strWidth, truncate, truncateStart, wrapText } from './ansi.js'
import { displayPath } from '../tools/util.js'
import { bar, fmtAgo, fmtCost, fmtDuration, fmtInt, fmtPercent, fmtPrice, fmtTokens } from './format.js'
import { LineEditor, loadHistory } from './input.js'
import { MarkdownRenderer, renderMarkdown } from './markdown.js'
import { Picker, Prompt } from './picker.js'
import { Terminal } from './terminal.js'
import { discoverAgents } from '../agent/resources.js'
import { permissionDecision } from '../agent/permissions.js'

const SPINNER = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']
const VERBS = [
  'Rastejando',
  'Serpenteando',
  'Sibilando',
  'Deslizando',
  'Farejando',
  'Enrolando',
  'Dando o bote',
  'Trocando de pele',
  'Digerindo',
  'Espreitando',
  'Ziguezagueando',
  'Hipnotizando',
  'Chocando ideias',
  'Desenrolando',
  'Tramando',
  'Tomando sol',
  'Caçando bugs',
  'Ondulando',
]
const MODES = PERMISSION_MODES
export const SAFE_WHILE_BUSY = new Set(['help', 'usage', 'context', 'todos', 'status', 'bg', 'mcp', 'config', 'memory', 'logo', 'providers', 'thinking', 'copy', 'skills', 'goals', 'timeline', 'details', 'stats', 'memories', 'diff', 'stop', 'exit'])

function shimmer(text, frame) {
  const chars = [...text]
  const pos = (frame % (chars.length + 8)) - 4
  return chars.map((c, i) => (Math.abs(i - pos) <= 1 ? fg('#d9f99d')(c) : fg(palette.primary)(c))).join('')
}

function modeBorder(mode, text) {
  if (text.startsWith('!')) return fg(palette.tongue)
  if (text.startsWith('#')) return fg(palette.mint)
  if (mode === 'ask') return fg('#a8892a')
  if (mode === 'plan') return fg('#2d8a80')
  return t.border
}

const MODE_LABEL = { yolo: 'YOLO', ask: 'ASK', plan: 'PLAN', auto: 'AUTO', acceptEdits: 'EDITS', dontAsk: 'DONTASK', bypassPermissions: 'BYPASS' }

function modeBadge(mode) {
  const label = MODE_LABEL[mode] || String(mode).toUpperCase()
  if (mode === 'ask' || mode === 'acceptEdits') return t.bold(t.warn('◆ ' + label))
  if (mode === 'plan' || mode === 'dontAsk') return t.bold(t.info('◇ ' + label))
  return t.bold(t.accent('▸▸ ' + label))
}

/** Título de uma ferramenta no estilo "Read src/app.js" / "Bash npm test". */
function toolTitle(label, summary, width) {
  const s = String(summary || '').replace(/\s+/g, ' ').trim()
  if (!s) return t.bold(t.text(label))
  const room = Math.max(8, width - strWidth(label) - 1)
  const looksLikePath = /^[~./]?[\w@.-]*\//.test(s) && !/\s/.test(s.split(' · ')[0])
  return t.bold(t.text(label)) + ' ' + t.text(looksLikePath ? truncateStart(s, room) : truncate(s, room))
}

/** Linhas "rótulo valor" com o valor quebrado e recuado (cabe em telas estreitas). */
function kvLines(label, value, labelWidth, cols) {
  const indent = 2 + labelWidth + 1
  if (cols - indent < 20 || strWidth(label) > labelWidth) return ['  ' + label, ...wrapText(value, Math.max(10, cols - 7)).map((l) => '    ' + l)]
  return wrapText(value, cols - indent - 2).map((l, i) => (i ? ' '.repeat(indent) : '  ' + padEnd(label, labelWidth) + ' ') + l)
}

/** Custo para exibição: modelos grátis mostram "grátis" em vez de "$0". */
function costText(usage, model) {
  return fmtCost(usage.cost, { free: !!model?.free && !!model?.toolCheck?.ok && !usage.cost, unknown: usage.costUnknown, estimated: usage.costEstimated })
}

function fuzzyFiles(files, q) {
  if (!q) return files.slice(0, 50)
  const lq = q.toLowerCase()
  const scored = []
  for (const f of files) {
    const lf = f.toLowerCase()
    const base = lf.slice(lf.lastIndexOf('/') + 1)
    let score = -1
    if (base.startsWith(lq)) score = 0
    else if (base.includes(lq)) score = 1
    else if (lf.includes(lq)) score = 2
    else {
      let i = 0
      for (const ch of lf) if (ch === lq[i]) i++
      if (i === lq.length) score = 3
    }
    if (score >= 0) scored.push([score, f.length, f])
  }
  scored.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  return scored.map((s) => s[2])
}

export async function runInteractive(opts) {
  const app = new App(opts)
  return app.start()
}

export class App {
  constructor({ config, catalog, session, initialPrompt = '', pickSession = false, notice = '' }) {
    this.config = config
    setTheme(config.theme || 'serpente')
    this.catalog = catalog
    this.session = session
    this.initialPrompt = initialPrompt
    this.notice = notice
    this.pickSession = pickSession
    this.term = new Terminal(process.stdout)
    this.editor = new LineEditor({ history: loadHistory() })
    this.mcp = new McpManager(config.mcp, { cwd: session.cwd })
    this.agent = this.createAgent(session)
    this.commands = [...COMMANDS, ...loadCustomCommands(session.cwd)]
    this.busy = false
    this.controller = null
    this.queue = session.inbox.map((e) => e.text)
    this.modal = null
    this.popup = null
    this.toastMsg = null
    this.live = this.freshLive()
    this.spin = { frame: 0, timer: null, verb: VERBS[0], started: 0 }
    this.pending = []
    this.flushTimer = null
    this.lastBlank = true
    this.lastOutput = null
    this.lastAnswer = ''
    this.ctrlCAt = 0
    this.interruptAt = 0
    this.mouseReport = false
    this.escAt = 0
    this.fileCache = { at: 0, cwd: '', files: [], loading: false }
    this.exiting = false
    this.pasting = false
    this.pasteBuf = ''
    this.interactionQueue = Promise.resolve()
  }

  createAgent(session) {
    const agent = new Agent({
      session,
      config: this.config,
      catalog: this.catalog,
      extraTools: this.mcp ? this.mcp.agentTools() : [],
      ui: {
        emit: (type, data) => this.onAgentEvent(type, data),
        askPermission: (req) => this.askPermission(req),
        askQuestion: (req) => this.askQuestion(req),
      },
    })
    if (this.agent) agent.mode = this.agent.mode
    return agent
  }

  freshLive() {
    return {
      md: null,
      partial: '',
      textStarted: false,
      reasoning: '',
      reasoningAt: 0,
      reasoningLogged: false,
      toolStreams: new Map(),
      running: new Map(),
      tool: null,
      toolOutput: '',
      sub: [],
      retry: null,
      tokens: 0,
      firstToken: false,
      compacting: false,
    }
  }

  openTerminal(id) {
    if (!this.agent.terminal) throw new Error('Terminais desativados: bgJobs=false')
    const job = id ? this.agent.terminal.jobs.get(id) : this.agent.terminal.open()
    if (!job) throw new Error('Terminal não encontrado')
    this.terminalMode = job.id
    this.modal = {
      render: (cols, rows) => [t.primary(`Terminal ${job.id} · Ctrl+] volta`), ...cleanOutput(job.output).split('\n').slice(-Math.max(1, rows - 2)).map((l) => truncate(l, cols - 1))],
      key: () => true,
    }
    this.render()
  }
  terminalKey(str, key) {
    if (key.sequence === '\x1d') { this.terminalMode = null; this.modal = null; return this.render() }
    try { this.agent.terminal.write(this.terminalMode, key.sequence || str || '') } catch (e) { this.terminalMode = null; this.modal = null; this.logError(e) }
  }

  get cols() {
    return this.term.cols
  }

  // ───────────────────────────── saída ─────────────────────────────

  flush() {
    clearTimeout(this.flushTimer)
    this.flushTimer = null
    if (this.pending.length) {
      const lines = this.pending
      this.pending = []
      this.lastBlank = lines[lines.length - 1] === ''
      this.term.log(lines.join('\n'))
    } else this.term.render()
  }

  schedule() {
    if (this.flushTimer || this.exiting) return
    this.flushTimer = setTimeout(() => this.flush(), 33)
  }

  render() {
    if (this.exiting) return
    this.flush()
  }

  /** Escreve linhas permanentes (imediatamente). */
  log(text) {
    if (this.exiting) return
    const lines = Array.isArray(text) ? text : String(text).split('\n')
    this.pending.push(...lines)
    this.flush()
  }

  /** Bloco precedido de linha em branco. */
  block(lines) {
    const arr = Array.isArray(lines) ? lines : String(lines).split('\n')
    if (!this.lastBlank && !(this.pending.length && this.pending[this.pending.length - 1] === '')) arr.unshift('')
    this.log(arr)
  }

  toast(text, ms = 3000) {
    this.toastMsg = { text, until: Date.now() + ms }
    this.render()
    setTimeout(() => this.render(), ms + 50)
  }

  logError(err) {
    const hint = errorHint(err)
    const lines = [t.error('✗ ') + t.error(String(err?.message || err))]
    if (hint) lines.push(t.muted('  ' + hint))
    if (err?.code === 'missing_key' && err.provider) lines.push(t.muted(`  Dica: /key ${err.provider}  ·  ou troque para um modelo grátis sem chave com /models`))
    this.block(lines)
  }

  logUser(text) {
    const w = this.cols - 1
    const band = bgCode('#11281b')
    const rows = wrapText(text, Math.max(10, w - 3))
    const out = rows.map((r, i) => {
      const prefix = i === 0 ? t.accent('❯ ') : '  '
      const body = prefix + t.text(r)
      return band + body + ' '.repeat(Math.max(0, w - strWidth(body))) + '\x1b[49m'
    })
    this.block(out)
  }

  // ─────────────────────────── boas-vindas ───────────────────────────

  /** Situação de custo/chave do modelo, colorida: "grátis · sem chave", "$0.3/$1.2 · chave ✓"… */
  modelStatus(m) {
    const p = PROVIDERS[m.provider]
    const blocked = availability(m)
    if (blocked) return t.warn(blocked.label)
    const access = resolveKey(m.provider) ? 'chave ✓' : p?.keyRequired ? 'requer chave' : p?.free === 'local' ? '' : 'sem chave'
    return (m.free ? t.accent(costLabel(m)) : t.text(costLabel(m))) + (access ? t.muted(' · ' + access) : '')
  }

  printWelcome() {
    const m = this.agent.model
    const p = PROVIDERS[m.provider]
    const cols = this.cols
    const info = [
      t.bold(t.primary('snake')) + t.subtle(` v${VERSION}`) + t.muted(cols >= 64 ? ' · seu agente de código no terminal' : ''),
      t.primary(m.id) + t.muted(cols >= 64 ? ` · ${p?.name || m.provider} · ` : ' · ') + this.modelStatus(m),
      t.subtle(truncateStart(shortPath(this.session.cwd), Math.max(12, cols - 20))),
    ]
    const out = ['', ...headerLines(info, cols), '']
    const anyKey = Object.keys(PROVIDERS).some((id) => PROVIDERS[id].keyRequired && resolveKey(id))
    if (!anyKey && m.provider === 'pollinations') {
      const n = (this.catalog.data.openrouter || []).filter((x) => x.free).length
      const tip = `Mais modelos grátis: crie uma chave grátis em openrouter.ai/keys e use /key openrouter${n ? ` (${n} modelos :free)` : ''}.`
      out.push(...wrapText(tip, cols - 3).map((l) => ' ' + t.muted(l)), '')
    }
    if (m.provider === 'none') out.push(...wrapText('Nenhum modelo escolhido: use /models para escolher um (ou /key para adicionar uma chave).', cols - 3).map((l) => ' ' + t.warn(l)), '')
    this.log(out)
    this.lastBlank = true
  }

  // ─────────────────────────── rodapé ───────────────────────────

  inputWidth() {
    return Math.max(10, this.cols - 3)
  }

  /** Entrada entre duas réguas horizontais (estilo Claude Code): sem bordas laterais, cabe em qualquer largura. */
  renderInputBox(cols, maxRows) {
    const ruleW = cols - 1
    const textW = Math.max(10, cols - 3)
    const color = modeBorder(this.agent.mode, this.editor.text)
    const lay = this.editor.layout(textW - 1)
    const rule = color('─'.repeat(ruleW))
    const lines = [rule]
    let cursor = { row: 1, col: 2 }
    if (this.editor.empty) {
      const ph = this.busy ? 'Digite para enfileirar a próxima mensagem…' : textW >= 64 ? 'Peça uma tarefa ou pergunte algo…  (/ comandos · @ arquivos · ! shell)' : 'Peça uma tarefa ou pergunte algo…'
      lines.push(t.primary('❯ ') + t.subtle(truncate(ph, textW)))
    } else {
      const maxVisible = Math.max(1, maxRows)
      let start = 0
      if (lay.rows.length > maxVisible) start = Math.min(Math.max(0, lay.cursorRow - maxVisible + 1), lay.rows.length - maxVisible)
      const visible = lay.rows.slice(start, start + maxVisible)
      const bangMode = this.editor.text.startsWith('!')
      visible.forEach((r, i) => {
        const idx = start + i
        const prefix = idx === 0 ? (bangMode ? t.tongue('! ') : t.primary('❯ ')) : '  '
        let body = r.text
        if (idx === 0 && bangMode) body = body.slice(1)
        lines.push(prefix + this.highlightInput(body, idx))
      })
      const bang = bangMode && lay.cursorRow === 0 ? -1 : 0
      cursor = { row: 1 + lay.cursorRow - start, col: 2 + Math.max(0, lay.cursorCol + bang) }
    }
    lines.push(rule)
    return { lines, cursor }
  }

  highlightInput(text, rowIdx) {
    if (rowIdx === 0 && /^\/\S*/.test(text)) {
      const m = /^\/\S*/.exec(text)[0]
      return t.accent(m) + text.slice(m.length)
    }
    return text.replace(/(^|\s)(@\S+)/g, (_, pre, mention) => pre + t.info(mention)).replace(/\[Colado #\d+ · \+\d+ linhas\]/g, (m) => t.muted(m))
  }

  renderPopup(cols) {
    const p = this.popup
    const max = 6
    const start = Math.max(0, Math.min(p.index - Math.floor(max / 2), p.items.length - max))
    const out = []
    p.items.slice(start, start + max).forEach((it, i) => {
      const sel = start + i === p.index
      const pointer = sel ? t.primary('❯ ') : '  '
      if (p.kind === 'command') {
        const name = padEnd('/' + it.name, 14)
        out.push(' ' + pointer + (sel ? t.bold(t.primary(name)) : t.accent(name)) + ' ' + t.muted(truncate(it.description + (it.custom ? ' (personalizado)' : ''), cols - 22)))
      } else {
        out.push(' ' + pointer + (sel ? t.bold(t.primary('@' + it)) : t.info('@' + it)))
      }
    })
    if (p.items.length > max) out.push(t.subtle(`   ${p.index + 1}/${p.items.length} · tab completa · enter usa`))
    return out
  }

  /** Linha(s) abaixo da entrada: modo à esquerda; modelo, contexto, tokens e custo à direita. */
  statusLines(cols) {
    const m = this.agent.model
    const u = this.session.usage
    const tot = u.total
    const width = cols - 2
    const fraction = Math.min(1, u.contextTokens / (m.context || DEFAULT_CONTEXT))
    const ctxColor = fraction > 0.85 ? t.error : fraction > 0.6 ? t.warn : t.muted
    const left = modeBadge(this.agent.mode) + (cols >= 56 ? t.subtle(' shift+tab') : '')
    const note = this.toastMsg && this.toastMsg.until > Date.now() ? this.toastMsg.text : availability(m)?.label
    const model = truncate(`${m.provider}/${m.id}`, Math.max(12, Math.floor(width * 0.45)))
    const pieces = [
      t.muted(model),
      ctxColor(`${fmtPercent(fraction)} ctx`),
      ...(tot.requests ? [t.muted(`↑${fmtTokens(tot.input + tot.cacheWrite)} ↓${fmtTokens(tot.output)}`), t.muted(costText(tot, m))] : [t.muted(costLabel(m))]),
    ]
    const fit = (list, room) => {
      const parts = [...list]
      while (parts.length > 1 && strWidth(parts.join(t.subtle(' · '))) > room) parts.splice(parts.length > 2 ? 2 : 1, 1)
      return truncate(parts.join(t.subtle(' · ')), room)
    }
    if (note) {
      const right = t.warn(truncate(note, Math.max(8, width - strWidth(left) - 2)))
      return [' ' + left + ' '.repeat(Math.max(2, width - strWidth(left) - strWidth(right))) + right]
    }
    const oneLine = fit(pieces, width - strWidth(left) - 2)
    if (cols >= 60 || strWidth(pieces.join(' · ')) <= width - strWidth(left) - 2) {
      return [' ' + left + ' '.repeat(Math.max(2, width - strWidth(left) - strWidth(oneLine))) + oneLine]
    }
    // tela estreita (celular): modo + contexto em cima, modelo + consumo embaixo
    const top = ctxColor(`${fmtPercent(fraction)} ctx`)
    const bottom = fit([pieces[0], ...pieces.slice(2)], width)
    return [' ' + left + ' '.repeat(Math.max(2, width - strWidth(left) - strWidth(top))) + top, ' ' + bottom]
  }

  spinnerLine() {
    const L = this.live
    const now = Date.now()
    if (L.retry && L.retry.until > now) {
      return t.warn('↻ Aguardando o provedor') + t.muted(` (${L.retry.reason}) · nova tentativa em ${Math.ceil((L.retry.until - now) / 1000)}s · esc cancela`)
    }
    const frame = SPINNER[this.spin.frame % SPINNER.length]
    const running = L.running.size
    const verb = this.modal ? 'Aguardando sua confirmação' : L.compacting ? 'Compactando a conversa' : running > 1 ? `Executando ${running} ferramentas` : running ? `Executando ${[...L.running.values()][0].label}` : L.tool ? `Executando ${L.tool.label}` : this.spin.verb
    const info = [fmtDuration(now - this.spin.started)]
    if (L.tokens) info.push(`↓ ${fmtTokens(L.tokens)} tokens`)
    if (!L.firstToken && !running && !L.tool && !L.compacting) info.push('esperando o modelo')
    info.push(this.cols >= 56 ? 'esc interrompe' : 'esc')
    return t.primary(frame) + ' ' + shimmer(verb + '…', this.spin.frame) + t.muted(` ${info.join(' · ')}`)
  }

  todoLines(todos, cols) {
    return todos.map((td, i) => {
      const prefix = t.muted(i === 0 ? '  └ ' : '    ')
      const icon = td.status === 'completed' ? t.primary('☒') : td.status === 'in_progress' ? t.accent('◼') : td.status === 'cancelled' ? t.subtle('☒') : t.muted('☐')
      const text = truncate(td.content, cols - 10)
      const styled = td.status === 'completed' || td.status === 'cancelled' ? t.muted(strike(text)) : td.status === 'in_progress' ? t.bold(t.text(text)) : t.text(text)
      return prefix + icon + ' ' + styled
    })
  }

  renderLive(cols, budget) {
    const L = this.live
    const out = []
    const w = cols - 2
    if (L.md && L.partial) {
      L.md.width = Math.max(20, cols - 3)
      L.md.preview(L.partial).forEach((l, i) => out.push((L.textStarted || i > 0 ? '  ' : t.primary('● ')) + l))
    } else if (L.reasoning && !L.textStarted && !L.reasoningLogged) {
      out.push(t.muted('✻ Pensando…'))
      if (this.config.showThinking !== false) {
        const lines = wrapText(L.reasoning.trim().replace(/\n{2,}/g, '\n'), w - 2).slice(-3)
        out.push(...lines.map((l) => '  ' + t.subtle(italic(l))))
      }
    }
    for (const tc of L.toolStreams.values()) {
      if (!tc.name) continue
      const label = this.agent.tools().find((x) => x.name === tc.name)?.label || tc.name
      out.push(t.subtle('○ ') + t.bold(t.text(label)) + t.muted(` preparando… ${tc.length > 1024 ? (tc.length / 1024).toFixed(1) + ' KB' : tc.length + ' bytes'}`))
    }
    // ferramentas em execução (várias ao mesmo tempo quando são de leitura)
    const now = Date.now()
    for (const r of L.running.values()) {
      if (r.waiting) continue // o pedido de permissão já mostra a ferramenta
      const elapsed = now - r.started >= 1000 ? t.subtle(' · ' + fmtDuration(now - r.started)) : ''
      out.push(t.accent(SPINNER[this.spin.frame % SPINNER.length] + ' ') + toolTitle(r.label, r.summary, w - 10) + elapsed)
      if (r.output) {
        const tail = cleanOutput(r.output).trimEnd().split('\n').slice(-4)
        tail.forEach((l, i) => out.push(t.muted(i === 0 ? '  └ ' : '    ') + t.subtle(truncate(l, w - 5))))
      }
      for (const sub of r.sub.slice(-3)) out.push(t.muted('  └ ') + t.subtle(truncate(sub, w - 5)))
    }
    if (L.tool && L.toolOutput) {
      const tail = cleanOutput(L.toolOutput).trimEnd().split('\n').slice(-5)
      tail.forEach((l, i) => out.push(t.muted(i === 0 ? '  └ ' : '    ') + t.subtle(truncate(l, w - 5))))
    }
    if (out.length) out.push('')
    out.push(this.spinnerLine())
    const todos = this.session.todos || []
    if (todos.length && todos.some((x) => x.status === 'pending' || x.status === 'in_progress')) out.push(...this.todoLines(todos, cols).slice(0, 10))
    for (const q of this.queue.slice(0, 3)) out.push(t.muted('  ↵ na fila: ') + t.text(truncate(q.replace(/\s+/g, ' '), cols - 18)))
    if (this.queue.length > 3) out.push(t.muted(`  … +${this.queue.length - 3} na fila`))
    return out.length > budget ? out.slice(out.length - budget) : out
  }

  footer(cols, rows) {
    const status = this.statusLines(cols)
    let main
    let cursor = null
    if (this.modal) {
      const r = this.modal.render(cols, Math.max(5, rows - status.length - 2))
      if (Array.isArray(r)) main = r
      else {
        main = r.lines
        cursor = r.cursor
      }
    } else {
      const maxInputRows = Math.max(3, Math.floor(rows / 2) - 3)
      const box = this.renderInputBox(cols, maxInputRows)
      main = box.lines
      cursor = box.cursor
      if (this.popup) main = main.concat(this.renderPopup(cols))
    }
    const budget = Math.max(2, rows - 3 - main.length - status.length)
    const live = this.busy || this.live.compacting ? this.renderLive(cols, budget - 1) : []
    if (live.length && !this.lastBlank) live.unshift('')
    const lines = [...live, ...(live.length ? [''] : []), ...main, ...status]
    if (cursor) cursor = { row: live.length + (live.length ? 1 : 0) + cursor.row, col: cursor.col }
    return { lines, cursor }
  }

  // ─────────────────────────── eventos do agente ───────────────────────────

  flushReasoning() {
    const L = this.live
    if (!L.reasoning.trim() || L.reasoningLogged) return
    L.reasoningLogged = true
    const secs = Math.max(1, Math.round((Date.now() - L.reasoningAt) / 1000))
    const lines = [t.muted(`✻ Pensou por ${secs}s`)]
    if (this.config.showThinking !== false) {
      const body = wrapText(L.reasoning.trim().replace(/\n{2,}/g, '\n'), this.cols - 6)
      const shown = body.slice(0, 4)
      lines.push(...shown.map((l) => '  ' + t.subtle(italic(l))))
      if (body.length > shown.length) lines.push('  ' + t.subtle(`… +${body.length - shown.length} linhas de raciocínio`))
    }
    this.block(lines)
  }

  emitAssistantLines(lines) {
    const L = this.live
    for (const l of lines) {
      if (!L.textStarted) {
        if (!l.trim()) continue
        this.flush()
        if (!this.lastBlank) this.pending.push('')
        this.pending.push(t.primary('● ') + l)
        L.textStarted = true
      } else this.pending.push(stripAnsi(l).trim() ? '  ' + l : '')
    }
    this.schedule()
  }

  finishText() {
    const L = this.live
    if (!L.md) return
    if (L.partial) {
      this.emitAssistantLines(L.md.line(L.partial))
      L.partial = ''
    }
    this.emitAssistantLines(L.md.end())
    L.md = null
    this.flush()
  }

  onAgentEvent(type, data) {
    const L = this.live
    switch (type) {
      case 'terminal-output':
        this.schedule()
        break
      case 'extensions':
        this.commands = [...COMMANDS, ...loadCustomCommands(this.session.cwd), ...data.commands]
        break
      case 'sub-job-start':
      case 'sub-job-end':
        this.schedule()
        break
      case 'turn-start':
        this.live = this.freshLive()
        this.startSpinner()
        break
      case 'request-start':
        this.finishText()
        L.md = new MarkdownRenderer({ width: this.cols - 3 })
        L.partial = ''
        L.textStarted = false
        L.reasoning = ''
        L.reasoningAt = 0
        L.reasoningLogged = false
        L.toolStreams.clear()
        L.firstToken = false
        L.retry = null
        break
      case 'retry': {
        const status = data.error?.status
        const reason = status === 429 ? 'limite de taxa' : data.error?.code === 'stalled' ? 'provedor parou de responder' : status ? `HTTP ${status}` : 'falha de rede'
        L.retry = { until: Date.now() + data.delay, reason }
        // só a primeira tentativa vira linha permanente; as seguintes aparecem no indicador ao vivo
        if (data.attempt === 1) this.block(t.warn('↻ ') + t.muted(truncate(`${reason}${status === 429 ? ' (HTTP 429)' : ''} — tentando de novo automaticamente`, this.cols - 4)))
        this.schedule()
        break
      }
      case 'stream': {
        L.firstToken = true
        L.retry = null
        if (data.type === 'reasoning') {
          if (!L.reasoningAt) L.reasoningAt = Date.now()
          L.reasoning += data.delta
          L.tokens += estimateTokens(data.delta)
          this.schedule()
        } else if (data.type === 'text') {
          if (L.reasoning && !L.reasoningLogged) this.flushReasoning()
          if (!L.md) L.md = new MarkdownRenderer({ width: this.cols - 3 })
          L.partial += data.delta
          L.tokens += estimateTokens(data.delta)
          let nl
          const lines = []
          while ((nl = L.partial.indexOf('\n')) !== -1) {
            lines.push(...L.md.line(L.partial.slice(0, nl)))
            L.partial = L.partial.slice(nl + 1)
          }
          if (lines.length) this.emitAssistantLines(lines)
          else this.schedule()
        } else if (data.type === 'toolcall-start' || data.type === 'toolcall-name' || data.type === 'toolcall-delta') {
          const cur = L.toolStreams.get(data.index) || { name: '', length: 0 }
          if (data.name) cur.name = data.name
          if (data.length != null) cur.length = data.length
          L.toolStreams.set(data.index, cur)
          this.schedule()
        }
        break
      }
      case 'assistant':
        this.finishText()
        if (L.reasoning && !L.reasoningLogged) this.flushReasoning()
        L.toolStreams.clear()
        if (data.message.content?.trim()) this.lastAnswer = data.message.content
        break
      case 'tool-start': {
        this.finishText()
        const { tool, call, summary } = data
        if (tool?.name === 'todowrite') break
        L.running.set(call.id, { label: tool?.label || call.name, name: tool?.name, summary: String(summary || ''), started: Date.now(), output: '', sub: [] })
        this.schedule()
        break
      }
      case 'tool-progress': {
        const r = L.running.get(data.call?.id)
        if (r) {
          r.output += data.chunk
          if (r.output.length > 16000) r.output = r.output.slice(-8000)
        }
        this.schedule()
        break
      }
      case 'tool-end': {
        const r = L.running.get(data.call?.id)
        L.running.delete(data.call?.id)
        this.logToolResult({ ...data, elapsedMs: data.result?.elapsedMs ?? (r ? Date.now() - r.started : 0) })
        break
      }
      case 'sub': {
        const r = L.running.get(data.parent?.id)
        if (data.type === 'tool-start') {
          const label = data.data.tool?.label || data.data.call.name
          const line = `${label} ${String(data.data.summary || '').replace(/\s+/g, ' ')}`.trim()
          if (r) { r.sub.push(line); if (r.sub.length > 20) r.sub.shift() }
          this.schedule()
        } else if (data.type === 'stream' && data.data.type === 'text') {
          L.tokens += estimateTokens(data.data.delta)
          this.schedule()
        }
        break
      }
      case 'note':
        // processo em segundo plano terminou: com o agente parado, retoma sozinho para o modelo reagir
        this.block(t.info('◆ ') + t.muted(truncate(String(data.text).split('\n')[0].replace('[aviso automático do harness] ', ''), this.cols - 4)))
        if (!data.busy && !this.busy && this.config.autoResume !== false) setImmediate(() => { if (!this.busy && this.agent.notes.length) this.runAgent(null) })
        break
      case 'pruned':
        break
      case 'notice': {
        const mark = data.level === 'warn' ? t.warn('! ') : t.info('i ')
        this.block(wrapText(String(data.text), Math.max(10, this.cols - 4)).map((l, i) => (i ? '  ' : mark) + t.muted(l)))
        break
      }
      case 'compact-start':
        L.compacting = true
        this.block(t.muted(data.auto ? '✻ Contexto quase cheio — compactando a conversa automaticamente…' : '✻ Compactando a conversa…'))
        if (!this.busy) this.startSpinner()
        break
      case 'compact-end':
        L.compacting = false
        this.block(t.primary('✓ ') + t.muted(`Conversa compactada: ${data.before} mensagens → resumo de ~${fmtTokens(estimateTokens(data.summary))} tokens`))
        if (!this.busy) this.stopSpinner()
        break
      case 'todos':
        this.schedule()
        break
      case 'turn-end':
        this.finishText()
        this.stopSpinner()
        if (this.config.showTurnStats !== false && data.usage?.requests && !data.aborted) this.logTurnStats(data)
        if (this.session.plan?.status === 'draft') this.log(t.info('Plano salvo · /plan aplicar · /plan descartar · /plan editar <instruções>'))
        break
      default:
        break
    }
  }

  logTurnStats({ usage: u, elapsedMs }) {
    const m = this.agent.model
    const prompt = u.input + u.cacheRead + u.cacheWrite
    const est = u.estimated ? '~' : ''
    const hit = prompt ? Math.round((u.cacheRead / prompt) * 100) : 0
    const speed = u.genMs > 0 && u.output > 0 ? `${Math.round(u.output / (u.genMs / 1000))} tok/s` : ''
    const parts = [fmtDuration(elapsedMs), `↑${est}${fmtTokens(u.input + u.cacheWrite)} ↓${est}${fmtTokens(u.output)}`, `cache ${hit}%`, speed, costText(u, m)].filter(Boolean)
    const width = Math.max(8, this.cols - 4)
    while (parts.length > 2 && strWidth(parts.join(' · ')) > width) parts.splice(parts.length - 2, 1)
    this.block([t.subtle('✓ ' + truncate(parts.join(' · '), width))])
  }

  renderDiff(diff, max = 16) {
    const out = []
    const cols = this.cols
    const nums = diff.lines.map((l) => l.newNo || l.oldNo || 0)
    const numW = Math.max(2, String(Math.max(0, ...nums)).length)
    const w = cols - 5
    for (const l of diff.lines.slice(0, max)) {
      if (l.type === 'gap') {
        out.push('    ' + t.subtle(l.text || '⋯'))
        continue
      }
      const no = String((l.type === 'del' ? l.oldNo : l.newNo ?? l.oldNo) ?? '').padStart(numW)
      const sign = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '
      const text = truncate(`${no} ${sign} ${l.text.replace(/\t/g, '  ')}`, w)
      if (l.type === 'add') out.push('    ' + bg(palette.addedBg)(t.added(padEnd(text, w))))
      else if (l.type === 'del') out.push('    ' + bg(palette.removedBg)(t.removed(padEnd(text, w))))
      else out.push('    ' + t.muted(text))
    }
    const rest = Math.max(0, diff.lines.length - max) + (diff.more || 0)
    if (rest > 0) out.push('    ' + t.subtle(`… +${rest} linhas`))
    return out
  }

  /** Bloco completo de uma ferramenta: título + resultado, gravado de uma vez quando ela termina. */
  logToolResult({ call, tool, result, args = {}, elapsedMs = 0 }) {
    const d = result.display || {}
    const cols = this.cols
    const w = cols - 6
    const label = tool?.label || call.name
    let summary = ''
    try { summary = String(tool?.summary?.(args, { cwd: this.session.cwd }) ?? '') } catch {}
    if (!summary && d.path) summary = d.path
    const time = elapsedMs >= 1000 ? t.subtle(' · ' + fmtDuration(elapsedMs)) : ''
    const dot = result.isError ? t.error('● ') : d.failed ? t.warn('● ') : t.primary('● ')
    const head = dot + toolTitle(label, summary, cols - 4 - (time ? 8 : 0)) + time
    const first = (s) => t.muted('  └ ') + s
    const cont = (s) => '    ' + s
    if (tool?.name === 'todowrite' && d.todos && !result.isError) {
      this.block([t.primary('● ') + t.bold(t.text('Tarefas')) + t.muted(` ${d.summary}`), ...this.todoLines(d.todos, cols)])
      return
    }
    const lines = [head]
    if (result.isError) {
      const msg = String(result.output || 'erro').replace(/^Erro:\s*/, '').split('\n')
      lines.push(first(t.error(truncate(msg[0], w))))
      msg.slice(1, 4).forEach((l) => lines.push(cont(t.error(truncate(l, w)))))
      if (msg.length > 4) this.lastOutput = { title: label, text: d.output || result.output }
      this.block(lines)
      return
    }
    if (d.diff) {
      const stat = `${d.diff.added ? t.added('+' + d.diff.added) : ''}${d.diff.added && d.diff.removed ? ' ' : ''}${d.diff.removed ? t.removed('−' + d.diff.removed) : ''}`
      lines.push(first(stat || t.muted(d.summary || 'sem mudanças')))
      lines.push(...this.renderDiff(d.diff))
      if (d.files?.length > 1) d.files.forEach((f) => lines.push(cont(t.muted(truncate(f, w)))))
      for (const problem of d.diagnostics || []) problem.split('\n').slice(0, 4).forEach((l, i) => lines.push(cont((i ? t.warn : (s) => t.warn('! ' + s))(truncate(l, w - 2)))))
    } else if (d.files?.length) {
      lines.push(first(t.muted(d.summary || 'ok')))
      d.files.slice(0, 8).forEach((f) => lines.push(cont(t.muted(truncate(f, w)))))
    } else if (d.output && (tool?.name === 'bash' || tool?.name === 'bash_output' || tool?.name === 'terminal' || tool?.mcp)) {
      const all = d.output.split('\n')
      const shown = all.length > 6 ? all.slice(-4) : all
      lines.push(first(d.failed ? t.warn(d.summary || 'falhou') : t.muted(d.summary || 'ok')))
      if (all.length > shown.length) lines.push(cont(t.subtle(`… ${all.length - shown.length} linhas acima (ctrl+o expande)`)))
      shown.forEach((l) => lines.push(cont(t.subtle(truncate(l, w)))))
      this.lastOutput = { title: `${label} ${summary}`.trim(), text: d.output }
    } else if (tool?.name === 'task' && d.report) {
      lines.push(first(t.muted(d.summary || 'concluído')))
      this.lastOutput = { title: 'Relatório do subagente', text: d.report }
      lines.push(cont(t.subtle('ctrl+o mostra o relatório completo')))
    } else {
      lines.push(first(d.failed ? t.warn(d.summary || 'falhou') : t.muted(d.summary || 'ok')))
    }
    this.block(lines)
  }

  // ─────────────────────────── spinner ───────────────────────────

  startSpinner() {
    this.spin.started = Date.now()
    this.spin.verb = VERBS[Math.floor(Math.random() * VERBS.length)]
    clearInterval(this.spin.timer)
    this.spin.timer = setInterval(() => {
      this.spin.frame++
      this.schedule()
    }, 100)
  }

  stopSpinner() {
    clearInterval(this.spin.timer)
    this.spin.timer = null
  }

  // ─────────────────────────── entrada ───────────────────────────

  setupInput() {
    readline.emitKeypressEvents(process.stdin, { escapeCodeTimeout: 60 })
    process.stdin.setRawMode(true)
    process.stdin.resume()
    // Desliga modos de mouse que outro programa tenha deixado ligados no terminal: os relatórios chegariam como texto.
    process.stdout.write('\x1b[?2004h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l')
    process.stdin.on('keypress', (str, key) => {
      try {
        this.onKey(str, key || {})
      } catch (err) {
        this.logError(err)
      }
    })
    process.stdout.on('resize', () => this.render())
    const bye = () => this.exit(0)
    process.on('SIGTERM', bye)
    process.on('SIGHUP', bye)
    process.on('uncaughtException', (err) => this.crash(err))
    process.on('unhandledRejection', (err) => this.logError(err))
  }

  crash(err) {
    try {
      this.term.clearFooter()
      process.stdout.write('\x1b[?2004l\x1b[?25h')
      process.stdin.setRawMode(false)
    } catch {}
    console.error('\n' + (err?.stack || String(err)))
    process.exit(1)
  }

  /** Relatório de mouse SGR (ESC [ < b ; x ; y M|m): o readline entrega "ESC [ <" e depois os dígitos como teclas comuns. */
  swallowMouse(str, key) {
    if (key.sequence === '\x1b[<') {
      this.mouseReport = true
      return true
    }
    if (!this.mouseReport) return false
    if (/^[0-9;]$/.test(str ?? '')) return true
    this.mouseReport = false
    return str === 'M' || str === 'm'
  }

  onKey(str, key) {
    if (key.name === 'paste-start') {
      this.pasting = true
      this.pasteBuf = ''
      return
    }
    if (this.pasting) {
      if (key.name === 'paste-end') {
        this.pasting = false
        this.handlePaste(this.pasteBuf)
      } else this.pasteBuf += str ?? key.sequence ?? ''
      return
    }
    if (this.swallowMouse(str, key)) return
    if (this.terminalMode) return this.terminalKey(str, key)
    if (key.ctrl && key.name === 'c') return this.onCtrlC()
    if (key.ctrl && key.name === 'z') return this.suspend()
    if (this.modal) {
      if (this.modal.key(str, key)) this.render()
      return
    }
    if (key.name === 'escape') return this.onEscape()
    if (key.ctrl && key.name === 'l') return this.term.clearScreen()
    if (key.ctrl && key.name === 'o') return this.expandLast()
    if (key.ctrl && key.name === 'd') {
      if (this.editor.empty && !this.busy) return this.exit(0)
      this.editor.del()
      return this.afterEdit()
    }
    if (key.sequence === '\x1b[13;2u' || key.sequence === '\x1b[27;2;13~') {
      // Shift+Enter em terminais com protocolo CSI-u / modifyOtherKeys
      this.editor.insert('\n')
      return this.afterEdit()
    }
    if (key.name === 'tab' && key.shift) return this.cycleMode()
    if (key.name === 'tab') {
      if (this.popup) this.acceptPopup(false)
      else if (this.editor.empty && !this.busy) {
        const list = discoverAgents(this.session.cwd).filter((v) => v.mode !== 'subagent' && !v.hidden)
        const next = list[(list.findIndex((v) => v.name === this.session.agent) + 1) % list.length]
        this.handleInput('/agents ' + next.name)
      }
      return
    }
    if (key.name === 'return') {
      if (key.meta || key.shift) {
        this.editor.insert('\n')
        return this.afterEdit()
      }
      if (this.popup && this.acceptPopup(true)) return
      if (this.editor.text.endsWith('\\')) {
        this.editor.backspace()
        this.editor.insert('\n')
        return this.afterEdit()
      }
      return this.submit()
    }
    if (key.name === 'enter') {
      this.editor.insert('\n')
      return this.afterEdit()
    }
    if (key.name === 'up' || key.name === 'down') {
      const dir = key.name === 'up' ? -1 : 1
      if (this.popup) {
        const n = this.popup.items.length
        this.popup.index = (this.popup.index + dir + n) % n
        return this.render()
      }
      if (!this.editor.moveVertical(dir, this.inputWidth() - 1)) {
        if (dir < 0) this.editor.historyPrev()
        else this.editor.historyNext()
        this.popup = null
      }
      return this.render()
    }
    if (key.name === 'left') {
      key.ctrl || key.meta ? this.editor.wordLeft() : this.editor.left()
      return this.afterMove()
    }
    if (key.name === 'right') {
      key.ctrl || key.meta ? this.editor.wordRight() : this.editor.right()
      return this.afterMove()
    }
    if (key.name === 'home' || (key.ctrl && key.name === 'a')) {
      this.editor.home()
      return this.afterMove()
    }
    if (key.name === 'end' || (key.ctrl && key.name === 'e')) {
      this.editor.end()
      return this.afterMove()
    }
    if (key.ctrl && key.name === 'b') {
      this.editor.left()
      return this.afterMove()
    }
    if (key.ctrl && key.name === 'f') {
      this.editor.right()
      return this.afterMove()
    }
    if (key.meta && key.name === 'b') {
      this.editor.wordLeft()
      return this.afterMove()
    }
    if (key.meta && key.name === 'f') {
      this.editor.wordRight()
      return this.afterMove()
    }
    if (key.name === 'backspace') {
      key.meta ? this.editor.deleteWordBack() : this.editor.backspace()
      return this.afterEdit()
    }
    if (key.name === 'delete') {
      this.editor.del()
      return this.afterEdit()
    }
    if (key.ctrl && key.name === 'w') {
      this.editor.deleteWordBack()
      return this.afterEdit()
    }
    if (key.ctrl && key.name === 'u') {
      this.editor.killToStart()
      return this.afterEdit()
    }
    if (key.ctrl && key.name === 'k') {
      this.editor.killToEnd()
      return this.afterEdit()
    }
    if (str && !key.ctrl && !key.meta && (str >= ' ' || str === '\t')) {
      this.editor.insert(str === '\t' ? '  ' : str)
      return this.afterEdit()
    }
  }

  editPrompt() {
    if (this.busy) return this.toast('aguarde o turno para abrir o editor')
    fs.mkdirSync(paths.tmp, { recursive: true })
    const file = path.join(paths.tmp, `prompt-${this.session.id}.md`)
    fs.writeFileSync(file, this.editor.text, { mode: 0o600 })
    try { openEditor(this, file); this.editor.setText(fs.readFileSync(file, 'utf8')); this.render() }
    finally { fs.rmSync(file, { force: true }) }
  }

  askQuestion(req) {
    const promise = this.interactionQueue.then(() => this.askQuestionNow(req))
    this.interactionQueue = promise.catch(() => {})
    return promise
  }
  askQuestionNow({ question, header, options = [], signal }) {
    return new Promise((resolve) => {
      this.finishText()
      let finished = false
      const done = (value) => { if (finished) return; finished = true; signal?.removeEventListener('abort', abort); this.modal = null; resolve(value); this.render() }
      const abort = () => done(null)
      const title = header ? `${header}: ${question}` : question
      const free = () => { this.modal = new Prompt({ title, label: 'Resposta:', onSubmit: done, onCancel: () => done(null) }); this.render() }
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) return done(null)
      if (!options.length) return free()
      this.modal = new Picker({ title, filterable: false, maxVisible: this.cols < 60 ? 3 : 8, items: [...options.map((v) => ({ label: v, value: v })), { label: 'Escrever outra resposta', value: null }], onSelect: (it) => it.value === null ? free() : done(it.value), onCancel: () => done(null) })
      this.render()
    })
  }

  handlePaste(text) {
    if (this.modal) {
      if (this.modal.paste) this.modal.paste(text)
      else if (this.modal.filterable) this.modal.filter += text.replace(/\s+/g, ' ')
      return this.render()
    }
    this.editor.paste(text)
    this.afterEdit()
  }

  afterMove() {
    this.updatePopup()
    this.render()
  }

  afterEdit() {
    this.escAt = 0
    this.updatePopup()
    this.render()
  }

  onEscape() {
    if (this.popup) {
      this.popup = null
      return this.render()
    }
    if (this.busy) return this.interrupt()
    if (!this.editor.empty) {
      if (Date.now() - this.escAt < 1200) {
        this.editor.clear()
        this.escAt = 0
        return this.render()
      }
      this.escAt = Date.now()
      return this.toast('esc de novo para limpar', 1200)
    }
  }

  onCtrlC() {
    if (this.modal) {
      if (this.modal.onCancel) this.modal.onCancel()
      else this.modal.key('', { name: 'escape' })
      return this.render()
    }
    if (this.busy) {
      // segundo ctrl+c logo após interromper: o turno não respondeu ao abort, então sai de vez
      if (this.controller?.signal.aborted && Date.now() - this.interruptAt < 3000) return this.exit(0)
      return this.interrupt()
    }
    if (!this.editor.empty) {
      this.editor.clear()
      this.popup = null
      return this.render()
    }
    if (Date.now() - this.ctrlCAt < 2000) return this.exit(0)
    this.ctrlCAt = Date.now()
    this.toast('pressione ctrl+c de novo para sair', 2000)
  }

  interrupt() {
    this.loopStopped = true
    if (!this.controller) return
    this.controller.abort()
    this.interruptAt = Date.now()
    this.toast('interrompendo… (ctrl+c de novo força a saída)', 2000)
  }

  cycleMode() {
    const next = MODES[(MODES.indexOf(this.agent.mode) + 1) % MODES.length]
    this.setMode(next, { quiet: true })
  }

  setMode(mode, { quiet = false } = {}) {
    mode = MODES.find((v) => v.toLowerCase() === String(mode || '').trim().toLowerCase()) || ''
    if (!MODES.includes(mode)) {
      this.block(t.muted(`Modo atual: ${this.agent.mode.toUpperCase()}. Use /mode ${MODES.join(' | ')} (ou shift+tab).`))
      return
    }
    this.agent.mode = mode
    this.config.permissionMode = mode
    saveConfig({ permissionMode: mode })
    const desc = {
      yolo: 'YOLO — executa tudo sem pedir permissão',
      ask: 'ASK — pede confirmação antes de editar arquivos e rodar comandos',
      plan: 'PLAN — somente leitura; o agente investiga e propõe um plano',
      auto: 'AUTO — aprova ações sem regra de recusa',
      acceptEdits: 'EDITS — aprova edições e confirma comandos',
      dontAsk: 'DONTASK — recusa ações que exigiriam confirmação',
      bypassPermissions: 'BYPASS — aprovação automática; regras deny permanecem',
    }[mode]
    if (quiet) this.toast(desc, 2500)
    else this.block(t.primary('✓ ') + t.muted('Modo ') + modeBadge(mode) + t.muted(' ' + desc.split('—')[1]))
  }

  updatePopup() {
    const text = this.editor.text
    if (text.startsWith('/') && !/\s/.test(text)) {
      const items = matchCommands(this.commands, text.slice(1))
      this.popup = items.length ? { kind: 'command', items, index: 0 } : null
      return
    }
    const tok = this.editor.tokenAtCursor()
    if (tok.text.startsWith('@') && tok.end === this.editor.cursor) {
      const items = fuzzyFiles(this.fileList(), tok.text.slice(1)).slice(0, 60)
      this.popup = items.length ? { kind: 'file', items, index: 0, start: tok.start, end: tok.end } : null
      return
    }
    this.popup = null
  }

  acceptPopup(isEnter) {
    const p = this.popup
    if (!p) return false
    const it = p.items[p.index]
    if (!it) return false
    this.popup = null
    if (p.kind === 'command') {
      if (isEnter) {
        this.editor.setText('/' + it.name)
        this.submit()
      } else {
        this.editor.setText('/' + it.name + ' ')
        this.render()
      }
      return true
    }
    this.editor.replaceRange(p.start, p.end, '@' + it + ' ')
    this.render()
    return true
  }

  /**
   * Lista de arquivos para o @: carregada em segundo plano (rg com prazo e limite), nunca bloqueia a digitação.
   * Numa pasta enorme (ex.: a home) a lista pode vir parcial, mas a interface continua respondendo.
   */
  fileList() {
    const cwd = this.session.cwd
    const fresh = Date.now() - this.fileCache.at < 30000 && this.fileCache.cwd === cwd
    if (!fresh && !this.fileCache.loading) this.loadFileList(cwd)
    return this.fileCache.cwd === cwd ? this.fileCache.files : []
  }

  loadFileList(cwd) {
    this.fileCache.loading = true
    const done = (files) => {
      this.fileCache = { at: Date.now(), cwd, files: files.slice(0, 8000).sort(), loading: false }
      if (this.popup?.kind === 'file' || this.editor.tokenAtCursor().text.startsWith('@')) { this.updatePopup(); this.render() }
    }
    const fallback = () => walkAsync(cwd, { maxFiles: 8000, timeMs: 4000 }).then((w) => done(w.files), () => done([]))
    if (!ripgrep()) return fallback()
    const files = []
    let buf = ''
    const child = spawn('rg', ['--files', '--hidden', '--glob', '!.git', '--max-depth', '12'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8')
      const parts = buf.split('\n')
      buf = parts.pop()
      files.push(...parts.filter(Boolean))
      if (files.length >= 8000) child.kill('SIGKILL')
    })
    child.on('error', () => { clearTimeout(timer); fallback() })
    child.on('close', () => { clearTimeout(timer); done(files) })
  }

  // ─────────────────────────── envio ───────────────────────────

  submit() {
    if (!this.editor.text.trim()) return
    const text = this.editor.submit()
    this.popup = null
    if (this.busy) {
      if (/^\/loop\s+stop$/.test(text)) { this.loopStopped = true; this.interrupt(); return }
      const cmd = /^\/(\S+)/.exec(text)
      const found = cmd && findCommand(this.commands, cmd[1])
      if (found && SAFE_WHILE_BUSY.has(found.name)) return this.handleInput(text)
      this.queue.push(text)
      this.session.enqueue(text)
      this.toast('mensagem na fila — será enviada ao fim do turno', 2500)
      return this.render()
    }
    this.handleInput(text)
  }

  async handleInput(text) {
    try {
      if (text.startsWith('/') && !text.startsWith('//')) return await this.runCommand(text)
      if (text.startsWith('!')) return await this.runShell(text.slice(1).trim())
      if (text.startsWith('#') && !/^#{2,}/.test(text) && text.length > 1) return this.addMemory(text.slice(1).trim())
      return await this.submitPrompt(text)
    } catch (err) {
      this.logError(err)
    } finally {
      this.render()
    }
  }

  async runCommand(text) {
    text = text.replace(/^\/skill:([^\s]+)/, '/skill $1')
    const [, name, arg = ''] = /^\/(\S+)\s*([\s\S]*)$/.exec(text) || []
    const cmd = findCommand(this.commands, name || '')
    if (!cmd) {
      this.block(t.error(`Comando desconhecido: /${name}`) + t.muted('  (veja /help)'))
      return
    }
    await cmd.run(this, arg.trim())
  }

  expandMentions(text) {
    const cwd = this.session.cwd
    const attachments = []
    const notes = []
    const seen = new Set()
    for (const m of text.matchAll(/(^|\s)@([^\s]+)/g)) {
      const rel = m[2].replace(/[,.;:!?)\]]+$/, '')
      if (seen.has(rel)) continue
      seen.add(rel)
      const abs = resolvePath(cwd, rel)
      if (permissionDecision({ config: this.config, mode: this.agent.mode, tool: { name: 'read', readOnly: true }, args: { path: abs }, cwd }) === 'deny') { notes.push(`${rel} (negado pela regra de leitura)`); continue }
      let st
      try {
        st = fs.statSync(abs)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        const entries = walk(abs, { maxFiles: 200, includeDirs: true })
        attachments.push(`<diretorio caminho="${rel}">\n${entries.join('\n')}\n</diretorio>`)
        notes.push(`${rel}/ (${entries.length} itens)`)
      } else if (st.size <= 256 * 1024) {
        const buf = fs.readFileSync(abs)
        if (isBinaryBuffer(buf)) continue
        const content = buf.toString('utf8')
        attachments.push(`<arquivo caminho="${rel}">\n${content}\n</arquivo>`)
        notes.push(`${rel} (${content.split('\n').length} linhas)`)
      } else notes.push(`${rel} (grande demais para anexar: ${(st.size / 1024).toFixed(0)} KB)`)
    }
    if (notes.length) this.log(notes.map((n, i) => t.muted(i === 0 ? '  └  anexou ' : '     anexou ') + t.info(n)))
    return attachments.length ? `${text}\n\n${attachments.join('\n\n')}` : text
  }

  async submitPrompt(text, { echo = true } = {}) {
    if (echo) this.logUser(text)
    const mention = /^@([\w-]+)\s+([\s\S]+)/.exec(text)
    if (mention && discoverAgents(this.session.cwd).some((v) => v.name === mention[1] && v.mode !== 'primary')) {
      return this.runAgent(`Use a ferramenta task com subagent_type=${mention[1]} para esta tarefa: ${mention[2]}`)
    }
    const content = this.expandMentions(text)
    await this.runAgent(content)
  }

  async runAgent(content) {
    this.busy = true
    this.controller = new AbortController()
    this.live = this.freshLive()
    this.startSpinner()
    this.render()
    this.lastRunError = null
    try {
      await this.agent.run(content, { signal: this.controller.signal })
    } catch (err) {
      this.lastRunError = err
      this.finishText()
      if (isAbortError(err) || this.controller?.signal.aborted) this.block(t.warn('└  Interrompido pelo usuário') + t.muted(' · diga o que fazer em vez disso'))
      else this.logError(err)
    } finally {
      this.busy = false
      this.controller = null
      this.stopSpinner()
      this.live = this.freshLive()
      this.render()
      this.drainQueue()
    }
  }

  drainQueue() {
    if (this.busy || this.loopRunning || this.draining || !this.session.inbox.length) return
    const session = this.session, entry = session.inbox[0]
    this.draining = true
    this.activeInboxId = entry.id
    setImmediate(async () => {
      try { await this.handleInput(entry.text); session.acknowledge(entry.id) }
      finally { this.draining = false; this.activeInboxId = null; this.queue = this.session.inbox.map((e) => e.text); this.drainQueue() }
    })
  }

  async runShell(cmd) {
    if (!cmd) return
    this.block(t.tongue('! ') + t.text(cmd))
    this.busy = true
    this.controller = new AbortController()
    this.live = this.freshLive()
    this.live.tool = { label: 'shell', name: 'bash', started: Date.now() }
    this.startSpinner()
    const session = this.session
    const ctx = {
      get cwd() {
        return session.cwd
      },
      setCwd: (d) => (session.cwd = d),
      signal: this.controller.signal,
      config: this.config,
      onProgress: (c) => {
        this.live.toolOutput += c
        this.schedule()
      },
    }
    try {
      const res = await bash.run({ command: cmd }, ctx)
      const out = (res.display?.output ?? res.output).split('\n')
      const shown = out.slice(0, 30)
      const lines = shown.map((l, i) => t.muted(i === 0 ? '  └  ' : '     ') + t.text(truncate(l, this.cols - 7)))
      if (out.length > shown.length) lines.push('     ' + t.muted(`… +${out.length - shown.length} linhas (ctrl+o expande)`))
      if (res.display?.failed) lines.push('     ' + t.warn(res.display.summary))
      this.lastOutput = { title: `! ${cmd}`, text: res.display?.output ?? res.output }
      this.log(lines)
      session.messages.push({ role: 'user', synthetic: true, content: `[O usuário executou um comando no shell]\n<comando>${cmd}</comando>\n<saida>\n${res.output}\n</saida>` })
      session.save()
    } finally {
      this.busy = false
      this.controller = null
      this.stopSpinner()
      this.live = this.freshLive()
      this.render()
      this.drainQueue()
    }
  }

  addMemory(text) {
    if (!text) return
    const file = path.join(this.session.cwd, 'SNAKE.md')
    const exists = fs.existsSync(file)
    const prefix = exists ? (fs.readFileSync(file, 'utf8').endsWith('\n') ? '' : '\n') : '# SNAKE.md\n\nInstruções do projeto para o agente Snake.\n\n'
    fs.appendFileSync(file, `${prefix}- ${text}\n`)
    this.block(t.primary('✓ ') + t.muted(`Anotado em ${shortPath(file)}: `) + t.text(text))
  }

  // ─────────────────────────── permissões ───────────────────────────

  askPermission(req) {
    const promise = this.interactionQueue.then(() => this.askPermissionNow(req))
    this.interactionQueue = promise.catch(() => {})
    return promise
  }
  askPermissionNow({ call, tool, args, summary, signal = this.controller?.signal }) {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve('deny')
      this.finishText()
      const running = call && this.live.running.get(call.id)
      if (running) running.waiting = true
      const header = [toolTitle(tool.label, summary, this.cols - 8)]
      if (tool.name === 'bash' && String(args.command || '').includes('\n')) header.push(...String(args.command).split('\n').slice(0, 6).map((l) => t.subtle('  ' + l)))
      if (tool.name === 'edit' && args.old_string != null) {
        header.push(...String(args.old_string).split('\n').slice(0, 3).map((l) => t.removed('- ' + l)))
        header.push(...String(args.new_string ?? '').split('\n').slice(0, 3).map((l) => t.added('+ ' + l)))
      }
      header.push('')
      const done = (v) => {
        signal?.removeEventListener('abort', abort)
        this.modal = null
        if (running) { running.waiting = false; running.started = Date.now() }
        resolve(v)
        this.render()
      }
      const abort = () => done('deny')
      signal?.addEventListener('abort', abort, { once: true })
      this.modal = new Picker({
        title: 'Permitir esta ação?',
        header,
        filterable: false,
        color: t.warn,
        items: [
          { label: 'Sim', value: 'allow' },
          { label: `Sim, e não perguntar de novo para ${tool.label} nesta sessão`, value: 'always' },
          { label: 'Sempre para este comando/caminho exato nesta sessão', value: 'pattern' },
          { label: 'Não — diga ao agente o que fazer diferente', value: 'deny' },
        ],
        footer: '1-4 ou ↑↓ + enter · esc nega',
        onSelect: (it) => done(it.value),
        onCancel: () => done('deny'),
      })
      this.render()
    })
  }

  // ─────────────────────────── comandos ───────────────────────────

  showHelp() {
    const cols = this.cols
    const nameW = cols < 60 ? 11 : 13
    const one = (c) => {
      const name = '/' + c.name
      const desc = c.description + (c.custom ? ' (personalizado)' : '')
      if (cols < 40) return ['  ' + t.accent(name), '    ' + t.muted(truncate(desc, cols - 5))]
      const w = Math.max(nameW, strWidth(name))
      return ['  ' + padEnd(t.accent(name), w) + ' ' + t.muted(truncate(desc, Math.max(4, cols - w - 4)))]
    }
    const lines = []
    const shown = new Set()
    for (const [title, names] of COMMAND_GROUPS) {
      const list = names.map((n) => this.commands.find((c) => c.name === n)).filter(Boolean)
      if (!list.length) continue
      lines.push(t.bold(t.primary(title)))
      for (const c of list) { lines.push(...one(c)); shown.add(c.name) }
      lines.push('')
    }
    const rest = this.commands.filter((c) => !shown.has(c.name))
    if (rest.length) {
      lines.push(t.bold(t.primary(rest.every((c) => c.custom) ? 'Personalizados' : 'Outros')))
      for (const c of rest) lines.push(...one(c))
      lines.push('')
    }
    lines.push(t.bold(t.primary('Atalhos')))
    const keys = [
      ['enter', 'enviar (durante uma resposta: enfileira)'],
      ['alt+enter', 'nova linha (também \\+enter e ctrl+j)'],
      ['esc', 'interromper · esc esc limpa a entrada'],
      ['ctrl+c', 'interromper / limpar / sair (2x)'],
      ['shift+tab', 'alternar modo de permissão'],
      ['tab', 'completar comando ou @arquivo; trocar agente'],
      ['↑ ↓', 'histórico de mensagens'],
      ['ctrl+o', 'expandir a última saída truncada'],
      ['ctrl+l', 'limpar a tela'],
      ['ctrl+z', 'suspender (volte com fg)'],
    ]
    for (const [k, d] of keys) lines.push(...(cols < 40 ? ['  ' + t.accent(k), '    ' + t.muted(truncate(d, cols - 5))] : ['  ' + padEnd(t.accent(k), nameW) + ' ' + t.muted(truncate(d, cols - nameW - 4))]))
    lines.push('', t.bold(t.primary('Prefixos')))
    for (const [k, d] of [['!comando', 'roda no shell e mostra ao agente'], ['#nota', 'anota uma instrução no SNAKE.md'], ['@arquivo', 'anexa arquivo ou pasta à mensagem'], ['@agente', 'delega a mensagem a um subagente']]) lines.push('  ' + padEnd(t.accent(k), nameW) + ' ' + t.muted(truncate(d, cols - nameW - 4)))
    lines.push('', ...wrapText('Comandos personalizados: crie .snake/commands/<nome>.md (use $ARGUMENTS).', cols - 3).map((l) => t.subtle(l)))
    this.block(lines)
  }

  async openModelPicker(filter = '') {
    this.toast('carregando modelos…', 1500)
    await Promise.race([this.catalog.refreshStale({ wait: true }), new Promise((r) => setTimeout(r, 8000))])
    await this.catalog.loadLive({ timeout: 1200 })
    this.toastMsg = null
    if (filter.includes('--refresh')) { await Promise.all(['modelsdev', 'openrouter', 'pollinations', 'llm7'].map((source) => this.catalog.refresh(source))); filter = filter.replace('--refresh', '').trim() }
    if (this.catalog.removed?.length) this.log(t.muted(`${this.catalog.removed.length} modelos removidos do catálogo remoto.`))
    const arg = filter.trim()
    const showAll = /^(todos|all|pagos)$/i.test(arg)
    const onlyFree = /^(grátis|gratis|free)$/i.test(arg)
    const currentProvider = this.agent.model.provider
    // Ordem: grátis sem chave → provedores com chave/locais → grátis que pedem chave gratuita → resto.
    const groups = []
    for (const p of Object.values(PROVIDERS)) {
      const usable = isUsable(p.id)
      let list = this.catalog.models(p.id).filter((m) => m.tools !== false)
      if (onlyFree) list = list.filter((m) => m.free)
      else if (!usable && !showAll && !arg && p.id !== currentProvider) list = p.id === 'openrouter' ? list.filter((m) => m.free) : []
      if (!list.length) continue
      list.sort((a, b) => Number(!!b.free) - Number(!!a.free) || a.id.localeCompare(b.id))
      const rank = usable ? (p.free === 'nokey' ? 0 : p.free === 'local' ? 2 : 1) : list.every((m) => m.free) ? 3 : 4
      groups.push({ p, list, rank })
    }
    groups.sort((a, b) => a.rank - b.rank)
    const items = []
    for (const { p, list } of groups) {
      const needsKey = p.keyRequired && !resolveKey(p.id)
      const access = resolveKey(p.id) ? 'chave ✓' : needsKey ? (list.every((m) => m.free) ? 'chave grátis' : 'requer chave') : p.free === 'local' ? 'local' : 'sem chave'
      for (const m of list) {
        const unavailable = availability(m)
        const cost = unavailable?.label || costLabel(m)
        const hint = [`${p.id}/${m.id}`, m.toolCheck?.ok ? '✓ tools' : 'tools não verificado', m.benchmark ? `código ${m.benchmark.score}/100` : 'código sem nota', needsKey ? `requer chave${m.free ? ' grátis' : ''}: /key ${p.id}` : '', priceSentence(m)]
        items.push({
          label: m.id,
          cost,
          ctx: m.context ? fmtTokens(m.context) : '',
          value: `${p.id}/${m.id}`,
          group: `${p.name} · ${access}`,
          tone: m.free && !unavailable ? 'free' : undefined,
          disabled: !!unavailable,
          hint: hint.filter(Boolean).join(' · '),
          search: `${p.id} ${p.name} ${m.name || ''} ${m.free ? 'gratis grátis free' : 'pago'}`,
        })
      }
    }
    // Colunas alinhadas: custo à esquerda, contexto à direita.
    const costW = Math.min(12, Math.max(0, ...items.map((i) => strWidth(i.cost))))
    for (const it of items) it.detail = padEnd(it.cost, costW) + ' ' + it.ctx.padStart(5)
    const current = this.agent.modelRef
    const initial = Math.max(0, items.findIndex((i) => i.value === current))
    this.modal = new Picker({
      title: 'Modelos',
      header: [t.subtle(showAll ? 'todos os provedores, inclusive pagos' : '/models todos → inclui pagos e outros provedores')],
      items,
      initial,
      placeholder: 'nome, provedor ou "grátis"',
      maxVisible: this.cols < 60 ? 3 : Math.max(6, Math.min(16, this.term.rows - 10)),
      footer: '↑↓ mover · enter escolher · esc sair',
      onSelect: (it) => {
        this.modal = null
        this.setModel(it.value)
      },
      onCancel: () => {
        this.modal = null
        this.render()
      },
    })
    if (filter && !showAll && !onlyFree) {
      this.modal.filter = filter
      this.modal.index = 0
    }
    this.render()
  }

  setModel(ref) {
    const m = this.catalog.find(ref)
    if (!m) {
      this.block(t.error(`Modelo não encontrado: ${ref}`) + t.muted('  (use /models para ver a lista)'))
      return
    }
    const full = `${m.provider}/${m.id}`
    const previous = this.session.model
    this.session.model = full
    this.session.event('model', { from: previous, to: full })
    this.session.save()
    if (/^(openrouter\/)?(free|auto)$/.test(m.id)) this.block(t.warn('Este roteador pode mudar o modelo que processa seu conteúdo. O provedor selecionado receberá os dados enviados.'))
    const p = PROVIDERS[m.provider]
    this.block(t.primary('✓ ') + t.muted('Modelo: ') + t.primary(full) + t.muted(` · contexto ${fmtTokens(m.context || DEFAULT_CONTEXT)} · `) + this.modelStatus(m))
    if (p?.keyRequired && !resolveKey(p.id)) {
      this.openKeyPrompt(p.id, {
        onSaved: () => saveConfig({ model: full }),
        onCancel: () => {
          this.session.model = previous
          this.block(t.muted(`Sem chave — voltando para ${previous}.`))
        },
      })
    } else saveConfig({ model: full })
    this.render()
  }

  openKeyPrompt(providerId, { onSaved, onCancel } = {}) {
    const p = PROVIDERS[providerId]
    if (!p) return
    this.block(t.muted(`${p.name} precisa de uma chave de API.`) + (p.keyURL ? t.muted(' Crie em: ') + t.info(p.keyURL) : ''))
    this.modal = new Prompt({
      title: `Chave de API · ${p.name}`,
      label: 'cole a chave:',
      secret: true,
      onSubmit: (v) => {
        this.modal = null
        if (v) {
          setKey(providerId, v)
          this.block(t.primary('✓ ') + t.muted(`Chave de ${p.name} salva em ${shortPath(paths.auth)} (permissão 600)`))
          onSaved?.()
        } else onCancel?.()
        this.render()
      },
      onCancel: () => {
        this.modal = null
        onCancel?.()
        this.render()
      },
    })
    this.render()
  }

  keyCommand(arg) {
    const [id, key] = arg.split(/\s+/).filter(Boolean)
    if (id && PROVIDERS[id]) {
      if (key) {
        setKey(id, key)
        this.block(t.primary('✓ ') + t.muted(`Chave de ${PROVIDERS[id].name} salva em ${shortPath(paths.auth)}`))
      } else this.openKeyPrompt(id)
      return
    }
    const rank = (p) => (p.id === 'openrouter' ? 0 : p.free === 'key' ? 1 : p.keyRequired ? 2 : 3)
    const items = Object.values(PROVIDERS)
      .filter((p) => p.keyRequired || p.env?.length)
      .sort((a, b) => rank(a) - rank(b))
      .map((p) => ({
        label: p.name,
        detail: resolveKey(p.id) ? '✓ configurada' : freeLabel(p),
        tone: !resolveKey(p.id) && p.free === 'key' ? 'free' : undefined,
        value: p.id,
        hint: [p.note, p.keyURL && 'chave em ' + p.keyURL.replace(/^https?:\/\//, '')].filter(Boolean).join(' · '),
        search: p.id,
      }))
    this.modal = new Picker({
      title: 'Chave de API',
      header: [t.subtle('OpenRouter: chave grátis libera os modelos :free')],
      items,
      onSelect: (it) => {
        this.modal = null
        this.openKeyPrompt(it.value)
      },
      onCancel: () => {
        this.modal = null
        this.render()
      },
    })
    this.render()
  }

  logoutCommand(arg) {
    const id = arg.trim()
    if (!id || !PROVIDERS[id]) return this.block(t.muted('Use: /logout <provedor>'))
    setKey(id, null)
    this.block(t.primary('✓ ') + t.muted(`Chave salva de ${id} removida (variáveis de ambiente não são alteradas).`))
  }

  showProviders() {
    const cols = this.cols
    const lines = [t.bold(t.primary('Provedores'))]
    for (const p of Object.values(PROVIDERS)) {
      const k = resolveKey(p.id)
      const status = k ? t.primary('✓ chave') : !p.keyRequired ? t.primary(p.free === 'local' ? '• local' : '✓ sem chave') : t.subtle('✗ sem chave')
      const freeCount = p.free === 'local' ? 0 : this.catalog.models(p.id).filter((m) => m.free).length
      const plan = p.free === 'key' && freeCount
        ? (p.id === 'openrouter' ? t.accent(`${freeCount} modelos :free grátis`) : t.muted(freeLabel(p)) + t.accent(` · ${freeCount} grátis`))
        : t.muted(freeLabel(p))
      if (cols < 72) lines.push('  ' + padEnd(truncate(t.accent(p.name), Math.max(1, cols - 18)), Math.max(1, cols - 18)) + ' ' + status, '    ' + truncate(plan, cols - 6))
      else lines.push('  ' + padEnd(t.accent(p.id), 13) + ' ' + padEnd(t.text(p.name), 19) + ' ' + padEnd(status, 13) + ' ' + plan)
    }
    lines.push('', ...wrapText('Salvar chave: /key <provedor> · Trocar modelo: /models · Variáveis de ambiente também funcionam (ex.: OPENROUTER_API_KEY)', cols - 3).map((l) => t.muted(l)))
    this.block(lines)
  }

  usageLines() {
    const u = this.session.usage
    const T = u.total
    const m = this.agent.model
    const cols = Math.min(this.cols - 1, 100)
    if (cols < 78) {
      const width = cols - 4
      const row = (label, value) => '  ' + padEnd(label, Math.max(strWidth(label) + 1, width - strWidth(value))) + value
      return [
        t.bold(t.primary('Consumo da sessão')),
        row('Entrada sem cache', fmtInt(T.input)),
        row('Cache lido (KV)', fmtInt(T.cacheRead)),
        row('Cache gravado', fmtInt(T.cacheWrite)),
        row('Saída', fmtInt(T.output)),
        row('Custo', costText(T, m)),
        row('Requisições', String(T.requests)),
        row('Acerto de cache', fmtPercent(cacheHitRate(T))),
        ...wrapText(`Contexto: ${fmtTokens(u.contextTokens)} / ${fmtTokens(m.context || DEFAULT_CONTEXT)} tokens`, width).map((l) => '  ' + t.muted(l)),
        ...(T.estimated ? [t.muted('  ~ tokens estimados')] : []),
        ...(T.costUnknown ? [t.muted('  $? custo não informado pela API')] : []),
        ...(T.costEstimated ? [t.muted('  ~ custo estimado pelo catálogo')] : []),
        ...Object.entries(u.byModel).flatMap(([ref, mu]) => [
          ...wrapText(ref, width).map((l) => '  ' + t.primary(l)),
          '    ' + t.muted(`↑${fmtTokens(mu.input)} ↓${fmtTokens(mu.output)} · ${costText(mu, this.catalog.find(ref))}`),
        ]),
      ]
    }
    const inner = cols - 4
    const b = t.border
    const row = (s = '') => b('│ ') + padEnd(truncate(s, inner), inner) + b(' │')
    const allFree = Object.keys(u.byModel).every((ref) => this.catalog.find(ref)?.free)
    const money = (v) => ((T.costUnknown || allFree) && !v ? t.subtle('—') : t.text(fmtCost(v)))
    const line = (label, tok, cost, note = '') => row(`  ${t.muted(padEnd(label, 22))}${t.text(fmtInt(tok).padStart(12))} tok   ${padEnd(money(cost), 10)} ${t.subtle(note)}`)
    const prompt = T.input + T.cacheRead + T.cacheWrite
    const out = []
    const title = ' Consumo de tokens '
    out.push(b('╭─') + t.bold(t.primary(title)) + b('─'.repeat(Math.max(0, cols - 3 - strWidth(title))) + '╮'))
    out.push(row(t.muted(`Sessão ${this.session.id} · ${T.requests} requisições · tempo de API ${fmtDuration(T.apiMs)}`)))
    out.push(row())
    out.push(line('Entrada (sem cache)', T.input, T.costIn))
    out.push(line('Cache lido (KV hit)', T.cacheRead, T.costCacheRead, 'reaproveitado do cache'))
    out.push(line('Cache gravado', T.cacheWrite, T.costCacheWrite, 'prefixo salvo p/ reuso'))
    out.push(line('Saída', T.output, T.costOut))
    if (T.reasoning) out.push(row(`    ${t.subtle('└ raciocínio')}${' '.repeat(10)}${t.subtle(fmtInt(T.reasoning).padStart(12) + ' tok')}`))
    out.push(row('  ' + t.borderDim('─'.repeat(Math.min(56, inner - 4)))))
    out.push(row(`  ${t.bold(padEnd('Total', 22))}${t.bold(fmtInt(prompt + T.output).padStart(12))} tok   ${t.bold(costText(T, m))}`))
    out.push(row())
    const hit = cacheHitRate(T)
    out.push(row(`  ${t.muted(padEnd('Acerto de cache (KV)', 22))}${t.primary(bar(hit, 12))} ${t.text(fmtPercent(hit))}`))
    const limit = m.context || DEFAULT_CONTEXT
    const frac = Math.min(1, u.contextTokens / limit)
    out.push(row(`  ${t.muted(padEnd('Contexto atual', 22))}${(frac > 0.85 ? t.error : frac > 0.6 ? t.warn : t.primary)(bar(frac, 12))} ${t.text(`${fmtTokens(u.contextTokens)} / ${fmtTokens(limit)} (${fmtPercent(frac)})`)}`))
    if (T.genMs > 0 && T.output) {
      out.push(row(`  ${t.muted(padEnd('Velocidade', 22))}${t.text(`${Math.round(T.output / (T.genMs / 1000))} tok/s · 1º token em ${fmtDuration(T.ttftMs / Math.max(1, T.requests))} (média)`)}`))
    }
    if (u.turn?.requests) {
      const tu = u.turn
      out.push(row(`  ${t.muted(padEnd('Último turno', 22))}${t.text(`↑ ${fmtTokens(tu.input + tu.cacheWrite)} ↓ ${fmtTokens(tu.output)} · cache ${fmtTokens(tu.cacheRead)} · ${costText(tu, m)} · ${tu.requests} req`)}`))
    }
    if (T.estimated) out.push(row(t.subtle('  ~ alguns valores foram estimados (o provedor não informou o uso)')))
    if (T.costUnknown) out.push(row(t.subtle('  custo incompleto: há requisições sem preço informado')))
    const models = Object.entries(u.byModel)
    if (models.length) {
      out.push(row())
      out.push(row(t.bold('  Por modelo')))
      for (const [ref, mu] of models.sort((a, b) => b[1].cost - a[1].cost)) {
        const meta = this.catalog.find(ref)
        const tok = mu.input + mu.output + mu.cacheRead + mu.cacheWrite
        out.push(row(`  ${t.text(padEnd(truncate(ref, 44), 45))}${t.muted(fmtTokens(tok).padStart(7) + ' tok')}  ${t.text(costText(mu, meta))}`))
      }
    }
    if (m.pricing && !m.free) {
      out.push(row())
      out.push(row(t.subtle(`  Preços de ${m.id} por 1M tokens: entrada $${fmtPrice(m.pricing.input)} · saída $${fmtPrice(m.pricing.output)}${m.pricing.cacheRead != null ? ` · cache lido $${fmtPrice(m.pricing.cacheRead)}` : ''}${m.pricing.cacheWrite != null ? ` · cache gravado $${fmtPrice(m.pricing.cacheWrite)}` : ''}`)))
    }
    out.push(b('╰' + '─'.repeat(cols - 2) + '╯'))
    return out
  }

  showUsage() {
    this.block(this.usageLines())
  }

  showContext() {
    const m = this.agent.model
    const limit = m.context || DEFAULT_CONTEXT
    const e = this.agent.estimateContext(m)
    const estTotal = e.system + e.tools + e.messages
    const real = this.session.usage.contextTokens
    const scale = real && estTotal ? real / estTotal : 1
    const sys = Math.round(e.system * scale)
    const tools = Math.round(e.tools * scale)
    const msgs = Math.max(0, (real || estTotal) - sys - tools)
    const used = sys + tools + msgs
    const reserve = this.config.autoCompact ? Math.round(limit * (1 - (this.config.compactThreshold || 0.85))) : 0
    const free = Math.max(0, limit - used - reserve)
    const cells = Math.max(10, Math.min(50, this.cols - 6))
    const cellOf = (v) => Math.round((v / limit) * cells)
    const parts = [
      [cellOf(sys), t.emerald, '■'],
      [cellOf(tools), t.info, '■'],
      [Math.max(used ? 1 : 0, cellOf(msgs)), t.primary, '■'],
    ]
    let grid = ''
    let n = 0
    for (const [k, color, ch] of parts) {
      grid += color(ch.repeat(Math.max(0, Math.min(k, cells - n))))
      n += Math.max(0, Math.min(k, cells - n))
    }
    const reserveCells = Math.min(cells - n, cellOf(reserve))
    grid += t.subtle('□'.repeat(Math.max(0, cells - n - reserveCells))) + t.warn('▨'.repeat(Math.max(0, reserveCells)))
    const pct = (v) => fmtPercent(v / limit, 1)
    const wide = this.cols >= 72
    const entry = (mark, label, v, note) => `  ${mark} ${padEnd(t.text(label), 21)} ${t.muted(`${fmtTokens(v).padStart(6)}  ${pct(v).padStart(5)}`)}${note && wide ? ' ' + t.subtle(`(${note})`) : ''}`
    const lines = [
      ...wrapText(t.bold(t.primary('Janela de contexto')) + t.muted(` · ${fmtTokens(used)} de ${fmtTokens(limit)} tokens (${pct(used)})`), this.cols - 3),
      '  ' + grid,
      '',
      entry(t.emerald('■'), 'Prompt de sistema', sys),
      entry(t.info('■'), 'Ferramentas', tools, `${this.agent.tools().length} ferramentas`),
      entry(t.primary('■'), 'Mensagens', msgs, `${this.session.messages.length} mensagens`),
      entry(t.subtle('□'), 'Livre', free),
    ]
    if (reserve) lines.push(entry(t.warn('▨'), 'Reserva p/ compactar', reserve, 'auto-compacta ao chegar aqui'))
    if (!real) lines.push(...wrapText('valores estimados (≈ 4 caracteres por token) até a primeira resposta do modelo', this.cols - 5).map((l) => '  ' + t.subtle(l)))
    this.block(lines)
  }

  async compact(instructions = '') {
    if (this.busy) return this.toast('aguarde o fim do turno para compactar')
    if (!this.session.messages.length) return this.block(t.muted('Nada para compactar ainda.'))
    this.busy = true
    this.controller = new AbortController()
    this.live = this.freshLive()
    this.startSpinner()
    try {
      await this.agent.compact({ signal: this.controller.signal, instructions })
    } catch (err) {
      if (isAbortError(err)) this.block(t.warn('Compactação cancelada.'))
      else this.logError(err)
    } finally {
      this.busy = false
      this.controller = null
      this.stopSpinner()
      this.live = this.freshLive()
      this.render()
    }
  }

  newSession() {
    if (this.busy) return this.toast('aguarde o fim do turno (ou esc para interromper)')
    this.session.save()
    const model = this.session.model
    const pending = this.session.inbox.splice(0).filter((entry) => entry.id !== this.activeInboxId)
    this.session.saveInbox()
    this.session = Session.create({ cwd: this.session.cwd, model })
    this.session.inbox = pending
    this.session.saveInbox()
    this.queue = pending.map((e) => e.text)
    this.agent = this.createAgent(this.session)
    this.term.clearScreen()
    this.lastBlank = true
    this.printWelcome()
    this.block(t.primary('✓ ') + t.muted('Nova conversa iniciada (a anterior foi salva; retome com /resume).'))
  }

  openSessionPicker() {
    const list = Session.list({ limit: 200 })
    if (!list.length) return this.block(t.muted('Nenhuma sessão salva ainda.'))
    const cwd = this.session.cwd
    const items = list
      .sort((a, b) => Number(b.cwd === cwd) - Number(a.cwd === cwd) || b.updated - a.updated)
      .map((s) => ({
        label: s.title || s.id,
        detail: `${fmtAgo(s.updated)} · ${s.messages} msgs${s.cost ? ' · ' + fmtCost(s.cost) : ''}`,
        value: s.id,
        group: s.cwd === cwd ? 'Este diretório' : `Outros diretórios`,
        search: `${s.id} ${s.cwd}`,
      }))
    this.modal = new Picker({
      title: 'Retomar sessão',
      items,
      maxVisible: Math.max(6, Math.min(14, this.term.rows - 10)),
      onSelect: (it) => {
        this.modal = null
        this.resumeSession(it.value)
      },
      onCancel: () => {
        this.modal = null
        this.render()
      },
    })
    this.render()
  }

  resumeSession(id) {
    if (this.busy) return this.toast('aguarde o fim do turno')
    const s = Session.load(id)
    if (!s) return this.block(t.error(`Sessão não encontrada: ${id}`))
    this.session.save()
    this.session = s
    this.queue = s.inbox.map((e) => e.text)
    if (!fs.existsSync(s.cwd)) s.cwd = process.cwd()
    this.agent = this.createAgent(s)
    this.replay(s)
    this.drainQueue()
    this.block(t.primary('✓ ') + t.muted(`Sessão retomada: `) + t.text(s.title || s.id) + t.muted(` · ${s.messages.length} mensagens · ${shortPath(s.cwd)}`))
  }

  replay(s, max = 40) {
    const msgs = s.messages.slice(-max)
    if (s.messages.length > max) this.block(t.subtle(`… ${s.messages.length - max} mensagens anteriores ocultas`))
    for (const m of msgs) {
      if (m.role === 'user') {
        if (m.synthetic) this.block(t.subtle('  ' + truncate(m.content.split('\n')[0], this.cols - 4)))
        else this.logUser(m.content.split('\n\n<arquivo')[0])
      } else if (m.role === 'assistant') {
        if (m.content?.trim()) {
          const lines = renderMarkdown(m.content.trim(), this.cols - 3)
          this.block(lines.map((l, i) => (i === 0 ? t.primary('● ') : '  ') + l))
        }
        for (const tc of m.toolCalls || []) {
          const tool = this.agent.tools().find((x) => x.name === tc.name)
          let summary = ''
          try {
            summary = tool?.summary?.(JSON.parse(tc.args || '{}'), { cwd: s.cwd }) || ''
          } catch {}
          this.log(t.subtle('● ') + t.muted(`${tool?.label || tc.name} ${truncate(String(summary).replace(/\s+/g, ' '), Math.max(8, this.cols - 16))}`.trimEnd()))
        }
      }
    }
  }

  async initProject() {
    const existing = ['SNAKE.md', 'AGENTS.md', 'CLAUDE.md'].find((f) => fs.existsSync(path.join(this.session.cwd, f)))
    const prompt = `Analise este projeto e ${existing ? `melhore o arquivo ${existing} existente (ou crie um SNAKE.md se fizer mais sentido)` : 'crie um arquivo SNAKE.md na raiz'} com instruções para agentes de código que vão trabalhar aqui. Inclua, de forma concisa (até ~80 linhas):
1. Visão geral do projeto (o que é, stack principal)
2. Comandos de build, testes (incluindo como rodar um teste só), lint e execução
3. Arquitetura e diretórios importantes
4. Convenções de código e estilo usadas no projeto
5. Cuidados e armadilhas (gotchas)
Investigue os arquivos de manifesto, README e a estrutura antes de escrever. Não invente comandos que não existem.`
    this.block(t.accent('❯ /init ') + t.muted(existing ? `melhorando ${existing}…` : 'analisando o projeto para criar o SNAKE.md…'))
    await this.submitPrompt(prompt, { echo: false }).catch(() => {})
  }

  showMemory() {
    const files = findInstructionFiles(this.session.cwd)
    const lines = [t.bold(t.primary('Instruções carregadas no prompt'))]
    if (!files.length) lines.push(t.muted('  nenhuma — crie um SNAKE.md com /init ou anote com "# sua instrução"'))
    for (const f of files) {
      let n = 0
      try {
        n = fs.readFileSync(f, 'utf8').split('\n').length
      } catch {}
      lines.push('  ' + t.text(shortPath(f)) + t.muted(` (${n} linhas)`))
    }
    lines.push(t.subtle(`  Ordem: global (${shortPath(paths.memory)}) e, do diretório raiz até o atual, o primeiro de SNAKE.md / AGENTS.md / CLAUDE.md.`))
    this.block(lines)
  }

  showTodos() {
    const todos = this.session.todos || []
    if (!todos.length) return this.block(t.muted('Sem tarefas no momento. O agente cria uma lista para trabalhos com várias etapas.'))
    this.block([t.bold(t.primary('Tarefas')), ...this.todoLines(todos, this.cols)])
  }

  async undo() {
    if (this.busy) return this.toast('aguarde o fim do turno')
    const restored = await this.agent.undo()
    if (!restored?.length) return this.block(t.muted('Nada para desfazer.'))
    this.block([
      t.primary('✓ ') + t.muted(`Desfeito: ${restored.length} arquivo(s) restaurado(s)`),
      ...restored.map((r) => t.muted('  └  ') + t.text(shortPath(r.path)) + (r.deleted ? t.subtle(' (removido — havia sido criado)') : '')),
    ])
    this.session.messages.push({ role: 'user', synthetic: true, content: `[O usuário desfez (/undo) as alterações do último turno nos arquivos: ${restored.map((r) => r.path).join(', ')}]` })
  }

  exportSession(arg) {
    const s = this.session
    const file = resolvePath(s.cwd, arg || `snake-${s.id}.md`)
    const lines = [`# ${s.title || 'Sessão Snake'}`, '', `- Sessão: ${s.id}`, `- Modelo: ${s.model}`, `- Pasta: ${s.cwd}`, `- Exportado em: ${new Date().toISOString()}`, '']
    for (const m of s.messages) {
      if (m.role === 'user') lines.push(`## 🧑 Usuário`, '', m.content, '')
      else if (m.role === 'assistant') {
        lines.push(`## 🐍 Snake`, '')
        if (m.content) lines.push(m.content, '')
        for (const tc of m.toolCalls || []) lines.push(`> 🔧 \`${tc.name}\` ${'`'}${String(tc.args).slice(0, 300)}${'`'}`, '')
      } else if (m.role === 'tool') {
        const c = String(m.content)
        lines.push('<details><summary>resultado de ' + m.name + '</summary>', '', '```', c.length > 3000 ? c.slice(0, 3000) + '\n…' : c, '```', '</details>', '')
      }
    }
    const T = s.usage.total
    lines.push('---', `Tokens: entrada ${T.input}, saída ${T.output}, cache lido ${T.cacheRead}, cache gravado ${T.cacheWrite} · custo ${fmtCost(T.cost)}`)
    fs.writeFileSync(file, lines.join('\n'))
    this.block(t.primary('✓ ') + t.muted('Conversa exportada para ') + t.text(shortPath(file)))
  }

  copyLast() {
    if (!this.lastAnswer) return this.toast('nenhuma resposta para copiar')
    const b64 = Buffer.from(this.lastAnswer, 'utf8').toString('base64')
    process.stdout.write(`\x1b]52;c;${b64}\x07`)
    this.toast('última resposta copiada (OSC 52)')
  }

  toggleThinking() {
    this.config.showThinking = this.config.showThinking === false
    saveConfig({ showThinking: this.config.showThinking })
    this.block(t.primary('✓ ') + t.muted(`Raciocínio do modelo: ${this.config.showThinking ? 'visível' : 'oculto'}`))
  }

  showMcp() {
    const lines = [t.bold(t.primary('Servidores MCP'))]
    if (!this.mcp.size) {
      lines.push(t.muted('  nenhum configurado. Adicione em ~/.snake/config.json:'))
      lines.push(t.subtle('  "mcp": { "arquivos": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] } }'))
    }
    for (const c of this.mcp.clients) {
      const st = c.status === 'ok' ? t.primary('✓ conectado') : c.status === 'conectando' ? t.warn('… conectando') : t.error('✗ ' + (c.error || c.status))
      const extra = c.status === 'ok' ? t.muted(` · ${(c.resources || []).length} recursos · ${(c.prompts || []).length} prompts`) : ''
      lines.push(`  ${t.accent(c.name)} ${st} ${t.muted(`· ${c.tools.length} ferramentas`)}${extra}`)
      for (const tool of c.tools.slice(0, 12)) lines.push(t.subtle(`     ${tool.name}`) + t.muted(` — ${truncate(tool.description || '', this.cols - 30)}`))
      for (const r of [...(c.resources || []), ...(c.templates || []).map((x) => ({ uri: x.uriTemplate, name: `${x.name || ''} [template]` }))].slice(0, 6)) lines.push(t.subtle(`     ${r.uri}`) + t.muted(` — ${truncate(r.name || 'recurso', this.cols - 30)}`))
      for (const p of (c.prompts || []).slice(0, 6)) lines.push(t.subtle(`     /${p.name}`) + t.muted(` — ${truncate(p.description || 'prompt', this.cols - 30)}`))
    }
    this.block(lines)
  }

  showJobs() {
    const agentJobs = (this.session.jobs || []).filter((j) => j.background || j.status === 'running')
    if (!backgroundJobs.size && !agentJobs.length) return this.block(t.muted('Nenhum processo em segundo plano.'))
    const lines = [t.bold(t.primary('Processos em segundo plano'))]
    for (const j of [...backgroundJobs.values()]) {
      lines.push(`  ${t.accent(j.id)} ${t.muted(`pid ${j.pid}`)} ${j.exitCode === null ? t.primary('rodando') : t.muted(`saiu (${j.exitCode})`)} ${t.text(truncate(j.command, this.cols - 30))}`)
    }
    for (const j of agentJobs) {
      const st = j.status === 'running' ? t.primary('rodando') : j.status === 'done' ? t.accent('pronto') : t.error(j.status)
      lines.push(`  ${t.accent(j.id.slice(0, 8))} ${t.muted('subagente')} ${st} ${t.text(truncate(`${j.type}: ${j.prompt || ''}`, this.cols - 30))}`)
    }
    this.block(lines)
  }

  showStatus() {
    const m = this.agent.model
    const p = PROVIDERS[m.provider]
    const k = resolveKey(m.provider)
    const cols = this.cols
    const row = (label, value) => kvLines(t.muted(label), value, 9, cols)
    this.block([
      t.bold(t.primary('Status')),
      ...row('versão', t.text(VERSION)),
      ...row('sessão', t.text(this.session.id) + t.muted(` · ${this.session.messages.length} mensagens`)),
      ...row('modelo', t.text(`${m.provider}/${m.id}`) + (m.name && m.name !== m.id ? t.muted(` · ${m.name}`) : '')),
      ...row('custo', this.modelStatus(m)),
      ...row('provedor', t.text(p?.name || m.provider) + t.muted(`${p ? ' · ' + freeLabel(p) : ''}${k ? ` · chave via ${k.source}` : ''}`)),
      ...row('contexto', t.text(fmtTokens(m.context || DEFAULT_CONTEXT)) + t.muted(' tokens')),
      ...row('modo', modeBadge(this.agent.mode)),
      ...row('pasta', t.text(shortPath(this.session.cwd))),
      ...row('mcp', t.text(`${this.mcp.clients.filter((c) => c.status === 'ok').length}/${this.mcp.size} servidores`)),
    ])
  }

  showConfig() {
    const c = this.config
    const row = (label, value) => kvLines(t.muted(label), value, 14, this.cols)
    this.block([
      t.bold(t.primary('Configuração')),
      ...row('arquivo global', t.text(shortPath(paths.config)) + (c._projectFile ? t.muted('  + projeto ') + t.text(shortPath(c._projectFile)) : '')),
      ...row('chaves', t.text(shortPath(paths.auth))),
      ...row('sessões', t.text(shortPath(paths.sessions))),
      ...row('modo padrão', t.text(String(c.permissionMode))),
      ...row('auto-compactar', t.text(c.autoCompact ? `sim, em ${Math.round((c.compactThreshold || 0.85) * 100)}% do contexto` : 'não')),
      ...row('passos/turno', t.text(String(c.maxSteps))),
      ...row('raciocínio', t.text(c.showThinking === false ? 'oculto (/thinking mostra)' : 'visível') + (c.thinking ? t.muted(' · thinking estendido ligado') : '')),
    ])
  }

  showLogo() {
    this.block(bigLogo({ tagline: t.muted('seu agente de código no terminal'), cols: this.cols }))
  }

  expandLast() {
    if (!this.lastOutput) return this.toast('nada para expandir')
    const all = this.lastOutput.text.split('\n')
    const shown = all.slice(0, 2000)
    this.block([t.muted(`── ${this.lastOutput.title} · ${all.length} linhas ──`), ...shown.map((l) => '  ' + t.text(l)), ...(all.length > shown.length ? [t.muted(`  … +${all.length - shown.length} linhas`)] : []), t.muted('──')])
    this.lastOutput = null
  }

  suspend() {
    this.term.clearFooter()
    process.stdout.write('\x1b[?2004l\x1b[?25h')
    process.stdin.setRawMode(false)
    process.once('SIGCONT', () => {
      process.stdin.setRawMode(true)
      process.stdout.write('\x1b[?2004h')
      this.render()
    })
    process.kill(process.pid, 'SIGTSTP')
  }

  // ─────────────────────────── ciclo de vida ───────────────────────────

  async start() {
    this.setupInput()
    await this.agent.initialize()
    this.term.setFooter((cols, rows) => this.footer(cols, rows))
    this.printWelcome()
    if (this.notice) this.block(wrapText(this.notice, this.cols - 4).map((l, i) => (i ? '  ' : t.warn('! ')) + t.muted(l)))
    this.catalog.refreshStale().then(() => this.render())
    if (this.mcp.size) {
      this.mcp.startAll().then(() => {
        this.agent.extraTools = this.mcp.agentTools()
        const ok = this.mcp.clients.filter((c) => c.status === 'ok')
        const bad = this.mcp.clients.filter((c) => c.status !== 'ok')
        if (ok.length) this.block(t.primary('✓ ') + t.muted(`MCP: ${ok.map((c) => `${c.name} (${c.tools.length})`).join(', ')}`))
        for (const c of bad) this.block(t.error('✗ ') + t.muted(`MCP ${c.name}: ${c.error}`))
      })
    }
    if (this.session.messages.length) {
      this.replay(this.session)
      this.block(t.primary('✓ ') + t.muted('Sessão retomada: ') + t.text(this.session.title || this.session.id))
    }
    if (this.pickSession) this.openSessionPicker()
    this.render()
    if (this.initialPrompt) setImmediate(() => this.handleInput(this.initialPrompt))
    else this.drainQueue()
    return new Promise((resolve) => (this.resolveExit = resolve))
  }

  exit(code = 0) {
    if (this.exiting) return
    this.controller?.abort()
    this.agent.close().catch(() => {})
    this.stopSpinner()
    this.flush()
    this.exiting = true
    clearTimeout(this.flushTimer)
    this.term.clearFooter()
    this.term.enabled = false
    process.stdout.write('\x1b[?2004l\x1b[?25h')
    try {
      process.stdin.setRawMode(false)
    } catch {}
    process.stdin.pause()
    killAllBackground()
    this.mcp.closeAll()
    this.session.save()
    const T = this.session.usage.total
    const m = this.agent.model
    const width = Math.max(20, this.cols - 4)
    const lines = ['']
    const saved = this.session.messages.length ? ` Sessão salva: ${this.session.id} · retome com snake -c` : ''
    lines.push(...wrapText('Até a próxima!' + saved, width).map((l, i) => (i ? '   ' : '🐍 ') + t.muted(l)))
    if (T.requests) {
      const stats = `↑ ${fmtTokens(T.input + T.cacheWrite)} entrada · ↓ ${fmtTokens(T.output)} saída · cache ${fmtTokens(T.cacheRead)} lido / ${fmtTokens(T.cacheWrite)} gravado · ${costText(T, m)} · ${T.requests} requisições`
      lines.push(...wrapText(stats, width).map((l) => '   ' + t.subtle(l)))
    }
    process.stdout.write(lines.join('\n') + '\n')
    this.resolveExit?.(code)
  }
}
