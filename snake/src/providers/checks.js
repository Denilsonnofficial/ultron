import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { streamWithRetry } from './index.js'
import { writeEvidence } from './evidence.js'
import { BENCH_TASKS } from './bench-tasks.js'

const invoke = (opts) => streamWithRetry({ ...opts, signal: opts.signal || AbortSignal.timeout(60000) }, { retries: 0 })
export async function checkModel(model, { signal } = {}) {
  const nonce = 'ok-' + crypto.randomBytes(8).toString('hex')
  const tool = { name: 'echo', description: 'Echo exactly the supplied text.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }
  const messages = [{ role: 'user', content: `Call echo with text=${nonce}, then report the exact tool result. You must call the tool.` }]
  let result
  try {
    const first = await invoke({ model, messages, tools: [tool], maxTokens: 2048, signal })
    const calls = first.message.toolCalls || [], call = calls[0]
    if (calls.length !== 1 || call.name !== 'echo' || JSON.parse(call.args).text !== nonce) throw new Error('Modelo não produziu a chamada echo solicitada')
    messages.push(first.message, { role: 'tool', name: 'echo', toolCallId: call.id, content: nonce })
    const second = await invoke({ model, messages, tools: [tool], maxTokens: 2048, signal })
    if (second.message.toolCalls?.length || !second.message.content.includes(nonce)) throw new Error('Modelo não consumiu o resultado da ferramenta')
    result = { ok: true, requests: 2 }
  } catch (e) { result = { ok: false, error: e.message } }
  return writeEvidence('toolcheck', model, result)
}

export function evaluateCode(code, tests) {
  if (typeof code !== 'string' || code.length > 64000) return { ok: false, error: 'Código ausente ou grande demais' }
  // Processo descartável sem credenciais; a VM recebe somente código e intrínsecos.
  const runner = `import vm from 'node:vm';import fs from 'node:fs';const {code,tests}=JSON.parse(fs.readFileSync(0,'utf8'));try{const result=vm.runInNewContext('"use strict";\\n'+code+'\\n'+tests,Object.create(null),{timeout:500,contextCodeGeneration:{strings:false,wasm:false}});process.stdout.write(JSON.stringify({ok:result===true}));}catch(e){process.stdout.write(JSON.stringify({ok:false,error:String(e.message)}));}`
  const r = spawnSync(process.execPath, ['--max-old-space-size=48', '--input-type=module', '-e', runner], { input: JSON.stringify({ code, tests }), encoding: 'utf8', timeout: 2500, maxBuffer: 16000, env: { PATH: process.env.PATH || '' } })
  try { return JSON.parse(r.stdout) } catch { return { ok: false, error: r.error?.message || 'Avaliação interrompida' } }
}

export async function benchModel(model, { signal } = {}) {
  const results = []
  for (const task of BENCH_TASKS) {
    if (signal?.aborted) break
    try {
      const response = await invoke({ model, messages: [{ role: 'user', content: `${task.prompt}\nReturn only executable plain JavaScript, no imports, no Markdown, no I/O.` }], tools: [], maxTokens: 4096, signal })
      const code = response.message.content.trim().replace(/^```(?:javascript|js)?\s*\n/, '').replace(/\n```$/, '')
      results.push({ id: task.id, ...evaluateCode(code, task.tests) })
    } catch (e) { results.push({ id: task.id, ok: false, error: e.message }) }
  }
  return writeEvidence('bench', model, { version: 1, score: Math.round(results.filter((r) => r.ok).length / BENCH_TASKS.length * 100), results })
}
