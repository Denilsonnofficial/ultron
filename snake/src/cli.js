// Entrada da linha de comando: flags, subcomandos e escolha entre modo interativo e não interativo.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { Session } from './agent/session.js'
import { VERSION, validateConfig, ensureDirs, getAuth, loadConfig, paths, saveConfig, setKey, shortPath } from './config.js'
import { runHeadless } from './headless.js'
import { bigLogo } from './logo.js'
import { Catalog } from './providers/catalog.js'
import { costLabel } from './providers/pricing.js'
import { availability } from './providers/availability.js'
import { PROVIDERS, freeLabel, isUsable, registerCustomProviders, resolveKey } from './providers/registry.js'
import { setColorLevel, setTheme, t } from './theme.js'
import { checkModel, benchModel } from './providers/checks.js'
import { diagnose } from './doctor.js'
import { padEnd, strWidth, truncate } from './ui/ansi.js'
import { fmtAgo, fmtCost, fmtTokens } from './ui/format.js'
import { readJSON, writeJSON } from './config.js'
import { resolvePath } from './tools/util.js'

const SUBCOMMANDS = new Set(['models', 'providers', 'key', 'login', 'logout', 'sessions', 'logo', 'config', 'doctor', 'help', 'run', 'version', 'check-models', 'bench', 'serve', 'attach', 'acp', 'schedule', 'mcp', 'stats', 'export', 'import'])

export function parseArgv(argv) {
  const opts = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const value = argv[i + 1]
      if (!value || value.startsWith('-')) throw new Error(`A opção ${a} exige um valor.`)
      i++
      return value
    }
    switch (a) {
      case '-p':
      case '--print':
        opts.print = true
        break
      case '-m':
      case '--model':
        opts.model = next()
        break
      case '-c':
      case '--continue':
        opts.continue = true
        break
      case '-r':
      case '--resume':
        opts.resume = true
        if (argv[i + 1] && /^ses_/.test(argv[i + 1])) opts.resumeId = next()
        break
      case '--ask':
      case '--safe':
        opts.mode = 'ask'
        break
      case '--plan':
        opts.mode = 'plan'
        break
      case '--yolo':
        opts.mode = 'yolo'
        break
      case '--auto': opts.mode = 'auto'; break
      case '--accept-edits': opts.mode = 'acceptEdits'; break
      case '--dont-ask': opts.mode = 'dontAsk'; break
      case '--bypass-permissions': opts.mode = 'bypassPermissions'; break
      case '--port': opts.port = Number(next()); break
      case '--host': opts.host = next(); break
      case '--token': opts.token = next(); break
      case '--effort': opts.effort = next(); break
      case '--no-boot': opts.noBoot = true; break
      case '--refresh': opts.refresh = true; break
      case '--offline': opts.offline = true; break
      case '-C':
      case '--cwd':
        opts.cwd = next()
        break
      case '--json':
        opts.json = true
        break
      case '--verbose':
        opts.verbose = true
        break
      case '--max-steps':
        opts.maxSteps = Number(next())
        break
      case '--no-color':
        opts.noColor = true
        break
      case '--thinking':
        opts.thinking = true
        break
      case '--free':
        opts.free = true
        break
      case '--all':
        opts.all = true
        break
      case '-v':
      case '--version':
        opts.version = true
        break
      case '-h':
      case '--help':
        opts.help = true
        break
      case '--':
        opts._.push(...argv.slice(i + 1))
        i = argv.length
        break
      default:
        if (a.startsWith('--model=')) opts.model = a.slice(8)
        else if (a.startsWith('--cwd=')) opts.cwd = a.slice(6)
        else if (/^-{1,2}[a-zA-Z]/.test(a) && !opts._.length) opts.unknown = a
        else opts._.push(a)
    }
  }
  if (opts.model === '' || opts.cwd === '') throw new Error('Modelo e diretório não podem ser vazios.')
  if (opts.maxSteps !== undefined && (!Number.isSafeInteger(opts.maxSteps) || opts.maxSteps < 1)) {
    throw new Error('--max-steps deve ser um inteiro positivo.')
  }
  return opts
}

const HELP = () => `${t.primary('🐍 snake')} ${t.muted('v' + VERSION)} — agente de código para o terminal

${t.bold('Uso')}
  snake [prompt]                  abre a interface interativa (opcionalmente já com um prompt)
  snake -p "prompt"               modo não interativo: imprime a resposta e sai
  cat erro.log | snake -p "..."   usa a entrada padrão como contexto

${t.bold('Opções')}
  -m, --model <provedor/modelo>   escolhe o modelo (ex.: openrouter/openrouter/free)
  -c, --continue                  continua a última sessão deste diretório
  -r, --resume [id]               retoma uma sessão (sem id: escolhe na lista)
      --yolo                      nunca pede permissão ${t.accent('(padrão)')}
      --ask, --safe               pede confirmação antes de editar arquivos ou rodar comandos
      --plan                      modo plano: somente leitura
      --auto                      aprovação automática respeitando regras
      --accept-edits              aprova edições; confirma shell
      --dont-ask                  recusa ações que precisariam de aprovação
      --bypass-permissions        autoaprova; regras deny permanecem
      --effort <nível>            auto | low | medium | high | max
      --no-boot                   pula animação inicial
      --thinking                  raciocínio estendido em modelos Anthropic
      --json                      com -p: saída JSON (resposta + consumo de tokens)
      --verbose                   com -p: mostra ferramentas e consumo no stderr
      --cwd <dir>                 diretório de trabalho
      --max-steps <n>             limite de passos por turno (padrão 100)
      --no-color                  desativa cores
  -v, --version                   versão
  -h, --help                      esta ajuda

${t.bold('Comandos')}
  snake models [filtro] [--free|--all]  lista modelos (grátis primeiro)
  snake providers                 provedores e status das chaves
  snake key <provedor> [chave]    salva uma chave de API (ex.: snake key openrouter sk-or-...)
  snake logout <provedor>         remove a chave salva
  snake sessions                  sessões recentes
  snake config                    caminhos e configuração atual
  snake doctor                    verifica o ambiente
  snake logo                      mostra o logo
  snake check-models [refs...]    verifica ferramentas (tarefas sintéticas)
  snake bench [refs...]           avalia quatro tarefas locais de código
  snake serve [--port 8080]       servidor HTTP/SSE com token
  snake attach [url] [sessão]     conversa com o servidor
  snake acp                       protocolo ACP v1 por stdio
  snake mcp                       servidores MCP: status, ferramentas, recursos e prompts
  snake stats [--json]            consumo agregado por dia e modelo (histórico local)
  snake export <id> [arquivo]     exporta a sessão (Markdown; --json exporta JSON)
  snake import <arquivo>          importa uma sessão JSON exportada
  snake schedule                 lista agendamentos cron locais

${t.muted('Dentro da interface, digite /help para ver comandos e atalhos.')}
`

function stdinKind() {
  try {
    const s = fs.fstatSync(0)
    if (s.isFIFO()) return 'pipe'
    if (s.isFile()) return 'file'
    if (s.isSocket()) return 'socket'
    if (s.isCharacterDevice()) return 'chr'
  } catch {}
  return 'unknown'
}

/**
 * Lê a entrada padrão. Em pipes/arquivos espera o EOF; em sockets (alguns ambientes deixam o
 * stdin aberto sem dados) desiste se nada chegar em `firstByteMs`.
 */
function readStdin({ firstByteMs = 0 } = {}) {
  return new Promise((resolve) => {
    let data = ''
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      process.stdin.pause()
      process.stdin.removeAllListeners('data')
      resolve(data)
    }
    const timer = firstByteMs ? setTimeout(() => !data && finish(), firstByteMs) : null
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (d) => (data += d))
    process.stdin.once('end', finish)
    process.stdin.once('error', finish)
    process.stdin.resume()
  })
}

function readPipedInput(hasPrompt) {
  const kind = stdinKind()
  if (kind === 'pipe' || kind === 'file') return readStdin()
  if (kind === 'chr') return readStdin({ firstByteMs: 200 })
  return readStdin({ firstByteMs: hasPrompt ? 300 : 1500 })
}

/** Lê uma linha do terminal sem eco (para chaves de API). */
export function readSecret(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin
    if (!stdin.isTTY) {
      readPipedInput(false).then((d) => resolve(d.trim()))
      return
    }
    process.stdout.write(question)
    let value = ''
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false)
          stdin.pause()
          stdin.off('data', onData)
          process.stdout.write('\n')
          resolve(value.trim())
          return
        }
        if (c === '\u0003') {
          stdin.setRawMode(false)
          process.stdout.write('\n')
          process.exit(130)
        }
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1)
        else if (c >= ' ') value += c
      }
    }
    stdin.on('data', onData)
  })
}

export function maskKey(k) {
  if (!k) return ''
  return k.length <= 10 ? '••••' : `${k.slice(0, 6)}…${k.slice(-4)}`
}

function modelPriceLabel(m) {
  const state = availability(m)
  if (state) return t.warn(state.label)
  return m.free ? t.accent(costLabel(m)) : costLabel(m)
}

function providerStatus(p) {
  const key = resolveKey(p.id)
  if (key) return t.primary('✓ chave') + t.muted(` (${key.source})`)
  if (!p.keyRequired) return p.free === 'local' ? t.muted('local') : t.primary('✓ sem chave')
  return t.error('✗ sem chave') + t.muted(` (${(p.env || [])[0] || `/key ${p.id}`})`)
}

async function cmdModels(catalog, opts) {
  if (opts.refresh) await Promise.all(['modelsdev', 'openrouter', 'pollinations', 'llm7'].map((s) => catalog.refresh(s)))
  await catalog.refreshStale({ wait: true })
  await catalog.loadLive()
  const filter = (opts._[1] || '').toLowerCase()
  const order = Object.values(PROVIDERS).sort((a, b) => rank(a) - rank(b))
  function rank(p) {
    return ({ nokey: 0, local: 1, key: 2 }[p.free] ?? 3) - (isUsable(p.id) ? 10 : 0)
  }
  let shown = 0
  const cols = process.stdout.columns || 100
  for (const p of order) {
    let list = catalog.models(p.id)
    if (opts.free) list = list.filter((m) => m.free)
    if (filter) list = list.filter((m) => `${p.id}/${m.id} ${m.name}`.toLowerCase().includes(filter))
    else if (!opts.all && !isUsable(p.id)) list = list.filter((m) => m.free).slice(0, 8)
    if (!list.length) continue
    list.sort((a, b) => Number(!!b.free) - Number(!!a.free) || String(b.released || '').localeCompare(String(a.released || '')) || a.id.localeCompare(b.id))
    console.log(`\n${t.bold(t.primary(p.name))} ${t.muted('· ' + freeLabel(p))} ${providerStatus(p)}`)
    for (const m of list) {
      const ref = `${p.id}/${m.id}`
      const right = `${padEnd(t.muted(m.context ? fmtTokens(m.context) : '?'), 6)} ${modelPriceLabel(m)}`
      const refWidth = Math.min(53, cols - strWidth(right) - 4)
      if (refWidth < 16) console.log(`  ${ref}\n    ${right}`)
      else console.log(`  ${padEnd(truncate(ref, refWidth), refWidth)} ${right}`)
      shown++
    }
  }
  if (!shown) console.log(t.muted('Nenhum modelo encontrado.'))
  console.log(t.muted(`\nUse: snake -m <provedor/modelo> · preços em US$ por 1M tokens (entrada/saída)${opts.all ? '' : ' · --all mostra tudo'}`))
}

function cmdProviders() {
  console.log()
  const narrow = (process.stdout.columns || 100) < 80
  for (const p of Object.values(PROVIDERS)) {
    if (narrow) console.log(`${t.bold(t.primary(p.id))} ${t.muted('· ' + freeLabel(p))}\n  ${providerStatus(p)}`)
    else console.log(`${padEnd(t.bold(t.primary(p.id)), 14)} ${padEnd(t.text(p.name), 20)} ${padEnd(t.muted(freeLabel(p)), 20)} ${providerStatus(p)}`)
    if (p.keyRequired && !resolveKey(p.id) && p.keyURL) console.log(`${' '.repeat(narrow ? 2 : 14)}${narrow ? '' : ' '}${t.muted('chave: ' + p.keyURL)}`)
  }
  console.log(t.muted(`\nSalve chaves com: snake key <provedor> <chave>   (ficam em ${shortPath(paths.auth)}, permissão 600)`))
}

async function cmdKey(opts) {
  const id = opts._[1]
  if (!id || !PROVIDERS[id]) {
    console.log(t.error('Informe o provedor: ') + Object.keys(PROVIDERS).join(', '))
    return 1
  }
  let key = opts._[2]
  if (!key) key = await readSecret(`Chave de API para ${PROVIDERS[id].name}: `)
  if (!key) {
    console.log(t.error('Nenhuma chave informada.'))
    return 1
  }
  setKey(id, key)
  console.log(t.primary('✓ ') + `Chave de ${PROVIDERS[id].name} salva (${maskKey(key)}) em ${shortPath(paths.auth)}`)
  return 0
}

function cmdSessions(opts) {
  const list = Session.list({ limit: 30 })
  if (opts.json) {
    console.log(JSON.stringify(list, null, 2))
    return
  }
  if (!list.length) return console.log(t.muted('Nenhuma sessão ainda.'))
  for (const s of list) {
    console.log(`${t.primary(s.id)}  ${t.muted(fmtAgo(s.updated).padEnd(14))} ${truncate(s.title || '', 50)}  ${t.muted(shortPath(s.cwd))} ${t.muted(fmtCost(s.cost || 0))}`)
  }
  console.log(t.muted('\nRetome com: snake -r <id>   ou   snake -c (última deste diretório)'))
}

async function cmdMcp(config, cwd, opts) {
  const { McpManager } = await import('./mcp/client.js')
  const op = opts._[1]
  if (op && !['list', 'status', 'tools', 'resources', 'prompts'].includes(op)) {
    console.error(t.error(`Uso: snake mcp [list|tools|resources|prompts] [--json]  (adicionar/remover: /mcp add|remove na interface)`))
    return 2
  }
  const mgr = new McpManager(config.mcp, { cwd })
  await mgr.startAll()
  const live = mgr.clients.filter((c) => c.status === 'ok')
  try {
    if (opts.json) {
      console.log(JSON.stringify(mgr.clients.map((c) => ({
        name: c.name,
        status: c.status,
        error: c.error || null,
        server: c.serverInfo,
        tools: c.tools.map((tool) => tool.name),
        resources: (c.resources || []).map((r) => r.uri),
        templates: (c.templates || []).map((r) => r.uriTemplate),
        prompts: (c.prompts || []).map((p) => p.name),
      })), null, 2))
      return 0
    }
    if (!mgr.size) {
      console.log(t.muted('Nenhum servidor MCP configurado. Adicione na interface com /mcp add <nome> <comando...> ou <url>.'))
      return 0
    }
    const mode = op || 'list'
    for (const c of mgr.clients) {
      const st = c.status === 'ok' ? t.primary('✓ conectado') : t.error(`✗ ${c.error || c.status}`)
      console.log(`${t.bold(t.primary(c.name))} ${st}${c.serverInfo?.name ? t.muted(` · ${c.serverInfo.name}${c.serverInfo.version ? ` v${c.serverInfo.version}` : ''}`) : ''}`)
      if (mode === 'list' || mode === 'status') {
        console.log(t.muted(`  ferramentas: ${c.tools.length} · recursos: ${(c.resources || []).length} · prompts: ${(c.prompts || []).length}`))
        if (c.status !== 'ok') continue
      }
      if ((mode === 'list' || mode === 'tools') && c.tools.length) {
        for (const tool of c.tools.slice(0, 20)) console.log(`  ${t.accent(tool.name)}${t.muted(` — ${(tool.description || '').slice(0, 80)}`)}`)
        if (c.tools.length > 20) console.log(t.muted(`  … +${c.tools.length - 20} ferramentas`))
      }
      if ((mode === 'list' || mode === 'resources') && ((c.resources || []).length || (c.templates || []).length)) {
        for (const r of [...(c.resources || []), ...(c.templates || []).map((x) => ({ uri: x.uriTemplate, name: `${x.name || ''} [template]` }))].slice(0, 20)) console.log(`  ${t.info(r.uri)}${t.muted(` — ${r.name || ''}`)}`)
      }
      if ((mode === 'list' || mode === 'prompts') && (c.prompts || []).length) {
        for (const p of c.prompts.slice(0, 20)) console.log(`  ${t.text(p.name)}${t.muted(` — ${p.description || ''}`)}`)
      }
    }
    if (!live.length) return 1
    return 0
  } finally {
    mgr.closeAll()
  }
}

/** Consumo agregado por dia e modelo a partir do histórico local (~/.snake/history.jsonl). */
function cmdStats(opts) {
  const groups = new Map()
  let history = ''
  try { history = fs.readFileSync(paths.history, 'utf8') } catch {}
  for (const line of history.split('\n')) {
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (e.type !== 'usage') continue
    const key = `${new Date(e.at).toISOString().slice(0, 10)} ${e.model}`
    const row = groups.get(key) || { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, apiMs: 0, unknown: false }
    for (const k of Object.keys(row)) if (k !== 'unknown') row[k] += e[k] || 0
    row.unknown ||= !!e.costUnknown
    groups.set(key, row)
  }
  if (opts.json) {
    console.log(JSON.stringify([...groups].map(([k, v]) => ({ day: k.slice(0, 10), model: k.slice(11), ...v })), null, 2))
    return 0
  }
  const text = [...groups].map(([k, v]) => `${k}\n${v.requests} requests · ↑${fmtTokens(v.input)} ↓${fmtTokens(v.output)} · cache ${fmtTokens(v.cacheRead)}/${fmtTokens(v.cacheWrite)} · ${fmtCost(v.cost, { unknown: v.unknown })} · ${(v.apiMs / 1000).toFixed(1)}s`).join('\n\n')
  console.log(text || t.muted('Sem requisições registradas nesta versão.'))
  return 0
}

function cmdExport(opts, cwd) {
  const id = opts._[1]
  if (!id) { console.error(t.error('Uso: snake export <id-da-sessão> [arquivo] [--json]')); return 2 }
  const s = Session.resolve(id)
  if (!s) { console.error(t.error(`Sessão não encontrada: ${id}`)); return 1 }
  const asJson = opts.json || opts._[2] === 'json' || (opts._[2] || '').endsWith('.json')
  const file = resolvePath(cwd, opts._[2] && opts._[2] !== 'json' ? opts._[2] : `snake-${s.id}.${asJson ? 'json' : 'md'}`)
  if (asJson) writeJSON(file, { format: 'snake-session', version: 2, ...s.toJSON() }, 0o600)
  else {
    const lines = [`# ${s.title || 'Sessão Snake'}`, '', `- Sessão: ${s.id}`, `- Modelo: ${s.model}`, `- Exportado em: ${new Date().toISOString()}`, '']
    for (const m of s.messages) lines.push(`## ${m.role}`, '', m.content || '', '')
    fs.writeFileSync(file, lines.join('\n'), { mode: 0o600 })
  }
  console.log(`Exportado: ${file}`)
  return 0
}

function cmdImport(opts, cwd) {
  const file = opts._[1]
  if (!file) { console.error(t.error('Uso: snake import <arquivo.json>')); return 2 }
  let data
  try { data = JSON.parse(fs.readFileSync(resolvePath(cwd, file), 'utf8')) } catch (e) { console.error(t.error(`Não foi possível ler: ${e.message}`)); return 1 }
  try {
    const s = Session.import(data, cwd)
    console.log(`Sessão importada: ${s.id}`)
    return 0
  } catch (e) { console.error(t.error(e.message)); return 1 }
}

function cmdConfig(config) {  console.log(`${t.bold('Pasta do Snake')}   ${shortPath(paths.home)}`)
  console.log(`${t.bold('Configuração')}     ${shortPath(paths.config)}${config._projectFile ? t.muted('  + projeto: ' + shortPath(config._projectFile)) : ''}`)
  console.log(`${t.bold('Chaves')}           ${shortPath(paths.auth)}`)
  console.log(`${t.bold('Sessões')}          ${shortPath(paths.sessions)}`)
  console.log(`${t.bold('Memória global')}   ${shortPath(paths.memory)}`)
  console.log()
  const shown = redactConfig(config)
  console.log(JSON.stringify(shown, null, 2))
}

async function cmdDoctor(catalog) {
  let problems = 0
  const ok = (s) => console.log(t.primary('✓ ') + s)
  const bad = (s) => { problems++; console.log(t.error('✗ ') + s) }
  const major = Number(process.versions.node.split('.')[0])
  ;(major >= 20 ? ok : bad)(`Node.js ${process.versions.node}`)
  const rg = spawnSync('rg', ['--version'], { encoding: 'utf8' })
  rg.status === 0 ? ok(`ripgrep ${rg.stdout.split('\n')[0].split(' ')[1]}`) : bad('ripgrep não encontrado (grep/glob usarão fallback em JS, mais lento)')
  const git = spawnSync('git', ['--version'], { encoding: 'utf8' })
  git.status === 0 ? ok(git.stdout.trim()) : bad('git não encontrado')
  ok(`Pasta de dados: ${shortPath(paths.home)}`)
  const keys = Object.values(PROVIDERS).filter((p) => resolveKey(p.id))
  keys.length ? ok(`Chaves configuradas: ${keys.map((p) => p.id).join(', ')}`) : console.log(t.muted('• Nenhuma chave configurada — usando provedores grátis sem chave.'))
  console.log(t.muted('• Testando provedor grátis (Pollinations)…'))
  try {
    const started = Date.now()
    const res = await fetch('https://text.pollinations.ai/openai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'openai-fast', messages: [{ role: 'user', content: 'Reply with: ok' }] }),
      signal: AbortSignal.timeout(30000),
    })
    res.ok ? ok(`Pollinations respondeu em ${Date.now() - started}ms`) : bad(`Pollinations: HTTP ${res.status}`)
  } catch (e) {
    bad(`Pollinations inacessível: ${e.cause?.code || e.message}`)
  }
  await catalog.refreshStale({ wait: true })
  for (const [name, err] of Object.entries(catalog.errors)) bad(`Catálogo ${name}: ${err}`)
  const total = catalog.allModels().length
  ok(`Catálogo com ${total} modelos (${catalog.allModels().filter((m) => m.free).length} grátis)`)
  return problems ? 1 : 0
}

export function redactConfig(value) {
  if (Array.isArray(value)) return value.map(redactConfig)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /api.?key|authorization|token|secret|password|cookie/i.test(key) && typeof item === 'string'
      ? '[oculto]' : redactConfig(item),
  ]))
}

function configure(cwd, opts) {
  const config = loadConfig(cwd)
  if (opts.mode) config.permissionMode = opts.mode
  if (opts.maxSteps) config.maxSteps = opts.maxSteps
  if (opts.thinking) config.thinking = true
  if (opts.effort) config.effort = validateConfig('effort', opts.effort)
  if (opts.noBoot) config.boot = false
  setTheme(config.theme)
  registerCustomProviders(config)
  return config
}

function resolveModelRef(catalog, ref) {
  const m = catalog.find(ref)
  if (m) return `${m.provider}/${m.id}`
  const slash = ref.indexOf('/')
  if (slash > 0 && PROVIDERS[ref.slice(0, slash)]) return ref
  return null
}

export async function main(argv) {
  let opts
  try {
    opts = parseArgv(argv)
  } catch (error) {
    console.error(error.message)
    return 2
  }
  if (opts.noColor) setColorLevel(0)
  if (opts.version) {
    console.log(`snake ${VERSION}`)
    return 0
  }
  if (opts.help) {
    process.stdout.write(HELP())
    return 0
  }
  if (opts.unknown) {
    console.error(t.error(`Opção desconhecida: ${opts.unknown}`) + t.muted('  (snake --help)'))
    return 2
  }
  if (opts.cwd) {
    try {
      process.chdir(opts.cwd)
    } catch {
      console.error(t.error(`Diretório inválido: ${opts.cwd}`))
      return 2
    }
  }
  ensureDirs()
  const cwd = process.cwd()
  let config = configure(cwd, opts)
  const catalog = new Catalog().load()

  const sub = !opts.print && SUBCOMMANDS.has(opts._[0]) ? opts._[0] : null
  switch (sub) {
    case 'help':
      process.stdout.write(HELP())
      return 0
    case 'version':
      console.log(`snake ${VERSION}`)
      return 0
    case 'logo':
      console.log()
      for (const l of bigLogo({ tagline: t.muted('seu agente de código no terminal') })) console.log('  ' + l)
      console.log()
      return 0
    case 'models':
      await cmdModels(catalog, opts)
      return 0
    case 'providers':
      cmdProviders()
      return 0
    case 'key':
    case 'login':
      return cmdKey(opts)
    case 'logout': {
      const id = opts._[1]
      if (!id || !getAuth()[id]) {
        console.log(t.muted(`Nenhuma chave salva para ${id || '?'}.`))
        return 1
      }
      setKey(id, null)
      console.log(t.primary('✓ ') + `Chave de ${id} removida.`)
      return 0
    }
    case 'sessions':
      cmdSessions(opts)
      return 0
    case 'mcp':
      return cmdMcp(config, cwd, opts)
    case 'stats':
      return cmdStats(opts)
    case 'export':
      return cmdExport(opts, cwd)
    case 'import':
      return cmdImport(opts, cwd)
    case 'config':
      cmdConfig(config)
      return 0
    case 'doctor':
      { const rows = await diagnose({ network: !opts.offline }); for (const r of rows) console.log(`${r.status} · ${r.name}: ${r.detail}`); return rows.some((r) => r.status === 'erro') ? 1 : 0 }
    case 'check-models':
    case 'bench': {
      await catalog.refreshStale({ wait: true })
      await catalog.loadLive()
      const refs = opts._.slice(1).flatMap((v) => v.split(','))
      const models = refs.length ? refs.map((ref) => catalog.find(ref)).filter(Boolean) : catalog.allModels().filter((m) => m.free && !m.catalogStale && isUsable(m.provider)).slice(0, 3)
      if (!models.length) { console.error('Nenhum candidato acessível. Informe provedor/modelo e configure /key se necessário.'); return 1 }
      const results = []
      for (const model of models) {
        process.stderr.write(`Verificando ${model.provider}/${model.id} (${costLabel(model)}) com tarefas sintéticas…\n`)
        const result = await (sub === 'bench' ? benchModel(model) : checkModel(model))
        results.push({ model: `${model.provider}/${model.id}`, ...result })
      }
      if (sub === 'bench') results.sort((a, b) => b.score - a.score)
      console.log(JSON.stringify(results, null, 2))
      return results.every((r) => r.ok ?? r.score >= 75) ? 0 : 1
    }
    case 'serve': {
      const { serve } = await import('./server.js')
      return serve({ config, catalog, cwd, port: opts.port || 8080, host: opts.host || '127.0.0.1', token: opts.token || process.env.SNAKE_SERVER_TOKEN || config.serverToken })
    }
    case 'attach': {
      const { attach } = await import('./server.js')
      return attach({ url: opts._[1] || 'http://127.0.0.1:8080', token: opts.token || process.env.SNAKE_SERVER_TOKEN || config.serverToken, sessionId: opts._[2], model: opts.model })
    }
    case 'acp': {
      const { runAcp } = await import('./acp.js')
      return runAcp({ config, catalog, cwd })
    }
    case 'schedule': {
      const { schedules, runSchedule } = await import('./scheduler.js')
      if (opts._[1] !== 'run') { console.log(JSON.stringify(schedules(), null, 2)); return 0 }
      return runSchedule(opts._[2], async (job) => {
        const cfg = configure(job.cwd, { mode: job.permissionMode, maxSteps: job.maxSteps })
        const session = Session.create({ cwd: job.cwd, model: job.model })
        return runHeadless({ prompt: job.prompt, config: cfg, catalog, session, json: true })
      })
    }
    case 'run':
      opts.print = true
      opts._.shift()
      break
    default:
      break
  }

  // Modelo
  if (resolveKey('openrouter') && catalog.isStale('openrouter') && !catalog.data.openrouter) await catalog.refresh('openrouter')
  let modelRef = null
  if (opts.model) {
    const provider = PROVIDERS[opts.model.split('/')[0]]
    const source = provider?.catalog
    if (['modelsdev', 'openrouter', 'pollinations', 'llm7'].includes(source)) {
      if (catalog.isStale(source)) await catalog.refresh(source)
    } else if (!provider) {
      await catalog.refreshStale({ wait: true, only: ['modelsdev', 'openrouter'] })
    }
    modelRef = resolveModelRef(catalog, opts.model)
    if (!modelRef) {
      console.error(t.error(`Modelo não encontrado: ${opts.model}`) + t.muted('  (veja: snake models)'))
      return 2
    }
  }

  // Sessão
  let session = null
  if (opts.resumeId) {
    session = Session.resolve(opts.resumeId)
    if (!session) {
      console.error(t.error(`Sessão não encontrada: ${opts.resumeId}`))
      return 2
    }
  } else if (opts.continue) {
    session = Session.latest(cwd)
  }
  if (session) {
    if (!fs.existsSync(session.cwd)) {
      console.error(t.error(`O diretório desta sessão não existe: ${session.cwd}`))
      return 2
    }
    if (session.cwd !== cwd) {
      process.chdir(session.cwd)
      config = configure(session.cwd, opts)
    }
    if (modelRef) session.model = modelRef
  } else {
    session = Session.create({ cwd, model: modelRef || null })
  }
  let notice = ''
  if (!session.model) {
    session.model = catalog.defaultRef(config)
    if (!session.model) notice = 'Nenhum modelo com tools e código verificados. Use /models para escolher explicitamente ou snake check-models e snake bench para qualificar um padrão gratuito.'
  }

  let prompt = opts._.join(' ').trim()
  if (opts.json) opts.print = true
  const piped = !process.stdin.isTTY
  if (piped && (opts.print || !process.stdout.isTTY || prompt)) {
    const input = await readPipedInput(!!prompt)
    if (input.trim()) prompt = prompt ? `${prompt}\n\n<stdin>\n${input}\n</stdin>` : input
    opts.print = true
  }

  if (opts.print) {
    if (opts.resume && !opts.resumeId) {
      console.error(t.error('Informe o id para retomar sem interface: snake -r <id> -p "prompt"'))
      return 2
    }
    if (!prompt) {
      console.error(t.error('Informe um prompt: snake -p "sua pergunta"'))
      return 2
    }
    const source = PROVIDERS[session.model?.split('/')[0]]?.catalog
    if (['modelsdev', 'openrouter', 'pollinations', 'llm7'].includes(source) && catalog.isStale(source)) await catalog.refresh(source)
    if (notice && !opts.json) process.stderr.write(t.warn('! ') + t.muted(notice) + '\n')
    const code = await runHeadless({ prompt, config, catalog, session, json: opts.json, verbose: opts.verbose })
    return code
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(t.error('O modo interativo precisa de um terminal (TTY). Use snake -p "prompt" para o modo não interativo.'))
    return 2
  }
  const { runInteractive } = await import('./ui/app.js')
  return runInteractive({ config, catalog, session, initialPrompt: prompt, pickSession: opts.resume && !opts.resumeId, notice })
}

export { saveConfig }
