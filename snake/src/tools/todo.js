// Lista de tarefas que o agente usa para planejar e mostrar progresso.

const STATUSES = new Set(['pending', 'in_progress', 'completed', 'cancelled'])

function normalizeStatus(s) {
  const v = String(s || 'pending')
    .toLowerCase()
    .replace(/[\s-]/g, '_')
  if (STATUSES.has(v)) return v
  if (['done', 'complete', 'finished', 'concluido', 'concluída', 'concluido'].includes(v)) return 'completed'
  if (['doing', 'active', 'progress', 'em_andamento', 'in_progresss'].includes(v)) return 'in_progress'
  if (['canceled', 'cancelado', 'skipped'].includes(v)) return 'cancelled'
  return 'pending'
}

export const todowrite = {
  name: 'todowrite',
  label: 'TodoWrite',
  readOnly: true,
  description:
    'Create or update the task list for the current work. Send the FULL list every time (it replaces the previous one). Use it for multi-step tasks: mark one item "in_progress" before starting it and "completed" right after finishing. Statuses: pending, in_progress, completed, cancelled.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The complete, updated task list',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Task description' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  summary(args) {
    const list = Array.isArray(args?.todos) ? args.todos : []
    const done = list.filter((t) => normalizeStatus(t.status) === 'completed').length
    return `${done}/${list.length}`
  },
  async run(args, ctx) {
    let list = args?.todos
    if (typeof list === 'string') {
      try {
        list = JSON.parse(list)
      } catch {
        list = null
      }
    }
    if (!Array.isArray(list)) return { output: 'Erro: "todos" deve ser uma lista de {content, status}.', isError: true }
    const todos = list
      .map((t, i) => ({
        id: String(t.id ?? i + 1),
        content: String(t.content ?? t.title ?? t.task ?? t.description ?? '').trim(),
        status: normalizeStatus(t.status),
      }))
      .filter((t) => t.content)
    ctx.setTodos?.(todos)
    const mark = { pending: '[ ]', in_progress: '[~]', completed: '[x]', cancelled: '[-]' }
    const done = todos.filter((t) => t.status === 'completed').length
    return {
      output: `Lista atualizada (${done}/${todos.length} concluídas):\n` + todos.map((t) => `${mark[t.status]} ${t.content}`).join('\n'),
      display: { summary: `${done}/${todos.length} concluídas`, todos },
    }
  },
}
