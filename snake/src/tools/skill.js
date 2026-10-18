import { discoverSkills } from '../agent/resources.js'
export const skill = {
  name: 'skill', label: 'Skill', readOnly: true,
  description: 'Load an available SKILL.md guide by name before doing specialized work. Relative resources resolve against the returned guide directory.',
  parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  summary: (a) => a.name,
  async run(args, ctx) {
    const item = discoverSkills(ctx.cwd).find((s) => s.name === args.name)
    if (!item) return { output: `Skill não encontrada: ${args.name}`, isError: true }
    if (ctx.session) { ctx.session.skills ||= []; if (!ctx.session.skills.includes(item.name)) ctx.session.skills.push(item.name) }
    return { output: `Guia: ${item.file}\n\n${item.body}` }
  },
}
export const question = {
  name: 'question', label: 'Pergunta', readOnly: true,
  description: 'Ask the user a concise question with optional choices and wait for an answer. Do not use for tool permissions.',
  parameters: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, required: ['question'] },
  summary: (a) => a.question,
  async run(args, ctx) {
    if (!args.question) return { output: 'Pergunta vazia.', isError: true }
    if (!ctx.askQuestion) return { output: 'Pergunta pendente: interface não interativa. Explique o que falta ao usuário e encerre o turno.', isError: true }
    const answer = await ctx.askQuestion(args)
    return { output: answer == null ? 'Pergunta cancelada pelo usuário.' : `Resposta do usuário: ${answer}` }
  },
}
