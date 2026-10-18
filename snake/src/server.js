import http from 'node:http'
import crypto from 'node:crypto'
import readline from 'node:readline'
import { Runner } from './runner.js'
import { Session } from './agent/session.js'
import { saveConfig, paths } from './config.js'
import { sseEvents } from './providers/sse.js'

export async function createServer({ config, catalog, cwd, token }) {
  if (!token || token.length < 16) throw new Error('serverToken precisa ter pelo menos 16 caracteres')
  const streams = new Set(), questions = new Map()
  const broadcast = (sessionId, type, data) => {
    const event = JSON.stringify({ sessionId, type, data })
    for (const stream of streams) if (!stream.sessionId || stream.sessionId === sessionId) {
      if (!stream.res.write(`data: ${event}\n\n`)) { stream.res.end(); streams.delete(stream) }
    }
  }
  const ask = (sessionId, kind, data, signal) => new Promise((resolve) => {
    const id = crypto.randomUUID()
    const finish = (answer) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); questions.delete(id); resolve(answer) }
    const abort = () => finish(kind === 'permission' ? 'deny' : null)
    const timer = setTimeout(abort, 5 * 60 * 1000)
    questions.set(id, { sessionId, kind, finish }); signal?.addEventListener('abort', abort, { once: true })
    broadcast(sessionId, kind, { id, ...data })
    if (signal?.aborted) abort()
  })
  const runner = new Runner({ config, catalog, cwd, emit: broadcast, askPermission: (id, r) => ask(id, 'permission', { tool: r.tool.name, summary: r.summary, args: r.args }, runner.get(id).controller?.signal), askQuestion: (id, r) => ask(id, 'question', { question: r.question, options: r.options }, r.signal) })
  const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)) }
  const server = http.createServer(async (req, res) => {
    const got = Buffer.from(req.headers.authorization?.replace(/^Bearer /, '') || ''), expected = Buffer.from(token)
    if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return json(res, 401, { error: 'Token inválido' })
    try {
      const url = new URL(req.url, 'http://localhost'), parts = url.pathname.split('/').filter(Boolean)
      if (req.method === 'GET' && url.pathname === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); res.write(': conectado\n\n')
        const stream = { res, sessionId: url.searchParams.get('session') }; streams.add(stream)
        const timer = setInterval(() => res.write(': ping\n\n'), 15000)
        req.on('close', () => { clearInterval(timer); streams.delete(stream) }); return
      }
      if (req.method === 'GET' && url.pathname === '/sessions') return json(res, 200, { sessions: Session.list({ limit: 200 }) })
      if (req.method === 'GET' && parts[0] === 'sessions' && parts.length === 2) return json(res, 200, runner.get(parts[1]).session.toJSON())
      if (req.method !== 'POST') return json(res, 404, { error: 'Rota não encontrada' })
      let raw = '', size = 0
      req.setEncoding('utf8')
      for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) return json(res, 413, { error: 'Corpo excede 1 MiB' }); raw += chunk.toString('utf8') }
      const body = raw ? JSON.parse(raw) : {}
      if (url.pathname === '/sessions') return json(res, 201, { sessionId: runner.create(body).id })
      if (parts[0] === 'sessions' && parts[2] === 'messages') {
        const task = runner.prompt(parts[1], body.content)
        task.then((result) => broadcast(parts[1], 'completed', result)).catch((e) => broadcast(parts[1], 'error', { message: e.message }))
        return json(res, 202, { sessionId: parts[1], accepted: true })
      }
      if (parts[0] === 'sessions' && parts[2] === 'cancel') { runner.cancel(parts[1]); return json(res, 200, { cancelled: true }) }
      if (parts[0] === 'answers' && parts.length === 2) {
        const pending = questions.get(parts[1]); if (!pending) return json(res, 404, { error: 'Pergunta expirada' })
        if (pending.kind === 'permission' && !['allow', 'always', 'pattern', 'deny'].includes(body.answer)) throw new Error('Resposta de permissão inválida')
        pending.finish(body.answer); return json(res, 200, { ok: true })
      }
      return json(res, 404, { error: 'Rota não encontrada' })
    } catch (e) { if (!res.headersSent) json(res, e.status || 400, { error: e.message }); else res.end() }
  })
  return { server, runner, close: async () => {
    for (const p of questions.values()) p.finish(p.kind === 'permission' ? 'deny' : null)
    for (const s of streams) s.res.end()
    await runner.close()
    await new Promise((resolve) => server.close(resolve))
  } }
}

export async function serve(opts) {
  if (!opts.token) { opts.token = crypto.randomBytes(24).toString('hex'); saveConfig({ serverToken: opts.token }); console.log(`Token gerado em ${paths.config}; snake attach usa esse token automaticamente.`) }
  const service = await createServer(opts)
  await new Promise((resolve, reject) => { service.server.once('error', reject); service.server.listen(opts.port, opts.host, resolve) })
  console.log(`Snake escutando em http://${opts.host}:${service.server.address().port}`)
  return new Promise((resolve) => {
    let closing = false
    const close = async () => { if (closing) return; closing = true; process.off('SIGINT', close); process.off('SIGTERM', close); await service.close(); resolve(0) }
    process.on('SIGINT', close); process.on('SIGTERM', close)
  })
}

export async function attach({ url, token, sessionId, model }) {
  if (!token) throw new Error('Configure serverToken ou SNAKE_SERVER_TOKEN')
  url = url.replace(/\/$/, '')
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const request = async (route, data) => { const r = await fetch(url + route, { headers, ...(data ? { method: 'POST', body: JSON.stringify(data) } : {}) }); const j = await r.json(); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j }
  if (!sessionId) {
    const list = await request('/sessions'); sessionId = list.sessions[0]?.id
    if (!sessionId) sessionId = (await request('/sessions', model ? { model } : {})).sessionId
  }
  const controller = new AbortController(), response = await fetch(`${url}/events?session=${encodeURIComponent(sessionId)}`, { headers, signal: controller.signal })
  if (!response.ok) throw new Error(`SSE: HTTP ${response.status}`)
  console.log(`Conectado à sessão ${sessionId}. /cancel interrompe; /exit sai.`)
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '❯ ' })
  const pending = []
  const events = (async () => {
    try {
      for await (const e of sseEvents(response.body)) {
        const event = JSON.parse(e.data)
        if (event.type === 'stream' && event.data.type === 'text') process.stdout.write(event.data.delta)
        if (event.type === 'tool-start') console.log(`\n● ${event.data.tool?.name || event.data.call?.name}`)
        if (event.type === 'permission' || event.type === 'question') { pending.push(event.data); console.log(`\n${event.data.question || `Permitir ${event.data.tool}: ${event.data.summary}? allow / deny / always`}`); if (event.data.options) console.log(event.data.options.join(' · ')); rl.prompt() }
        if (event.type === 'error') console.error(`\nErro: ${event.data.message}`)
        if (event.type === 'completed') { process.stdout.write('\n'); rl.prompt() }
      }
    } catch (e) { if (!controller.signal.aborted) console.error(e.message) }
    finally { rl.close() }
  })()
  rl.prompt()
  try {
    for await (const line of rl) {
      const text = line.trim(); if (!text) { rl.prompt(); continue }
      if (text === '/exit') break
      try {
        if (text === '/cancel') await request(`/sessions/${sessionId}/cancel`, {})
        else if (pending.length) { const q = pending[0]; await request(`/answers/${q.id}`, { answer: text }); pending.shift() }
        else await request(`/sessions/${sessionId}/messages`, { content: text })
      } catch (e) { console.error(e.message); rl.prompt() }
    }
  } finally { controller.abort(); rl.close(); await events }
  return 0
}
