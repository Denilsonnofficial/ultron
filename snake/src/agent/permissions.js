import fs from 'node:fs'
import path from 'node:path'
import { globToRegExp, resolvePath } from '../tools/util.js'

export const EDIT_TOOLS = ['edit', 'write', 'multiedit', 'apply_patch']

export function permissionTarget(tool, args = {}, cwd) {
  if (tool.name === 'bash' || tool.name === 'terminal') return String(args.command || args.cmd || args.script || args.input || '')
  const p = args.path || args.file_path || args.filePath || args.file || args.directory
  if (p) {
    const abs = resolvePath(cwd, p)
    try { return fs.realpathSync(abs) } catch { return abs }
  }
  return String(args.name || '')
}

export function permissionDecision({ config, mode, tool, args, cwd, sessionRules = {} }) {
  if (mode === 'plan' && (!tool.readOnly || args?.kill)) return 'deny'
  const target = permissionTarget(tool, args, cwd)
  const candidates = []
  for (const rules of [config.permissions || {}, sessionRules]) {
    for (const [name, rule] of Object.entries(rules)) {
      if (!globToRegExp(name).test(tool.name)) continue
      const base = name.replace(/[?*]/g, '').length * 1000
      if (typeof rule === 'string') candidates.push({ action: rule, score: base })
      else for (const [pattern, action] of rule.pattern ? [[rule.pattern, rule.action]] : Object.entries(rule || {})) {
        const p = pattern.startsWith('~') ? resolvePath(cwd, pattern) : pattern
        const regex = ['bash', 'terminal'].includes(tool.name) ? new RegExp('^' + p.split('*').map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\?/g, '.')).join('.*') + '$') : globToRegExp(p)
        if (regex.test(target) || regex.test(path.relative(cwd, target).replaceAll('\\', '/'))) candidates.push({ action, score: base + pattern.replace(/[?*]/g, '').length + 1 })
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score || Number(b.action === 'deny') - Number(a.action === 'deny'))
  const explicit = candidates[0]?.action
  if (explicit === 'deny') return 'deny'
  if (explicit === 'allow') return 'allow'
  if (mode === 'dontAsk') return tool.readOnly && explicit !== 'ask' ? 'allow' : 'deny'
  if (explicit === 'ask') return 'ask'
  if (tool.readOnly) return 'allow'
  if (mode === 'ask' || (mode === 'acceptEdits' && !EDIT_TOOLS.includes(tool.name))) return 'ask'
  return 'allow'
}
