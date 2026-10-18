// Registro das ferramentas disponíveis para o agente.

import { bash, bashOutput } from './bash.js'
import edit, { applyPatch, multiedit } from './edit.js'
import read from './read.js'
import { glob, grep, ls } from './search.js'
import { todowrite } from './todo.js'
import { webfetch, websearch } from './web.js'
import write from './write.js'
import { skill, question } from './skill.js'

export const task = {
  name: 'task',
  label: 'Task',
  readOnly: false,
  description:
    'Launch a sub-agent with a fresh, separate context to handle a self-contained task (e.g. researching how something works across the codebase, finding where a feature is implemented, or an isolated multi-step change). It has the same tools (except task/todowrite) and returns a final report. It does NOT see this conversation, so give it a complete, detailed prompt.',
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'Short description of the task (3-6 words)' },
      prompt: { type: 'string', description: 'Complete instructions for the sub-agent' },
      subagent_type: { type: 'string', description: 'Agent type, e.g. explore, plan or general' },
      job_id: { type: 'string', description: 'Resume an existing child job' },
    },
    required: ['description', 'prompt'],
  },
  summary(args) {
    return String(args?.description || '')
  },
  async run(args, ctx) {
    if (!ctx.runSubagent) return { output: 'Erro: subagentes indisponíveis neste contexto.', isError: true }
    if (!args?.prompt && !args?.description) return { output: 'Erro: "prompt" é obrigatório.', isError: true }
    return ctx.runSubagent(args)
  },
}

export const BUILTIN_TOOLS = [bash, bashOutput, read, write, edit, multiedit, applyPatch, glob, grep, ls, webfetch, websearch, todowrite, task, skill, question]

/** Ferramentas ativas conforme o modo de permissão. */
export function getTools({ mode = 'yolo', disabled = [], extra = [], subagent = false } = {}) {
  let tools = [...BUILTIN_TOOLS, ...extra]
  if (subagent) tools = tools.filter((t) => t.name !== 'task' && t.name !== 'todowrite')
  if (mode === 'plan') tools = tools.filter((t) => t.readOnly)
  return tools.filter((t) => !disabled.includes(t.name))
}

export function findTool(tools, name) {
  if (!name) return null
  const exact = tools.find((t) => t.name === name)
  if (exact) return exact
  const clean = String(name)
    .replace(/<\|.*$/s, '')
    .replace(/^(functions?|tools?)[.:]/i, '')
    .trim()
    .toLowerCase()
  return tools.find((t) => t.name.toLowerCase() === clean || t.label?.toLowerCase() === clean) || null
}
