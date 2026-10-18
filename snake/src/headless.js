// Modo não interativo: `snake -p "pergunta"`. Texto da resposta vai para stdout; atividade e consumo para stderr.

import { Agent } from './agent/agent.js'
import { cacheHitRate } from './agent/usage.js'
import { McpManager } from './mcp/client.js'
import { errorHint } from './providers/sse.js'
import { killAllBackground } from './tools/bash.js'
import { colorLevel, dim, t } from './theme.js'
import { fmtCost, fmtDuration, fmtTokens } from './ui/format.js'

export async function runHeadless({ prompt, config, catalog, session, json = false, verbose = false }) {
  const out = process.stdout
  const err = process.stderr
  const showActivity = verbose || (err.isTTY && !json)
  const c = (fn, s) => (colorLevel() ? fn(s) : s)
  let atLineStart = true
  const writeOut = (s) => {
    if (json || !s) return
    out.write(s)
    atLineStart = s.endsWith('\n')
  }
  const toolLog = []
  const summaries = new Map()
  const controller = new AbortController()
  const mcp = new McpManager(config.mcp, { cwd: session.cwd })
  const onSigint = () => controller.abort()
  process.on('SIGINT', onSigint)

  const agent = new Agent({
    session,
    config,
    catalog,
    ui: {
      emit(type, data) {
        if (type === 'stream' && data.type === 'text') writeOut(data.delta)
        if (type === 'assistant' && data.message.toolCalls?.length && !atLineStart) writeOut('\n')
        if (type === 'tool-start') summaries.set(data.call.id, String(data.summary || '').replace(/\s+/g, ' ').slice(0, 120))
        if (type === 'tool-end') {
          const r = data.result
          toolLog.push({ name: data.call.name, args: data.args, isError: !!r.isError, summary: r.display?.summary || '' })
          // título e resultado juntos, no fim: com ferramentas em paralelo a ordem continua legível
          if (showActivity) {
            const label = data.tool?.label || data.call.name
            const summary = summaries.get(data.call.id) || ''
            const time = r.elapsedMs >= 1000 ? c(t.muted, ` · ${fmtDuration(r.elapsedMs)}`) : ''
            const result = r.isError ? c(t.error, String(r.output || 'erro').replace(/^Erro:\s*/, '').split('\n')[0].slice(0, 160)) : c(t.muted, r.display?.summary || 'ok')
            err.write(c(r.isError ? t.error : t.primary, '● ') + c(t.bold, label) + (summary ? ' ' + summary : '') + time + '\n' + c(t.muted, '  └ ') + result + '\n')
          }
        }
        if (type === 'retry' && showActivity) err.write(c(t.warn, `  ↻ ${data.error.message.slice(0, 160)} — nova tentativa em ${fmtDuration(data.delay)}`) + '\n')
        if (type === 'notice' && showActivity) err.write(c(t.warn, `  ! ${data.text}`) + '\n')
        if (type === 'compact-start' && showActivity) err.write(c(t.muted, '  ✻ compactando contexto…') + '\n')
      },
    },
  })

  const started = Date.now()
  let error = null
  try {
    if (config.permissionMode === 'ask') throw new Error('O modo ASK precisa da interface interativa. Use --yolo ou --plan com -p.')
    await mcp.startAll()
    const failed = mcp.clients.filter((client) => client.status !== 'ok')
    if (failed.length) throw new Error(failed.map((client) => `MCP ${client.name}: ${client.error}`).join('; '))
    agent.extraTools = mcp.tools()
    await agent.run(prompt, { signal: controller.signal })
  } catch (e) {
    error = e
  } finally {
    process.off('SIGINT', onSigint)
    mcp.closeAll()
    await agent.close()
    killAllBackground()
  }
  if (!json && !atLineStart) out.write('\n')
  const u = session.usage.total
  const model = agent.modelRef
  if (json) {
    const last = [...session.messages].reverse().find((m) => m.role === 'assistant')
    out.write(
      JSON.stringify(
        {
          ok: !error,
          error: error ? String(error.message || error) : undefined,
          result: last?.content || '',
          model,
          session: session.id,
          durationMs: Date.now() - started,
          usage: {
            input: u.input,
            output: u.output,
            cacheRead: u.cacheRead,
            cacheWrite: u.cacheWrite,
            reasoning: u.reasoning,
            requests: u.requests,
            costUSD: u.costUnknown ? null : Number(u.cost.toFixed(6)),
            knownCostUSD: Number(u.cost.toFixed(6)),
            costUnknown: u.costUnknown,
            costEstimated: u.costEstimated,
            estimated: u.estimated,
          },
          tools: toolLog,
        },
        null,
        2,
      ) + '\n',
    )
  } else {
    if (error) {
      const hint = errorHint(error)
      err.write(c(t.error, `✗ ${error.message}`) + (hint ? '\n' + c(t.muted, `  ${hint}`) : '') + '\n')
    }
    if (showActivity || verbose) {
      const est = u.estimated ? '~' : ''
      err.write(
        dim(
          `🐍 ${model} · ${fmtDuration(Date.now() - started)} · ↑${est}${fmtTokens(u.input)} ↓${est}${fmtTokens(u.output)} · cache ${fmtTokens(u.cacheRead)} lidos/${fmtTokens(u.cacheWrite)} gravados (${Math.round(cacheHitRate(u) * 100)}%) · ${fmtCost(u.cost, { free: !!agent.model.free && !u.cost, unknown: u.costUnknown, estimated: u.costEstimated })}`,
        ) + '\n',
      )
    }
  }
  return error ? 1 : 0
}
