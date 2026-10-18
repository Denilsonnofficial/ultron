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
  description: 'Ask the user concise questions with optional choices and wait for answers. Accepts one {question, options} or several via "questions" (asked in order). A free-text answer is always allowed; do not use for tool permissions.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'Single question to ask' },
      header: { type: 'string', description: 'Short title shown above a single question' },
      options: { type: 'array', items: { type: 'string' }, description: 'Choices for a single question' },
      questions: {
        type: 'array',
        description: 'Several questions to ask in order',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            header: { type: 'string' },
            options: { type: 'array', items: { type: 'string' } },
          },
          required: ['question'],
        },
      },
    },
  },
  summary: (a) => {
    const list = Array.isArray(a?.questions) ? a.questions : a?.question ? [a] : []
    return list.map((q) => (typeof q === 'string' ? q : q?.question || '')).filter(Boolean).slice(0, 2).join(' · ') || ''
  },
  async run(args, ctx) {
    let list = []
    if (Array.isArray(args?.questions) && args.questions.length) {
      list = args.questions.map((q) => (typeof q === 'string' ? { question: q } : { question: q?.question, header: q?.header, options: q?.options }))
    } else if (args?.question) {
      list = [{ question: args.question, header: args.header, options: args.options }]
    }
    list = list.filter((q) => q?.question && String(q.question).trim())
    if (!list.length) return { output: 'Pergunta vazia.', isError: true }
    if (list.length > 4) return { output: 'Erro: no máximo 4 perguntas por chamada.', isError: true }
    if (!ctx.askQuestion) return { output: 'Pergunta pendente: interface não interativa. Explique o que falta ao usuário e encerre o turno.', isError: true }
    const answers = []
    for (const q of list) {
      const answer = await ctx.askQuestion({ question: String(q.question), header: q.header ? String(q.header) : undefined, options: Array.isArray(q.options) ? q.options.map(String) : undefined })
      answers.push(answer)
    }
    if (answers.every((a) => a == null)) return { output: 'Perguntas canceladas pelo usuário.' }
    const lines = list.map((q, i) => `"${q.question}"="${answers[i] == null ? 'sem resposta' : answers[i]}"`)
    return { output: answers.length === 1 ? (answers[0] == null ? 'Pergunta cancelada pelo usuário.' : `Resposta do usuário: ${answers[0]}`) : `Respostas do usuário: ${lines.join(', ')}` }
  },
}
