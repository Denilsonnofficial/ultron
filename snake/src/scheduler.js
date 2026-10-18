import fs from 'node:fs'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { paths, readJSON, writeJSON } from './config.js'

export const shellQuote = (s) => "'" + String(s).replaceAll("'", "'\\''") + "'"
export function validateCron(spec) {
  const fields = spec.trim().split(/\s+/)
  const bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]
  if (fields.length !== 5) throw new Error('Cron exige cinco campos: minuto hora dia mês dia-da-semana')
  fields.forEach((field, i) => {
    for (const item of field.split(',')) {
      const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(item)
      if (!match || (match[2] && Number(match[2]) < 1)) throw new Error(`Campo cron inválido: ${field}`)
      if (match[1] !== '*') {
        const numbers = match[1].split('-').map(Number)
        if (numbers.some((n) => n < bounds[i][0] || n > bounds[i][1]) || (numbers.length === 2 && numbers[0] > numbers[1])) throw new Error(`Campo cron fora do intervalo: ${field}`)
      }
    }
  })
  return fields.join(' ')
}
export function schedules() { return readJSON(paths.schedules, []) }
function cronWrite(items) {
  const r = spawnSync('crontab', ['-l'], { encoding: 'utf8' })
  if (r.error) throw new Error('crontab não instalado; instale cron para usar /schedule')
  if (r.status && !/no crontab|nenhum crontab/i.test(r.stderr || '')) throw new Error(r.stderr || 'Não foi possível consultar o crontab')
  const marker = '# snake:' + crypto.createHash('sha256').update(paths.home).digest('hex').slice(0, 12)
  const lines = (r.stdout || '').split('\n').filter((l) => !l.includes(marker)).filter(Boolean)
  const cli = fileURLToPath(new URL('../bin/snake.js', import.meta.url))
  for (const job of items) if (job.enabled !== false) lines.push(`${job.cron} SNAKE_HOME=${shellQuote(paths.home)} ${shellQuote(process.execPath)} ${shellQuote(cli)} schedule run ${shellQuote(job.id)} >> ${shellQuote(paths.log)} 2>&1 ${marker}`.replaceAll('%', '\\%'))
  const result = spawnSync('crontab', ['-'], { input: lines.join('\n') + '\n', encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || 'Falha ao gravar crontab')
}
export function addSchedule({ cron, prompt, cwd, model, permissionMode = 'dontAsk', maxSteps = 20 }) {
  cron = validateCron(cron)
  if (!prompt.trim()) throw new Error('Prompt vazio')
  const job = { id: crypto.randomUUID(), cron, prompt, cwd, model, permissionMode, maxSteps, created: Date.now(), enabled: true }
  const list = [...schedules(), job]
  cronWrite(list); writeJSON(paths.schedules, list, 0o600)
  return job
}
export function removeSchedule(id) {
  const all = schedules(), found = all.find((j) => j.id.startsWith(id))
  if (!found) throw new Error('Agendamento não encontrado')
  const next = all.filter((j) => j !== found)
  cronWrite(next); writeJSON(paths.schedules, next, 0o600)
}
export async function runSchedule(id, runner) {
  const job = schedules().find((j) => j.id === id && j.enabled !== false)
  if (!job) throw new Error('Agendamento não encontrado ou desativado')
  const lock = paths.schedules + '.' + job.id + '.lock'
  let fd
  try { fd = fs.openSync(lock, 'wx', 0o600) } catch { throw new Error('Agendamento já está executando (verifique o arquivo .lock se houve encerramento forçado)') }
  try {
    fs.writeSync(fd, String(process.pid))
    const result = await runner(job)
    const list = schedules(); const current = list.find((j) => j.id === id)
    if (current) { current.lastRun = Date.now(); current.exitCode = result; writeJSON(paths.schedules, list, 0o600) }
    return result
  } finally { fs.closeSync(fd); fs.rmSync(lock, { force: true }) }
}
