// Ferramenta models: o agente consulta o catálogo sem sair do turno.
// Útil quando o contexto está cheio, um modelo falha, ou a tarefa pede outro provedor.

import { costLabel } from '../providers/pricing.js'
import { PROVIDERS, isUsable } from '../providers/registry.js'

/** Cria a ferramenta vinculada ao catálogo da sessão. */
export function modelsTool(catalog) {
  return {
    name: 'models',
    label: 'Models',
    readOnly: true,
    description:
      'Search the available models grouped by provider (newest/free first). Use it to pick a model for a subagent, to switch providers when one fails, or to check context window and pricing before a heavy task. Returns "provider/id · name · context · cost".',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search in model names and ids' },
        provider: { type: 'string', description: 'Provider id to filter by (e.g. "openrouter")' },
        limit: { type: 'integer', description: 'Max models to return (default 20, max 100)' },
      },
    },
    summary(args) {
      return [args?.provider, args?.query].filter(Boolean).join(' ') || 'todos'
    },
    async run(args) {
      if (!catalog) return { output: 'Catálogo indisponível.', isError: true }
      const q = String(args?.query || '').toLowerCase()
      const provider = String(args?.provider || '').toLowerCase()
      const limit = Math.max(1, Math.min(100, Number(args?.limit) || 20))
      let list = catalog.allModels()
      if (provider) {
        list = list.filter((m) => m.provider === provider || (PROVIDERS[m.provider]?.name || '').toLowerCase().includes(provider))
        if (!list.length) return { output: `Provedor não encontrado: ${provider}. Provedores: ${Object.keys(PROVIDERS).join(', ')}.`, isError: true }
      }
      if (q) list = list.filter((m) => `${m.provider}/${m.id} ${m.name || ''}`.toLowerCase().includes(q))
      const rank = (m) => (isUsable(m.provider) ? 0 : 2) - (m.free ? 1 : 0)
      list.sort((a, b) => rank(a) - rank(b) || String(b.released || '').localeCompare(String(a.released || '')) || a.id.localeCompare(b.id))
      const total = list.length
      const lines = list.slice(0, limit).map((m) => {
        const ctx = m.context ? `${Math.round(m.context / 1000)}k` : '?'
        return `${m.provider}/${m.id} · ${m.name || m.id} · ${ctx} · ${costLabel(m)}`
      })
      if (!lines.length) return { output: 'Nenhum modelo encontrado.', display: { summary: 'nenhum modelo' } }
      const more = total > limit ? `\n(… mais ${total - limit} de ${total}; refine com query/provider)` : ''
      return { output: lines.join('\n') + more, display: { summary: `${Math.min(total, limit)} modelo(s)` } }
    },
  }
}
