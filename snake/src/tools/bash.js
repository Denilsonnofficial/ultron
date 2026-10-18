// Ferramenta de shell: comandos em primeiro plano (com cwd persistente) e processos em segundo plano.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { paths } from '../config.js'
import { stripAnsi } from '../ui/ansi.js'
import { pick, resolvePath, truncateMiddle } from './util.js'

const MAX_OUTPUT = 30000
// Guardado em memória por comando; o corte final para o modelo é feito por tools/output.js (com arquivo).
const MAX_KEEP = 2_000_000
const WRAPPER = 'eval "$SNAKE_CMD" 3>&-\n__snake_ec=$?\npwd >&3 2>/dev/null\nexit $__snake_ec'

export const backgroundJobs = new Map()
let bgCounter = 0

function shellEnv(extra = {}) {
  const env = { ...process.env, SNAKE: '1', PAGER: 'cat', GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', DEBIAN_FRONTEND: 'noninteractive', NO_COLOR: '1', ...extra }
  delete env.FORCE_COLOR
  return env
}

function killTree(child, signal = 'SIGTERM') {
  if (!child?.pid) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {}
  }
}

/** Remove ANSI e resolve \r (barras de progresso) mantendo só o último estado de cada linha. */
export function cleanOutput(text) {
  return stripAnsi(text)
    .split('\n')
    .map((line) => {
      const l = line.endsWith('\r') ? line.slice(0, -1) : line
      const i = l.lastIndexOf('\r')
      return i === -1 ? l : l.slice(i + 1)
    })
    .join('\n')
}

function runForeground(command, ctx, timeout, workdir) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('bash', ['-c', WRAPPER], {
        cwd: workdir || ctx.cwd,
        detached: true,
        env: shellEnv({ SNAKE_CMD: command }),
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      })
    } catch (e) {
      resolve({ output: `Erro ao iniciar bash: ${e.message}`, isError: true })
      return
    }
    let out = ''
    let cwdOut = ''
    let timedOut = false
    const started = Date.now()
    const onData = (d) => {
      const s = d.toString('utf8')
      out += s
      if (out.length > MAX_KEEP * 2) out = out.slice(0, MAX_KEEP / 2) + '\n… [saída intermediária descartada: comando produziu mais de 4 MB] …\n' + out.slice(-MAX_KEEP / 2)
      ctx.onProgress?.(s)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.stdio[3]?.on('data', (d) => (cwdOut += d.toString('utf8')))
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child, 'SIGTERM')
      setTimeout(() => killTree(child, 'SIGKILL'), 2000).unref()
    }, timeout)
    const onAbort = () => {
      killTree(child, 'SIGTERM')
      setTimeout(() => killTree(child, 'SIGKILL'), 1000).unref()
    }
    ctx.signal?.addEventListener('abort', onAbort, { once: true })
    let finished = false
    let exitTimer = null
    child.on('error', (e) => {
      finished = true
      clearTimeout(timer)
      resolve({ output: `Erro ao executar: ${e.message}`, isError: true })
    })
    // Um daemon iniciado pelo comando (setsid/nohup) pode segurar as pontas dos pipes para sempre e o 'close' nunca
    // chega: o turno ficava aberto. Por isso encerramos no 'exit', com um prazo curto para drenar o que já foi escrito.
    child.on('exit', (code, sig) => {
      exitTimer = setTimeout(() => finish(code, sig), 500)
    })
    child.on('close', (code, sig) => finish(code, sig))
    const finish = (code, sig) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      clearTimeout(exitTimer)
      for (const stream of [child.stdout, child.stderr, child.stdio[3]]) stream?.destroy()
      ctx.signal?.removeEventListener('abort', onAbort)
      const newCwd = cwdOut.trim().split('\n').pop()
      // com workdir explícito o cd do comando não muda o diretório da sessão
      if (!workdir && newCwd && newCwd !== ctx.cwd && fs.existsSync(newCwd)) ctx.setCwd?.(newCwd)
      const text = cleanOutput(out).trimEnd()
      let status = ''
      if (timedOut) status = `[tempo esgotado após ${Math.round(timeout / 1000)}s — processo encerrado. Para servidores, watchers ou builds longos use background: true]`
      else if (ctx.signal?.aborted) status = '[interrompido pelo usuário]'
      else if (code !== 0) status = `[código de saída: ${code ?? sig}]`
      const output = [text, status].filter(Boolean).join('\n') || '(sem saída)'
      const lines = text ? text.split('\n').length : 0
      resolve({
        output,
        isError: timedOut || !!ctx.signal?.aborted || code !== 0,
        exitCode: code,
        display: {
          summary: timedOut ? 'tempo esgotado' : code === 0 ? (lines ? `${lines} linha${lines === 1 ? '' : 's'} de saída` : 'sem saída') : `saiu com código ${code ?? sig}`,
          output: text,
          failed: code !== 0 || timedOut,
          elapsedMs: Date.now() - started,
        },
      })
    }
  })
}

function startBackground(command, ctx, workdir) {
  fs.mkdirSync(paths.tmp, { recursive: true })
  const id = `bg${++bgCounter}`
  const logFile = path.join(paths.tmp, `${process.pid}-${id}.log`)
  const fd = fs.openSync(logFile, 'a')
  let child
  try {
    child = spawn('bash', ['-c', command], { cwd: workdir || ctx.cwd, detached: true, stdio: ['ignore', fd, fd], env: shellEnv() })
  } catch (e) {
    fs.closeSync(fd)
    return { output: `Erro ao iniciar: ${e.message}`, isError: true }
  }
  fs.closeSync(fd)
  const job = { id, pid: child.pid, command, logFile, cwd: workdir || ctx.cwd, exitCode: null, startedAt: Date.now(), offset: 0, child, killed: false }
  child.on('exit', (code, sig) => {
    job.exitCode = code ?? sig
    // Avisa o agente quando o processo termina sozinho, para ele não precisar ficar consultando com sleep.
    if (!job.killed && ctx.notify) {
      let tail = ''
      try { tail = cleanOutput(fs.readFileSync(logFile, 'utf8')).trimEnd().split('\n').slice(-30).join('\n') } catch {}
      const secs = Math.round((Date.now() - job.startedAt) / 1000)
      ctx.notify(`[aviso automático do harness] O processo em segundo plano ${id} terminou com código ${job.exitCode} após ${secs}s.\nComando: ${command}\n${tail ? `Últimas linhas da saída:\n${tail}` : '(sem saída)'}\nUse bash_output com id="${id}" para ler a saída completa.`)
    }
  })
  child.unref()
  backgroundJobs.set(id, job)
  return {
    output: `Processo iniciado em segundo plano: id=${id}, pid=${child.pid}. Você será avisado automaticamente quando ele terminar — não fique consultando em loop. bash_output com id="${id}" lê a saída atual (kill: true encerra).`,
    display: { summary: `segundo plano · ${id} (pid ${child.pid})` },
  }
}

export function killAllBackground() {
  for (const job of backgroundJobs.values()) if (job.exitCode === null) { job.killed = true; killTree(job.child, 'SIGTERM') }
}

export const bash = {
  name: 'bash',
  label: 'Bash',
  readOnly: false,
  description:
    'Run a shell command with bash. The working directory persists between calls (cd works), or pass workdir to run elsewhere without changing it. Commands are non-interactive (stdin is closed): pass flags like -y/--yes and never open editors or pagers. Default timeout 120s (max 600000 ms). Large output is truncated (start and end kept) and the full output is saved to a file whose path is shown. For long-running processes (dev servers, watchers, long builds) set background: true: it returns immediately and you are notified automatically when it ends — do not poll with sleep. Quote paths with spaces. Prefer the dedicated read/edit/glob/grep tools over cat/sed/find/grep.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command to run' },
      workdir: { type: 'string', description: 'Directory to run the command in (default: current working directory)' },
      timeout: { type: 'integer', description: 'Timeout in milliseconds (max 600000)' },
      background: { type: 'boolean', description: 'Run in background and return immediately' },
      description: { type: 'string', description: 'Short description of what the command does (5-10 words)' },
    },
    required: ['command'],
  },
  summary(args) {
    return String(pick(args, 'command', 'cmd', 'script') || '')
  },
  async run(args, ctx) {
    const command = pick(args, 'command', 'cmd', 'script')
    if (!command || !String(command).trim()) return { output: 'Erro: parâmetro "command" é obrigatório.', isError: true }
    let workdir = pick(args, 'workdir', 'cwd', 'dir')
    if (workdir) {
      workdir = resolvePath(ctx.cwd, workdir)
      try { if (!fs.statSync(workdir).isDirectory()) throw new Error() } catch { return { output: `Erro: workdir não é um diretório: ${workdir}`, isError: true } }
    }
    if (pick(args, 'background', 'run_in_background')) return startBackground(String(command), ctx, workdir)
    const requested = Number(pick(args, 'timeout', 'timeout_ms'))
    const timeout = requested === 0 ? 600000 : Math.min(600000, Math.max(1000, requested || ctx.config?.bashTimeoutMs || 120000))
    return runForeground(String(command), ctx, timeout, workdir)
  },
}

export const bashOutput = {
  name: 'bash_output',
  label: 'BashOutput',
  readOnly: true,
  description:
    'Read new output from a background process started with bash(background: true). Pass kill: true to terminate it. Without an id, lists background processes.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Background process id (e.g. "bg1")' },
      kill: { type: 'boolean', description: 'Terminate the process' },
    },
  },
  summary(args) {
    return `${args?.id || 'lista'}${args?.kill ? ' (encerrar)' : ''}`
  },
  async run(args) {
    if (!args?.id) {
      if (!backgroundJobs.size) return { output: 'Nenhum processo em segundo plano.', display: { summary: 'nenhum processo' } }
      const list = [...backgroundJobs.values()].map((j) => `${j.id}\tpid ${j.pid}\t${j.exitCode === null ? 'rodando' : `encerrado (${j.exitCode})`}\t${j.command}`)
      return { output: list.join('\n'), display: { summary: `${backgroundJobs.size} processo(s)` } }
    }
    const job = backgroundJobs.get(String(args.id))
    if (!job) return { output: `Erro: processo ${args.id} não encontrado.`, isError: true }
    if (args.kill && job.exitCode === null) {
      job.killed = true
      killTree(job.child, 'SIGTERM')
      await new Promise((r) => setTimeout(r, 300))
      if (job.exitCode === null) killTree(job.child, 'SIGKILL')
    }
    let text = ''
    try {
      const fd = fs.openSync(job.logFile, 'r')
      const size = fs.fstatSync(fd).size
      if (size > job.offset) {
        const buf = Buffer.alloc(size - job.offset)
        fs.readSync(fd, buf, 0, buf.length, job.offset)
        text = buf.toString('utf8')
        job.offset = size
      }
      fs.closeSync(fd)
    } catch {}
    text = cleanOutput(text)
    if (text.length > MAX_OUTPUT) text = '…\n' + text.slice(-MAX_OUTPUT)
    const status = job.exitCode === null ? (args.kill ? 'encerrando' : 'rodando') : `encerrado (código ${job.exitCode})`
    return {
      output: `[${job.id} · pid ${job.pid} · ${status}]\n${text.trimEnd() || '(sem saída nova)'}`,
      display: { summary: `${job.id}: ${status}`, output: text.trimEnd() },
    }
  },
}
