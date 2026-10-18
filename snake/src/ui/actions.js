import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { Session } from '../agent/session.js'
import { ShadowRepo } from '../agent/snapshots.js'
import { discoverAgents, discoverSkills } from '../agent/resources.js'
import { buildReviewPrompt } from '../agent/prompt.js'
import { estimateTokens } from '../agent/usage.js'
import { EFFORTS, paths, readJSON, saveConfig, validateConfig, writeJSON, loadConfig } from '../config.js'
import { diagnose } from '../doctor.js'
import { McpManager } from '../mcp/client.js'
import { bashOutput, backgroundJobs } from '../tools/bash.js'
import { toUnifiedPatch } from '../tools/diff.js'
import { resolvePath } from '../tools/util.js'
import { addSchedule, removeSchedule, schedules } from '../scheduler.js'
import { setTheme, themes, t } from '../theme.js'
import { fmtCost, fmtTokens } from './format.js'
import { Picker, Prompt } from './picker.js'
import { Pager } from './pager.js'

export function words(input) {
  const out = []; let word = '', quote = '', started = false
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    if (c === '\\' && quote !== "'") { word += input[++i] || ''; started = true }
    else if (quote) { if (c === quote) quote = ''; else word += c }
    else if (c === '"' || c === "'") { quote = c; started = true }
    else if (/\s/.test(c)) { if (started) { out.push(word); word = ''; started = false } }
    else { word += c; started = true }
  }
  if (quote) throw new Error('Aspas não fechadas')
  if (started) out.push(word)
  return out
}
const say = (a, text) => a.block(String(text))
const persist = (a, key, value) => { validateConfig(key, value); a.config[key] = value; saveConfig({ [key]: value }); a.render() }
const pager = (a, title, text) => { a.modal = new Pager(title, text, () => { a.modal = null; a.render() }); a.render() }
function choose(a, title, items, selected) {
  a.modal = new Picker({ title, items, maxVisible: a.cols < 60 ? 3 : 12, onSelect: (it) => { a.modal = null; Promise.resolve(selected(it.value)).catch((e) => a.logError(e)); a.render() }, onCancel: () => { a.modal = null; a.render() } })
  a.render()
}
function git(a, args) {
  const r = spawnSync('git', args, { cwd: a.session.cwd, encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(r.stderr || r.error?.message || 'Comando Git falhou')
  return r.stdout
}
function diff(a, args = []) {
  try { return git(a, ['diff', ...(args.includes('--staged') ? ['--cached'] : []), '--no-ext-diff', '--', ...args.filter((v) => v !== '--staged')]) }
  catch (error) {
    const last = a.session.undoStack.at(-1)
    if (!last) throw error
    if (last.git) {
      const repo = new ShadowRepo(last.git.root)
      const r = spawnSync('git', ['diff', '--no-ext-diff', last.git.before, last.git.after], { cwd: last.git.root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_DIR: repo.gitDir, GIT_WORK_TREE: last.git.root } })
      if (r.status === 0) return r.stdout
    }
    return (last.files || []).map((f) => {
      const before = f.before ? Buffer.from(f.before.data, 'base64').toString('utf8') : ''
      const after = f.after ? Buffer.from(f.after.data, 'base64').toString('utf8') : ''
      try {
        return toUnifiedPatch(f.path, before, after)
      } catch {
        return `--- ${f.path}\n${before}\n+++ ${f.path}\n${after}`
      }
    }).join('\n')
  }
}
async function side(a, prompt, system) {
  const active = a.busy
  const controller = new AbortController()
  if (!active) { a.busy = true; a.controller = controller; a.startSpinner(); a.render() }
  try { return await a.agent.aside(prompt, { system, signal: controller.signal }) }
  finally { if (!active) { a.busy = false; a.controller = null; a.stopSpinner(); a.render(); a.drainQueue() } }
}
function switchSession(a, s) {
  a.session.save(); a.session = s; a.agent = a.createAgent(s)
  a.queue = s.inbox.map((e) => e.text)
  a.printWelcome(); a.render()
}
function redact(value) {
  if (Array.isArray(value)) return value.map(redact)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /token|secret|password|api.?key|authorization/i.test(k) && typeof v === 'string' ? '[oculto]' : redact(v)]))
}
export function openEditor(a, file) {
  const editor = words(process.env.VISUAL || process.env.EDITOR || 'vi')
  a.term.clearFooter(); a.term.enabled = false
  process.stdin.setRawMode?.(false)
  try {
    const result = spawnSync(editor[0], [...editor.slice(1), file], { stdio: 'inherit', cwd: a.session.cwd })
    if (result.status !== 0) throw new Error('Editor terminou com erro')
  } finally { process.stdin.setRawMode?.(true); a.term.enabled = true; a.render() }
}

export async function runAction(a, name, arg = '') {
  const args = words(arg), s = a.session
  switch (name) {
    case 'skills': return choose(a, 'Skills disponíveis', discoverSkills(s.cwd).map((v) => ({ label: v.name, detail: v.description, hint: v.file, value: v.name })), (v) => runAction(a, 'skill', v))
    case 'skill': {
      const item = discoverSkills(s.cwd).find((v) => v.name === arg.replace(/^:/, '').trim())
      if (!item) throw new Error('Skill não encontrada; use /skills')
      if (!s.skills.includes(item.name)) s.skills.push(item.name)
      s.messages.push({ role: 'user', synthetic: true, content: `Use a skill ${item.name} (${item.file}) nesta sessão.\n\n${item.body}` })
      s.event('skill', { name: item.name }); s.save(); return say(a, `✓ Skill carregada: ${item.name}\n${item.file}`)
    }
    case 'goal': {
      if (!arg) return say(a, s.goal ? `${s.goal.status}: ${s.goal.text}${s.goal.spent ? ` · ${s.goal.spent} tokens` : ''}` : 'Nenhum objetivo ativo. /goal <texto>')
      const current = s.goal
      if (['pause', 'done', 'clear', 'resume'].includes(arg)) {
        if (!current) throw new Error('Nenhum objetivo definido')
        if (arg === 'clear' || arg === 'done') { s.goals.push({ ...current, status: arg === 'done' ? 'done' : 'cleared', finished: Date.now() }); s.goal = null }
        else { current.status = arg === 'pause' ? 'paused' : 'active'; if (arg === 'resume') current.startTokens = tokenTotal(s) }
      } else {
        if (current) s.goals.push(current)
        s.goal = { id: crypto.randomUUID(), text: arg, created: Date.now(), status: 'active', startTokens: tokenTotal(s) }
      }
      persist(a, 'goal', s.goal); s.event('goal', { goal: s.goal }); s.save(); return say(a, s.goal ? `Objetivo ${s.goal.status}: ${s.goal.text}` : 'Objetivo encerrado.')
    }
    case 'goals': return pager(a, 'Objetivos', [...s.goals, ...(s.goal ? [s.goal] : [])].map((g) => `${new Date(g.created).toISOString()} · ${g.status}\n${g.text}`).join('\n\n') || 'Nenhum objetivo registrado.')
    case 'agents': {
      const list = discoverAgents(s.cwd).filter((v) => v.mode !== 'subagent' && !v.hidden)
      if (!arg) return choose(a, 'Agente principal', list.map((v) => ({ label: v.name, detail: v.description, value: v.name })), (v) => runAction(a, 'agents', v))
      const definition = list.find((v) => v.name === arg)
      if (!definition) throw new Error('Agente não encontrado')
      s.agent = definition.name; if (definition.model) a.setModel(definition.model)
      s.event('agent', { name: arg }); s.save(); return say(a, `Agente: ${arg}${definition.permission === 'plan' ? ' · somente leitura' : ''}`)
    }
    case 'btw': if (!arg) throw new Error('Use /btw <pergunta>'); return say(a, await side(a, arg))
    case 'fork': { const copy = s.fork(); switchSession(a, copy); if (arg) await a.submitPrompt(arg); return say(a, `Sessão bifurcada: ${copy.id}`) }
    case 'rename': if (!arg) throw new Error('Use /rename <título>'); s.title = arg.slice(0, 200); s.event('rename', { title: s.title }); s.save(); return say(a, `Título: ${s.title}`)
    case 'timeline': return pager(a, 'Linha do tempo', s.events.filter((e) => !arg || e.type.includes(arg)).map((e) => `${new Date(e.at).toISOString()} ${e.type} ${JSON.stringify(e)}`).join('\n') || 'Nenhum evento.')
    case 'undo':
    case 'redo': {
      const restored = await a.agent[name](arg ? Number(arg) : 1)
      if (!restored) return say(a, `Nada para ${name === 'undo' ? 'desfazer' : 'refazer'}.`)
      s.messages.push({ role: 'user', synthetic: true, content: `O usuário executou /${name}: ${restored.map((f) => f.path).join(', ')}. Releia esses arquivos antes de continuar.` }); s.save()
      return say(a, `✓ ${restored.length} arquivo(s) restaurado(s).`)
    }
    case 'diff': return pager(a, 'Diff', diff(a, args) || 'Nenhuma alteração rastreada.')
    case 'review': {
      const fix = args.includes('--fix'), changes = diff(a, args.filter((v) => v !== '--fix'))
      if (!changes.trim()) return say(a, 'Sem diff para revisar.')
      const prompt = buildReviewPrompt(changes, { fix })
      if (!fix) return say(a, await side(a, prompt))
      const mode = a.agent.mode; a.agent.mode = 'ask'
      const allowed = a.agent.alwaysAllow; a.agent.alwaysAllow = new Set()
      a.agent.forceApproval = true
      try { await a.submitPrompt(prompt) } finally { a.agent.mode = mode; a.agent.alwaysAllow = allowed; a.agent.forceApproval = false }
      return
    }
    case 'effort': { const value = arg || EFFORTS[(EFFORTS.indexOf(a.config.effort) + 1) % EFFORTS.length]; persist(a, 'effort', value); return say(a, `Esforço: ${value}`) }
    case 'details': {
      const roles = {}
      for (const m of s.messages) { roles[m.role] ||= { count: 0, tokens: 0 }; roles[m.role].count++; roles[m.role].tokens += estimateTokens(m.content) + estimateTokens(JSON.stringify(m.toolCalls || [])) }
      return pager(a, 'Prévia da compactação', JSON.stringify({ messages: s.messages.length, roles, context: a.agent.estimateContext(), compactCount: s.compactCount, instructions: 'A compactação resumirá todas as mensagens; skills e objetivo permanecem.' }, null, 2))
    }
    case 'export': {
      const json = args[0] === 'json', count = /^\d+$/.test(args[0] || '') ? Number(args[0]) : null
      if (count === 0) throw new Error('Quantidade deve ser positiva')
      if (!json && !count && arg && !['md', 'markdown'].includes(arg)) return a.exportSession(arg)
      const file = path.join(s.cwd, `snake-${s.id}.${json ? 'json' : 'md'}`)
      if (json) writeJSON(file, { format: 'snake-session', version: 2, ...s.toJSON() }, 0o600)
      else fs.writeFileSync(file, `# ${s.title || 'Sessão Snake'}\n\n` + (count ? s.messages.slice(-count) : s.messages).map((m) => `## ${m.role}\n\n${m.content || ''}${m.toolCalls ? '\n\n' + JSON.stringify(m.toolCalls) : ''}`).join('\n\n'), { mode: 0o600 })
      return say(a, `Exportado: ${file}`)
    }
    case 'import': { const data = JSON.parse(fs.readFileSync(resolvePath(s.cwd, arg), 'utf8')); const imported = Session.import(data, s.cwd); switchSession(a, imported); return say(a, `Sessão importada: ${imported.id}`) }
    case 'stats': {
      const groups = new Map()
      let history = ''; try { history = fs.readFileSync(paths.history, 'utf8') } catch {}
      for (const line of history.split('\n')) {
        let e; try { e = JSON.parse(line) } catch { continue }
        if (e.type !== 'usage') continue
        const key = `${new Date(e.at).toISOString().slice(0, 10)} ${e.model}`
        const row = groups.get(key) || { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, apiMs: 0, unknown: false }
        for (const k of Object.keys(row)) if (k !== 'unknown') row[k] += e[k] || 0
        row.unknown ||= !!e.costUnknown; groups.set(key, row)
      }
      return pager(a, 'Consumo por dia e modelo', [...groups].map(([k, v]) => `${k}\n${v.requests} requests · ↑${fmtTokens(v.input)} ↓${fmtTokens(v.output)} · cache ${fmtTokens(v.cacheRead)}/${fmtTokens(v.cacheWrite)} · ${fmtCost(v.cost, { unknown: v.unknown })} · ${(v.apiMs / 1000).toFixed(1)}s`).join('\n\n') || 'Sem requisições registradas nesta versão.')
    }
    case 'theme': {
      if (!arg) return choose(a, 'Tema', Object.keys(themes).map((key) => ({ label: key, value: key })), (v) => runAction(a, 'theme', v))
      setTheme(arg); persist(a, 'theme', arg); return say(a, `Tema: ${arg}${process.env.SNAKE_THEME ? ' (SNAKE_THEME prevalece no próximo início)' : ''}`)
    }
    case 'output-style': { const value = ({ '-v': 'verbose', '-c': 'concise', '-m': 'markdown' })[arg] || arg; if (!value) return say(a, a.config.outputStyle); persist(a, 'outputStyle', value); return say(a, `Estilo: ${value}`) }
    case 'doctor': return pager(a, 'Diagnóstico', (await diagnose({ network: arg !== '--offline' })).map((r) => `${r.status.toUpperCase()} · ${r.name}: ${r.detail}`).join('\n'))
    case 'memory': {
      if (!arg.startsWith('add ')) return a.showMemory()
      fs.mkdirSync(paths.home, { recursive: true }); fs.appendFileSync(paths.notes, `\n- ${new Date().toISOString()} ${arg.slice(4).replace(/^"|"$/g, '')}\n`, { mode: 0o600 })
      return say(a, 'Nota salva na memória global.')
    }
    case 'memories': return pager(a, 'Memória global', fs.existsSync(paths.notes) ? fs.readFileSync(paths.notes, 'utf8') : 'Nenhuma nota.')
    case 'add-dir': {
      const dir = fs.realpathSync(resolvePath(s.cwd, arg)); if (!fs.statSync(dir).isDirectory()) throw new Error('Não é um diretório')
      persist(a, 'extraDirs', [...new Set([...a.config.extraDirs, dir])]); return say(a, `Diretório disponibilizado para leitura: ${dir}. As regras de permissão continuam válidas.`)
    }
    case 'statusline': persist(a, 'statusline', arg === 'reset' ? '' : arg); return say(a, 'Barra de status atualizada.')
    case 'title': persist(a, 'title', arg); return say(a, arg ? `Título: ${arg}` : 'Título limpo.')
    case 'config': {
      if (!arg) return pager(a, 'Configuração (global + projeto)', JSON.stringify({ global: redact(readJSON(paths.config, {})), projectFile: a.config._projectFile, project: redact(readJSON(a.config._projectFile, {})), effective: redact(a.config) }, null, 2))
      if (args[0] === 'get') { if (!Object.hasOwn(a.config, args[1])) throw new Error('Chave não encontrada'); return say(a, JSON.stringify(redact({ [args[1]]: a.config[args[1]] }), null, 2)) }
      if (args[0] === 'set') {
        const raw = arg.replace(/^set\s+\S+\s+/, ''); let value; try { value = JSON.parse(raw) } catch { value = args.slice(2).join(' ') }
        persist(a, args[1], value)
        if (args[1] === 'permissionMode') a.setMode(value)
        if (args[1] === 'theme') setTheme(value)
        return say(a, `Configuração atualizada: ${args[1]}`)
      }
      if (args[0] === 'edit') { if (!fs.existsSync(paths.config)) writeJSON(paths.config, {}); openEditor(a, paths.config); const next = loadConfig(s.cwd); for (const [k, v] of Object.entries(next)) validateConfig(k, v); Object.assign(a.config, next); a.setMode(next.permissionMode); setTheme(next.theme); return }
      throw new Error('Use /config get <chave> | set <chave> <JSON> | edit')
    }
    case 'mcp': {
      if (!arg) return a.showMcp()
      const [operation, id, ...rest] = args
      const cfg = { ...a.config.mcp }
      if (operation === 'add') {
        if (!id || !rest.length || !/^[\w-]+$/.test(id)) throw new Error('Use /mcp add <nome> <comando args...|url>')
        cfg[id] = /^https?:\/\//.test(rest[0]) ? { url: rest[0] } : { command: rest[0], args: rest.slice(1) }
      } else if (operation === 'remove') { if (!cfg[id]) throw new Error('Servidor não encontrado'); delete cfg[id] }
      else if (operation === 'login') {
        const { loginMcp } = await import('../mcp/oauth.js')
        if (!cfg[id]?.url) throw new Error('Login exige servidor MCP remoto')
        await loginMcp(id, cfg[id], { onUrl: (url) => say(a, `Abra no navegador para autorizar:\n${url}`) })
      } else if (operation !== 'reconnect') throw new Error('Use /mcp add|remove|reconnect|login')
      // Substituir mapa permite remover entradas, ao contrário de deepMerge.
      a.config.mcp = cfg; const global = readJSON(paths.config, {}); global.mcp = cfg; writeJSON(paths.config, global)
      a.mcp.closeAll(); a.mcp = new McpManager(cfg, { cwd: s.cwd }); await a.mcp.startAll(); a.agent.extraTools = a.mcp.tools(); return a.showMcp()
    }
    case 'plan': {
      if (arg === 'apply' || arg === 'aplicar') {
        if (!s.plan || s.plan.status !== 'draft') throw new Error('Nenhum plano pendente')
        s.plan.status = 'applied'; s.agent = 'build'; a.setMode('yolo'); return a.submitPrompt(`Aplique o plano aprovado:\n${s.plan.text}`)
      }
      if (arg === 'discard' || arg === 'descartar') { s.plan = null; s.save(); return say(a, 'Plano descartado.') }
      if (arg.startsWith('edit ') || arg.startsWith('editar ')) { a.setMode('plan'); return a.submitPrompt(`Revise este plano:\n${s.plan?.text || ''}\n\nMudança solicitada: ${arg.replace(/^\S+\s+/, '')}`) }
      if (!arg && s.plan) return pager(a, 'Plano · /plan aplicar | descartar | editar <instruções>', s.plan.text)
      a.setMode('plan'); if (arg) return a.submitPrompt(arg); return
    }
    case 'bg': {
      if (arg) {
        const job = s.jobs.find((j) => j.id.startsWith(arg) || j.id === arg)
        if (job && job.background) {
          const sub = job.status === 'running' ? 'rodando em segundo plano' : `status ${job.status}${job.error ? ` (${job.error})` : ''}`
          return pager(a, `Job ${job.id.slice(0, 8)}`, `${job.type} · ${sub}\nObjetivo: ${job.prompt}\nPara continuar a conversa: task com job_id="${job.id}".`)
        }
        const result = await bashOutput.run({ id: arg })
        return pager(a, `Job ${arg}`, result.output)
      }
      const agentJobs = (s.jobs || []).filter((j) => j.background || j.status === 'running')
      a.showJobs()
      return say(a, agentJobs.map((j) => `${j.id.slice(0, 8)} · ${j.type} · ${j.status}${j.background ? ' · fundo' : ''} · ${String(j.prompt || '').slice(0, 60)}`).join('\n') || (backgroundJobs.size ? '' : 'Sem jobs de agentes.'))
    }
    case 'stop': { if (!arg) throw new Error('Use /stop <id>'); const result = await bashOutput.run({ id: arg, kill: true }); if (result.isError && a.agent.terminal?.has(arg)) return a.agent.terminal.stop(arg); return say(a, result.output) }
    case 'resume': {
      if (!arg) return a.openSessionPicker()
      const job = s.jobs.find((j) => j.id.startsWith(arg))
      if (job) return a.submitPrompt(`Retome o job ${job.id}, tipo ${job.type}, com a ferramenta task e job_id. Objetivo: ${job.prompt}`)
      const target = Session.resolve(arg); if (!target) throw new Error('Sessão/job não encontrado'); return a.resumeSession(target.id)
    }
    case 'worktree': {
      const [op, target] = args
      if (!op || op === 'list') return pager(a, 'Worktrees', git(a, ['worktree', 'list']))
      if (!target) throw new Error('Use /worktree new <nome> | remove <caminho>')
      if (op === 'new') {
        git(a, ['check-ref-format', '--branch', target])
        if (!/^[a-zA-Z0-9_-]+$/.test(target)) throw new Error('Nome deve conter letras, números, _ ou -')
        const root = git(a, ['rev-parse', '--show-toplevel']).trim(), dir = path.join(path.dirname(root), path.basename(root) + '-' + target)
        git(a, ['worktree', 'add', '-b', target, dir]); const next = Session.create({ cwd: dir, model: s.model }); next.save(); switchSession(a, next); return say(a, `Worktree: ${dir}`)
      }
      if (op === 'remove') { git(a, ['worktree', 'remove', '--', resolvePath(s.cwd, target)]); return say(a, 'Worktree removida.') }
      throw new Error('Operação de worktree desconhecida')
    }
    case 'schedule': {
      if (!args.length || args[0] === 'list') return pager(a, 'Agendamentos locais', schedules().map((j) => `${j.id} · ${j.cron} · ${j.prompt}`).join('\n') || 'Use /schedule add "*/15 * * * *" "prompt". Exige cron; executa em dontAsk, até 20 passos.')
      if (args[0] === 'remove') { removeSchedule(args[1]); return say(a, 'Agendamento removido.') }
      if (args[0] !== 'add' || !args[1] || !args[2]) throw new Error('Use /schedule add "cron" "prompt"')
      const job = addSchedule({ cron: args[1], prompt: args.slice(2).join(' '), cwd: s.cwd, model: s.model }); return say(a, `Agendado: ${job.id} · ${job.cron} · dontAsk · até 20 passos. Pode consumir cota enquanto o cron estiver ativo.`)
    }
    case 'loop': {
      if (arg === 'stop') { a.loopStopped = true; a.interrupt(); return }
      if (a.loopRunning) throw new Error('Já existe um loop ativo')
      const params = [...args]; let max = a.config.loopMax || 5, until = ''
      for (const flag of ['--max', '--until']) { const i = params.indexOf(flag); if (i >= 0) { const v = params[i + 1]; if (!v) throw new Error(`Falta valor de ${flag}`); if (flag === '--max') max = Number(v); else until = v; params.splice(i, 2) } }
      if (!Number.isSafeInteger(max) || max < 1 || max > 100) throw new Error('--max deve estar entre 1 e 100')
      const prompt = params.join(' '); if (!prompt) throw new Error('Use /loop [--max N] [--until "condição"] <prompt>')
      a.loopRunning = true; a.loopStopped = false; say(a, `Loop limitado a ${max} turnos; consome cota. Esc ou /loop stop interrompe.`)
      try {
        for (let i = 0; i < max && !a.loopStopped; i++) {
          await a.submitPrompt(`${prompt}\n[Iteração ${i + 1}/${max}${until ? `; condição de término: ${until}` : ''}]`)
          if (a.loopStopped || a.lastRunError) break
          if (until) {
            const answer = await side(a, `Condição: ${until}\nEvidências recentes: ${JSON.stringify(s.messages.slice(-8))}\nA condição foi comprovada pelos resultados? Responda apenas SIM ou NÃO. Na dúvida NÃO.`, 'Avalie a conclusão com base nas evidências fornecidas.')
            if (/^SIM\b/i.test(answer.trim())) { say(a, 'O modelo identificou evidências de que a condição foi atendida.'); break }
          }
        }
      } finally { a.loopRunning = false; a.drainQueue() }
      return
    }
    case 'terminal': return a.openTerminal(arg)
    default: throw new Error(`Ação desconhecida: ${name}`)
  }
}
function tokenTotal(s) { const t = s.usage.total; return t.input + t.output + t.cacheRead + t.cacheWrite }
