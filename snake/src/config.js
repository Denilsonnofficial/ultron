// Caminhos, configuração (global + projeto) e chaves de API do Snake.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const VERSION = '0.3.0'

export const SNAKE_HOME = process.env.SNAKE_HOME || path.join(os.homedir(), '.snake')

export const paths = {
  home: SNAKE_HOME,
  config: path.join(SNAKE_HOME, 'config.json'),
  auth: path.join(SNAKE_HOME, 'auth.json'),
  sessions: path.join(SNAKE_HOME, 'sessions'),
  cache: path.join(SNAKE_HOME, 'cache'),
  history: path.join(SNAKE_HOME, 'history.jsonl'),
  commands: path.join(SNAKE_HOME, 'commands'),
  memory: path.join(SNAKE_HOME, 'SNAKE.md'),
  tmp: path.join(SNAKE_HOME, 'tmp'),
  log: path.join(SNAKE_HOME, 'snake.log'),
  skills: path.join(SNAKE_HOME, 'skills'),
  agents: path.join(SNAKE_HOME, 'agents'),
  notes: path.join(SNAKE_HOME, 'memory.md'),
  schedules: path.join(SNAKE_HOME, 'schedules.json'),
}

export const DEFAULTS = {
  model: null, // variante gratuita explícita ou endpoint anônimo com cota
  permissionMode: 'yolo', // yolo | ask | plan
  showThinking: false,
  showTurnStats: true,
  autoCompact: true,
  compactThreshold: 0.85,
  maxSteps: 100,
  maxOutputTokens: 32000,
  bashTimeoutMs: 120000,
  firstByteTimeoutMs: 180000, // sem nenhum dado do provedor nesse tempo, a requisição é refeita
  streamIdleTimeoutMs: 120000, // resposta parada no meio por esse tempo: aborta em vez de travar o turno
  thinking: false, // raciocínio estendido em modelos Anthropic
  thinkingBudget: 8000,
  temperature: null,
  providers: {}, // provedores personalizados compatíveis com OpenAI
  mcp: {}, // servidores MCP
  disabledTools: [],
  boot: true,
  theme: 'serpente',
  keymap: { 'ctrl+c': 'interrupt', 'shift+tab': 'cycleMode', 'ctrl+x': 'leader', 'ctrl+o': 'expand', 'ctrl+d': 'diff' },
  sidebar: false,
  statusline: '',
  title: 'snake · {modelo}',
  effort: 'auto',
  outputStyle: 'markdown',
  agent: 'build',
  goal: null,
  goalBudget: 0,
  maxParallelSubagents: 3,
  permissions: { read: { '**/.env': 'deny', '**/.env.*': 'deny' } },
  pruneOutputs: true,
  outputCap: 50 * 1024, // bytes de saída de ferramenta enviados ao modelo (o resto vai para um arquivo)
  snapshots: true,
  snapshotMaxBytes: 20 * 1024 * 1024,
  hooks: {},
  formatters: {},
  diagnostics: true, // verificação de sintaxe depois de cada edição (node --check, python ast, bash -n, JSON)
  lsp: {},
  bgJobs: true,
  extraDirs: [],
  serverToken: '',
  loopMax: 5,
  ratelimit: {},
}

export function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeJSON(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', mode ? { mode } : undefined)
  fs.renameSync(tmp, file)
  if (mode) fs.chmodSync(file, mode)
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v)
}

export function deepMerge(...objs) {
  const out = {}
  for (const obj of objs) {
    if (!isPlainObject(obj)) continue
    for (const [k, v] of Object.entries(obj)) {
      if (['__proto__', 'constructor', 'prototype'].includes(k)) continue
      out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v
    }
  }
  return out
}

/** Procura configuração de projeto (.snake/config.json ou snake.json) do cwd para cima. */
export function findProjectConfig(cwd) {
  let dir = path.resolve(cwd)
  const home = path.resolve(os.homedir())
  for (;;) {
    for (const rel of [path.join('.snake', 'config.json'), 'snake.json']) {
      const file = path.join(dir, rel)
      if (file === paths.config) continue
      if (fs.existsSync(file)) return { file, data: readJSON(file, {}) }
    }
    const parent = path.dirname(dir)
    if (parent === dir || dir === home) return null
    dir = parent
  }
}

export function loadConfig(cwd = process.cwd()) {
  const global = readJSON(paths.config, {})
  const project = findProjectConfig(cwd)
  const config = deepMerge(DEFAULTS, global, project?.data || {})
  if (process.env.SNAKE_THEME) config.theme = process.env.SNAKE_THEME
  Object.defineProperty(config, '_projectFile', { value: project?.file || null, enumerable: false })
  return config
}

export const PERMISSION_MODES = ['yolo', 'ask', 'plan', 'auto', 'acceptEdits', 'dontAsk', 'bypassPermissions']
export const EFFORTS = ['auto', 'none', 'low', 'medium', 'high', 'max']

export function validateConfig(key, value) {
  if (!Object.hasOwn(DEFAULTS, key)) throw new Error(`Configuração desconhecida: ${key}`)
  const base = DEFAULTS[key]
  if (base !== null && (typeof base !== typeof value || Array.isArray(base) !== Array.isArray(value))) throw new Error(`Tipo inválido para ${key}`)
  if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) throw new Error(`${key} deve ser um número não negativo`)
  if (['maxSteps', 'maxOutputTokens', 'maxParallelSubagents', 'outputCap', 'loopMax'].includes(key) && (!Number.isSafeInteger(value) || value < 1)) throw new Error(`${key} deve ser inteiro positivo`)
  if (key === 'permissionMode' && !PERMISSION_MODES.includes(value)) throw new Error('Modo inválido')
  if (key === 'effort' && !EFFORTS.includes(value)) throw new Error('Esforço inválido')
  if (key === 'compactThreshold' && (value <= 0 || value >= 1)) throw new Error('Use uma fração entre 0 e 1')
  return value
}

/** Grava alterações na configuração global (~/.snake/config.json). */
export function saveConfig(patch) {
  const current = readJSON(paths.config, {})
  const next = deepMerge(current, patch)
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k]
  writeJSON(paths.config, next, 0o600)
  return next
}

export function getAuth() {
  return readJSON(paths.auth, {})
}

export function setKey(provider, key) {
  const auth = getAuth()
  if (key) auth[provider] = key
  else delete auth[provider]
  writeJSON(paths.auth, auth, 0o600)
}

export function ensureDirs() {
  for (const dir of [paths.home, paths.sessions, paths.cache, paths.tmp]) fs.mkdirSync(dir, { recursive: true })
}

export function shortPath(p) {
  const home = os.homedir()
  return p === home ? '~' : p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p
}
