import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { paths } from '../config.js'
import { cleanOutput } from './bash.js'

// util-linux script aloca um PTY real; não exige módulo nativo do npm.
export class TerminalManager {
  constructor(session, onData = () => {}) { this.session = session; this.jobs = new Map(); this.onData = onData }
  has(id) { return this.jobs.has(id) }
  open(command = 'bash --noprofile --norc -i') {
    if (spawnSync('script', ['--version'], { encoding: 'utf8' }).status !== 0) throw new Error('Terminal exige util-linux (comando script). Use bash background como alternativa.')
    const id = 'pty-' + crypto.randomBytes(4).toString('hex')
    fs.mkdirSync(paths.tmp, { recursive: true })
    const logFile = path.join(paths.tmp, `${this.session.id}-${id}.log`)
    const child = spawn('script', ['-qefc', command, '/dev/null'], { cwd: this.session.cwd, env: { ...process.env, TERM: 'xterm-256color', PS1: 'snake$ ', SNAKE: '1' }, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    const job = { id, child, output: '', offset: 0, status: 'running', logFile, started: Date.now() }
    const record = { id, type: 'terminal', status: 'running', prompt: command, created: Date.now(), pid: child.pid, logFile }
    this.jobs.set(id, job); this.session.jobs.push(record); this.session.save()
    const data = (chunk) => {
      const text = chunk.toString('utf8'); job.output = (job.output + text).slice(-64000)
      try { fs.appendFileSync(logFile, text, { mode: 0o600 }) } catch {}
      this.onData(job, text)
    }
    child.stdout.on('data', data); child.stderr.on('data', data)
    child.stdin.on('error', () => {})
    child.on('error', (e) => { job.status = 'failed'; record.status = 'failed'; data(Buffer.from(e.message)); this.session.save() })
    child.on('close', (code) => { job.status = 'done'; record.status = 'done'; record.exitCode = code; this.session.save(); this.onData(job, '') })
    return job
  }
  write(id, input) { const job = this.jobs.get(id); if (!job || job.status !== 'running') throw new Error('Terminal não está rodando'); job.child.stdin.write(input); return job }
  stop(id) {
    const job = this.jobs.get(id); if (!job) throw new Error('Terminal não encontrado')
    try { process.kill(-job.child.pid, 'SIGTERM') } catch {}
    const timer = setTimeout(() => { try { process.kill(-job.child.pid, 'SIGKILL') } catch {} }, 800); timer.unref()
  }
  closeAll() { for (const id of this.jobs.keys()) this.stop(id) }
  tools() {
    return [{ name: 'terminal', label: 'Terminal', readOnly: false,
      description: 'Persistent PTY shell. open creates a shell, write sends input (include newline to execute), read fetches output, close stops it. Environment and working directory remain in the shell. Use input "\\u0003" to interrupt. Do not send secrets.',
      parameters: { type: 'object', properties: { action: { type: 'string', enum: ['open', 'write', 'read', 'close'] }, id: { type: 'string' }, command: { type: 'string' }, input: { type: 'string' }, waitMs: { type: 'integer' } }, required: ['action'] },
      summary: (a) => `${a.action} ${a.id || a.command || ''}`,
      run: async (args, ctx) => {
        let job = this.jobs.get(args.id)
        if (args.action === 'open') job = this.open(args.command)
        else if (!job) return { output: 'Terminal não encontrado.', isError: true }
        if (args.action === 'write') this.write(job.id, args.input || '')
        if (args.action === 'close') this.stop(job.id)
        const delay = Math.max(0, Math.min(2000, args.waitMs ?? 150))
        await new Promise((r) => setTimeout(r, delay))
        if (ctx.signal?.aborted && job.status === 'running') this.write(job.id, '\x03')
        return { output: `[${job.id} · ${job.status}]\n${cleanOutput(job.output).slice(-16000)}`, display: { summary: `${job.id} · ${job.status}`, output: cleanOutput(job.output) } }
      },
    }]
  }
}
