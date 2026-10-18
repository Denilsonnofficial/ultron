import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { resolvePath } from './util.js'

export class LspClient {
  constructor(cwd, config) { this.cwd = cwd; this.config = config; this.pending = new Map(); this.documents = new Map(); this.id = 0; this.buffer = Buffer.alloc(0) }
  async start() {
    this.child = spawn(this.config.command, this.config.args || [], { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...(this.config.env || {}) } })
    this.child.stdout.on('data', (chunk) => { this.buffer = Buffer.concat([this.buffer, chunk]); this.parse() })
    this.child.stderr.on('data', () => {})
    this.child.stdin.on('error', () => {})
    this.child.on('error', (e) => this.fail(e)); this.child.on('close', () => this.fail(new Error('LSP encerrou')))
    const init = await this.request('initialize', { processId: process.pid, rootUri: pathToFileURL(this.cwd).href, workspaceFolders: [{ uri: pathToFileURL(this.cwd).href, name: path.basename(this.cwd) }], capabilities: { general: { positionEncodings: ['utf-16'] }, textDocument: { synchronization: { didSave: true } } } })
    this.capabilities = init.capabilities || {}; this.notify('initialized', {})
    return this
  }
  parse() {
    for (;;) {
      const boundary = this.buffer.indexOf('\r\n\r\n'); if (boundary < 0) return
      const length = Number(/Content-Length:\s*(\d+)/i.exec(this.buffer.subarray(0, boundary).toString())?.[1])
      if (!Number.isFinite(length) || length > 8 * 1024 * 1024) { this.close(); return }
      if (this.buffer.length < boundary + 4 + length) return
      const chunk = this.buffer.subarray(boundary + 4, boundary + 4 + length); this.buffer = this.buffer.subarray(boundary + 4 + length)
      let msg; try { msg = JSON.parse(chunk) } catch { continue }
      if (msg.method && msg.id != null) {
        const result = msg.method === 'workspace/configuration' ? (msg.params?.items || []).map(() => ({})) : null
        this.send({ jsonrpc: '2.0', id: msg.id, result }); continue
      }
      const pending = this.pending.get(msg.id)
      if (pending) { pending.finish(); msg.error ? pending.reject(new Error(msg.error.message)) : pending.resolve(msg.result) }
    }
  }
  send(msg) { const body = Buffer.from(JSON.stringify(msg)); this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`); this.child.stdin.write(body) }
  notify(method, params) { this.send({ jsonrpc: '2.0', method, params }) }
  request(method, params, signal) {
    if (signal?.aborted) return Promise.reject(new DOMException('Interrompido', 'AbortError'))
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending.delete(id) }
      const abort = () => { this.notify('$/cancelRequest', { id }); finish(); reject(new DOMException('Interrompido', 'AbortError')) }
      const timer = setTimeout(() => { finish(); reject(new Error(`LSP: tempo esgotado em ${method}`)) }, 10000)
      signal?.addEventListener('abort', abort, { once: true }); this.pending.set(id, { resolve, reject, finish })
      try { this.send({ jsonrpc: '2.0', id, method, params }) } catch (e) { finish(); reject(e) }
    })
  }
  document(file) {
    const uri = pathToFileURL(file).href, text = fs.readFileSync(file, 'utf8'), old = this.documents.get(uri)
    const version = (old?.version || 0) + 1
    if (!old) this.notify('textDocument/didOpen', { textDocument: { uri, languageId: this.config.languageId || ({ '.ts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript', '.py': 'python', '.go': 'go', '.rs': 'rust' }[path.extname(file)] || 'plaintext'), version, text } })
    else if (text !== old.text) this.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] })
    this.documents.set(uri, { text, version }); return uri
  }
  fail(error) { for (const pending of [...this.pending.values()]) { pending.finish(); pending.reject(error) } }
  close() { this.fail(new Error('LSP desconectado')); this.child?.kill() }
}

export class LspManager {
  constructor(cwd, configs = {}) {
    this.cwd = cwd; this.configs = { ...configs }; this.clients = new Map()
    if (process.env.SNAKE_LSP === '1' && !Object.keys(configs).length && spawnSync('typescript-language-server', ['--version'], { encoding: 'utf8' }).status === 0) {
      this.configs.typescript = { command: 'typescript-language-server', args: ['--stdio'], extensions: ['.ts', '.tsx', '.js', '.jsx'] }
    }
  }
  async client(file) {
    const pair = Object.entries(this.configs).find(([, c]) => c.extensions?.includes(path.extname(file)))
    if (!pair) throw new Error(`Nenhum servidor LSP configurado para ${path.extname(file)}`)
    const [name, config] = pair
    if (!this.clients.has(name)) { const client = new LspClient(this.cwd, config); this.clients.set(name, client.start().catch((e) => { this.clients.delete(name); client.close(); throw e })) }
    return this.clients.get(name)
  }
  tools() {
    if (!Object.keys(this.configs).length) return []
    return ['definition', 'references', 'hover', 'symbols'].map((action) => ({
      name: `lsp-${action}`, label: `LSP ${action}`, readOnly: true,
      description: `Language server ${action}. Supply path, 1-based line and column. Symbols uses document symbols unless query is provided (workspace search).`,
      parameters: { type: 'object', properties: { path: { type: 'string' }, line: { type: 'integer', minimum: 1 }, column: { type: 'integer', minimum: 1 }, query: { type: 'string' } }, required: ['path'] },
      summary: (a) => `${a.path}:${a.line || 1}:${a.column || 1}`,
      run: async (args, ctx) => {
        const file = resolvePath(ctx.cwd, args.path), client = await this.client(file), uri = client.document(file)
        const params = { textDocument: { uri }, position: { line: Math.max(0, (args.line || 1) - 1), character: Math.max(0, (args.column || 1) - 1) }, ...(action === 'references' ? { context: { includeDeclaration: true } } : {}) }
        const method = action === 'symbols' ? args.query ? 'workspace/symbol' : 'textDocument/documentSymbol' : `textDocument/${action}`
        const result = await client.request(method, action === 'symbols' && args.query ? { query: args.query } : params, ctx.signal)
        return { output: JSON.stringify(result || [], null, 2) }
      },
    }))
  }
  close() { for (const promise of this.clients.values()) promise.then((c) => c.close()).catch(() => {}); this.clients.clear() }
}
