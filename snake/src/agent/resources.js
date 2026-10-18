import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { paths } from '../config.js'

function scalar(v) {
  v = v.trim()
  try { return JSON.parse(v) } catch {}
  if (/^\[.*\]$/.test(v)) return v.slice(1, -1).split(',').map(scalar)
  return v.replace(/^(['"])(.*)\1$/, '$2')
}

// Subconjunto explícito de YAML: escalares, listas inline e mapas indentados.
export function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!match) return { meta: {}, body: text }
  const meta = {}, stack = [{ indent: -1, value: meta }]
  for (const line of match[1].split(/\r?\n/)) {
    const m = /^(\s*)([\w.-]+):\s*(.*)$/.exec(line)
    if (!m || ['__proto__', 'constructor', 'prototype'].includes(m[2])) continue
    while (stack.length > 1 && m[1].length <= stack.at(-1).indent) stack.pop()
    const parent = stack.at(-1).value
    parent[m[2]] = m[3] ? scalar(m[3]) : {}
    if (!m[3]) stack.push({ indent: m[1].length, value: parent[m[2]] })
  }
  return { meta, body: text.slice(match[0].length) }
}

export function discoverSkills(cwd) {
  const dirs = [path.join(os.homedir(), '.claude/skills'), paths.skills, path.join(cwd, '.claude/skills'), path.join(cwd, '.snake/skills')]
  const found = new Map()
  for (const dir of dirs) {
    for (const entry of entries(dir)) {
      const file = path.join(dir, entry, 'SKILL.md')
      try {
        const { meta, body } = frontmatter(fs.readFileSync(file, 'utf8'))
        if (typeof meta.name !== 'string' || typeof meta.description !== 'string' || !meta.name.trim() || !meta.description.trim()) continue
        found.set(meta.name, { ...meta, file, body })
      } catch {}
    }
  }
  return [...found.values()]
}

export const BUILTIN_AGENTS = [
  { name: 'build', description: 'Implementação e testes', mode: 'primary', color: 'green' },
  { name: 'plan', description: 'Investigar e planejar sem alterar arquivos', mode: 'both', permission: 'plan' },
  { name: 'explore', description: 'Busca e leitura do projeto', mode: 'both', permission: 'plan', tools: ['read', 'glob', 'grep', 'ls', 'skill', 'lsp-definition', 'lsp-references', 'lsp-hover', 'lsp-symbols'] },
  { name: 'general', description: 'Tarefa independente completa', mode: 'both' },
]
const entries = (dir) => { try { return fs.readdirSync(dir).sort() } catch { return [] } }

export function discoverAgents(cwd) {
  const found = new Map(BUILTIN_AGENTS.map((a) => [a.name, a]))
  for (const dir of [paths.agents, path.join(cwd, '.snake/agents')]) {
    for (const name of entries(dir).filter((f) => f.endsWith('.md'))) {
      try {
        const { meta, body } = frontmatter(fs.readFileSync(path.join(dir, name), 'utf8'))
        if (!meta.description || !['primary', 'subagent', 'both'].includes(meta.mode || 'both')) continue
        const id = name.slice(0, -3)
        found.set(id, { name: id, mode: 'both', ...meta, body })
      } catch {}
    }
  }
  return [...found.values()]
}
