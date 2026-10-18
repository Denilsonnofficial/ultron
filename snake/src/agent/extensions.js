import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { paths } from '../config.js'
import { globToRegExp } from '../tools/util.js'

export function runLocalCommand(command, { cwd, data = {}, argument = '', timeout = 10000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', command, 'snake-hook', argument || JSON.stringify(data)], { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', settled = false
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }
    const finish = (error) => {
      if (settled) return
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort)
      error ? reject(error) : resolve(output)
    }
    const abort = () => { kill(); finish(new Error('Comando interrompido')) }
    const timer = setTimeout(() => { kill(); finish(new Error('Tempo limite do comando local')) }, timeout)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    child.stdout.on('data', (d) => { output = (output + d).slice(-64000) })
    child.stderr.on('data', (d) => { output = (output + d).slice(-64000) })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(data))
    child.on('error', finish)
    child.on('close', (code) => finish(code === 0 ? null : new Error(`Comando saiu com ${code}: ${output.slice(-2000)}`)))
  })
}

export class Extensions {
  constructor(cwd, config) { this.cwd = cwd; this.config = config; this.tools = []; this.commands = []; this.plugins = []; this.errors = [] }
  async load() {
    for (const dir of [path.join(paths.home, 'plugins'), path.join(this.cwd, '.snake/plugins')]) {
      let files = []; try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort() } catch {}
      for (const file of files) {
        try {
          const mod = await import(pathToFileURL(path.join(dir, file)).href)
          const plugin = mod.default || mod
          if (!plugin.name) throw new Error('Plugin sem name')
          const tools = plugin.tools || [], commands = plugin.commands || []
          if (tools.some((t) => !t.name || !t.parameters || typeof t.run !== 'function') || commands.some((c) => !c.name || typeof c.run !== 'function')) throw new Error('Ferramenta ou comando inválido')
          this.plugins.push(plugin)
          this.tools.push(...tools.map((t) => ({ label: t.name, readOnly: false, ...t })))
          this.commands.push(...commands)
        } catch (e) { this.errors.push(`${file}: ${e.message}`) }
      }
    }
    return this
  }
  async event(name, data, signal) {
    const failures = []
    for (const hook of [this.config.hooks?.[name] || []].flat()) {
      try { await runLocalCommand(typeof hook === 'string' ? hook : hook.command, { cwd: this.cwd, data, timeout: hook.timeout || 10000, signal }) }
      catch (e) { failures.push(`Hook ${name}: ${e.message}`) }
    }
    for (const plugin of this.plugins) {
      try { await plugin.events?.[name]?.(data) } catch (e) { failures.push(`Plugin ${plugin.name}: ${e.message}`) }
    }
    return failures
  }
  async format(file, signal) {
    for (const [pattern, command] of Object.entries(this.config.formatters || {})) {
      const regex = globToRegExp(pattern)
      if (regex.test(path.basename(file)) || regex.test(path.relative(this.cwd, file))) await runLocalCommand(`${command} "$1"`, { cwd: this.cwd, argument: file, signal, timeout: 30000 })
    }
  }
}
