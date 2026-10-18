// Comandos de barra (/help, /models, /usage...) e comandos personalizados em .snake/commands/*.md.

import fs from 'node:fs'
import path from 'node:path'
import { paths } from './config.js'
import { runAction } from './ui/actions.js'

export const COMMANDS = [
  { name: 'help', aliases: ['ajuda', '?'], description: 'comandos e atalhos de teclado', run: (app) => app.showHelp() },
  { name: 'models', aliases: ['modelos'], description: 'escolher modelo (grátis e pagos)', run: (app, arg) => app.openModelPicker(arg) },
  { name: 'model', aliases: ['modelo'], description: 'trocar modelo: /model provedor/modelo', run: (app, arg) => (arg ? app.setModel(arg) : app.openModelPicker()) },
  { name: 'usage', aliases: ['cost', 'tokens', 'custo', 'consumo'], description: 'tokens de entrada/saída, cache (KV) e custo', run: (app) => app.showUsage() },
  { name: 'context', aliases: ['contexto', 'ctx'], description: 'ocupação da janela de contexto', run: (app) => app.showContext() },
  { name: 'compact', aliases: ['compactar'], description: 'resumir a conversa para liberar contexto', run: (app, arg) => app.compact(arg) },
  { name: 'clear', aliases: ['new', 'nova', 'limpar', 'reset'], description: 'nova conversa (contexto limpo)', run: (app) => app.newSession() },
  { name: 'resume', aliases: ['retomar', 'sessions', 'sessoes'], description: 'retomar uma sessão anterior', run: (app) => app.openSessionPicker() },
  { name: 'providers', aliases: ['provedores'], description: 'provedores, modelos grátis e chaves', run: (app) => app.showProviders() },
  { name: 'key', aliases: ['login', 'chave'], description: 'salvar chave de API: /key openrouter [chave]', run: (app, arg) => app.keyCommand(arg) },
  { name: 'logout', description: 'remover chave salva: /logout <provedor>', run: (app, arg) => app.logoutCommand(arg) },
  { name: 'mode', aliases: ['modo'], description: 'modo de permissão: yolo | ask | plan', run: (app, arg) => app.setMode(arg) },
  { name: 'yolo', description: 'modo YOLO: nunca pede permissão', run: (app) => app.setMode('yolo') },
  { name: 'ask', description: 'modo ASK: confirma edições e comandos', run: (app) => app.setMode('ask') },
  { name: 'plan', aliases: ['plano'], description: 'modo PLAN: somente leitura, gera um plano', run: (app) => app.setMode('plan') },
  { name: 'init', description: 'analisar o projeto e criar SNAKE.md', run: (app) => app.initProject() },
  { name: 'memory', aliases: ['memoria', 'memória'], description: 'arquivos de instruções carregados', run: (app) => app.showMemory() },
  { name: 'todos', aliases: ['tarefas'], description: 'lista de tarefas do agente', run: (app) => app.showTodos() },
  { name: 'undo', aliases: ['desfazer'], description: 'desfazer alterações de arquivos do último turno', run: (app) => app.undo() },
  { name: 'export', aliases: ['exportar'], description: 'exportar conversa em Markdown', run: (app, arg) => app.exportSession(arg) },
  { name: 'copy', aliases: ['copiar'], description: 'copiar a última resposta', run: (app) => app.copyLast() },
  { name: 'thinking', aliases: ['raciocinio', 'raciocínio'], description: 'mostrar/ocultar o raciocínio do modelo', run: (app) => app.toggleThinking() },
  { name: 'mcp', description: 'servidores MCP conectados e ferramentas', run: (app) => app.showMcp() },
  { name: 'bg', aliases: ['jobs'], description: 'processos em segundo plano', run: (app) => app.showJobs() },
  { name: 'status', description: 'resumo da sessão, modelo e diretório', run: (app) => app.showStatus() },
  { name: 'config', description: 'configuração e caminhos', run: (app) => app.showConfig() },
  { name: 'logo', description: 'mostrar o logo', run: (app) => app.showLogo() },
  { name: 'exit', aliases: ['quit', 'sair', 'q'], description: 'sair do Snake', run: (app) => app.exit() },
]

const ACTIONS = {
  skills: 'listar e escolher guias SKILL.md', skill: 'carregar guia: /skill <nome>',
  goal: 'objetivo persistente: texto | pause | resume | done | clear', goals: 'histórico de objetivos',
  agents: 'selecionar agente principal', btw: 'pergunta lateral sem ferramentas nem histórico',
  fork: 'bifurcar a sessão atual', rename: 'renomear a sessão', timeline: 'eventos da sessão, com filtro',
  undo: 'desfazer N turnos com snapshots persistidos', redo: 'refazer N turnos desfeitos',
  review: 'revisar diff; --fix aplica com aprovação', diff: 'diff paginado; --staged ou caminho',
  effort: 'raciocínio: auto | low | medium | high | max', details: 'prévia do contexto antes de compactar',
  export: 'exportar json, markdown ou últimas N mensagens', import: 'importar sessão JSON',
  stats: 'consumo agregado por dia e modelo', theme: 'trocar tema visual',
  mcp: 'servidores: add | remove | reconnect | login', 'output-style': 'estilo de resposta: -v | -c | -m',
  loop: 'repetir tarefa: --max N --until "condição"', schedule: 'cron local: add | list | remove',
  doctor: 'diagnóstico do ambiente e provedores', memory: 'instruções e /memory add <nota>', memories: 'histórico de notas globais',
  'add-dir': 'disponibilizar diretório adicional para leitura', statusline: 'template da barra de status', title: 'título do terminal',
  config: 'configuração: get | set | edit', plan: 'planejar, aplicar, descartar ou editar plano',
  bg: 'jobs e logs: /bg [id]', stop: 'encerrar processo: /stop <id>', resume: 'retomar sessão ou job por id',
  worktree: 'worktrees Git: new | list | remove', terminal: 'abrir terminal persistente: /terminal [id]',
}
for (const [name, description] of Object.entries(ACTIONS)) {
  const existing = COMMANDS.find((c) => c.name === name)
  const command = { name, description, run: (app, arg) => runAction(app, name, arg) }
  if (existing) Object.assign(existing, command)
  else COMMANDS.push(command)
}
COMMANDS.find((c) => c.name === 'skill').aliases = ['skill:']

// Grupos do /help (ordem de exibição). Comando sem grupo cai em "Outros".
export const COMMAND_GROUPS = [
  ['Conversa', ['clear', 'resume', 'compact', 'fork', 'rename', 'btw', 'export', 'import', 'copy', 'timeline', 'undo', 'redo', 'exit']],
  ['Modelo e chaves', ['models', 'model', 'effort', 'thinking', 'key', 'logout', 'providers']],
  ['Modo e agentes', ['mode', 'yolo', 'ask', 'plan', 'agents', 'goal', 'goals', 'loop', 'schedule']],
  ['Código', ['init', 'diff', 'review', 'todos', 'bg', 'stop', 'terminal', 'worktree', 'add-dir']],
  ['Contexto e consumo', ['context', 'details', 'usage', 'stats', 'memory', 'memories', 'skills', 'skill']],
  ['Integrações e ajustes', ['mcp', 'config', 'theme', 'output-style', 'statusline', 'title', 'status', 'doctor', 'logo', 'help']],
]
COMMANDS.find((c) => c.name === 'mode').description = 'permissões: yolo, ask, plan, auto, acceptEdits, dontAsk, bypassPermissions'

function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  if (!m) return { meta: {}, body: text }
  const meta = {}
  for (const line of m[1].split('\n')) {
    const kv = /^(\w[\w-]*):\s*(.*)$/.exec(line)
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '')
  }
  return { meta, body: text.slice(m[0].length) }
}

/** Carrega comandos personalizados: ~/.snake/commands/*.md e <projeto>/.snake/commands/*.md */
export function loadCustomCommands(cwd) {
  const dirs = [paths.commands, path.join(cwd, '.snake', 'commands')]
  const out = new Map()
  for (const dir of dirs) {
    let files = []
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'))
    } catch {
      continue
    }
    for (const f of files) {
      const name = f.slice(0, -3).toLowerCase().replace(/\s+/g, '-')
      if (COMMANDS.some((c) => c.name === name)) continue
      let text = ''
      try {
        text = fs.readFileSync(path.join(dir, f), 'utf8')
      } catch {
        continue
      }
      const { meta, body } = parseFrontmatter(text)
      const firstLine = body.trim().split('\n')[0] || ''
      out.set(name, {
        name,
        aliases: [],
        custom: true,
        description: meta.description || firstLine.slice(0, 60) || 'comando personalizado',
        run: (app, arg) => app.submitPrompt(body.includes('$ARGUMENTS') ? body.replaceAll('$ARGUMENTS', arg || '') : `${body}${arg ? `\n\n${arg}` : ''}`),
      })
    }
  }
  return [...out.values()]
}

export function findCommand(list, name) {
  const n = name.toLowerCase()
  return list.find((c) => c.name === n || (c.aliases || []).includes(n)) || null
}

/** Comandos que combinam com o que foi digitado (prefixo primeiro, depois "contém"). */
export function matchCommands(list, typed) {
  const q = typed.toLowerCase()
  const prefix = list.filter((c) => c.name.startsWith(q) || (c.aliases || []).some((a) => a.startsWith(q)))
  const contains = list.filter((c) => !prefix.includes(c) && (c.name.includes(q) || c.description.toLowerCase().includes(q)))
  return [...prefix, ...contains]
}
