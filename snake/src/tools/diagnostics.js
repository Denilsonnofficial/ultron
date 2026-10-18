// Verificação de sintaxe logo depois de uma edição (como os diagnósticos de LSP do OpenCode, mas sem
// servidor): o erro volta no resultado da própria ferramenta e o modelo corrige na hora, em vez de
// descobrir muito depois que quebrou o arquivo. Só roda verificadores rápidos e já instalados.

import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const available = new Map()
function has(cmd) {
  if (!available.has(cmd)) available.set(cmd, spawnSync(cmd, ['--version'], { encoding: 'utf8', timeout: 3000 }).status === 0)
  return available.get(cmd)
}

function run(cmd, args, { timeout = 10000, input } = {}) {
  return new Promise((resolve) => {
    let child
    try { child = spawn(cmd, args, { stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] }) } catch { return resolve(null) }
    let out = ''
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, timeout)
    child.stdout.on('data', (d) => { if (out.length < 8000) out += d })
    child.stderr.on('data', (d) => { if (out.length < 8000) out += d })
    child.on('error', () => { clearTimeout(timer); resolve(null) })
    child.on('close', (code, signal) => { clearTimeout(timer); resolve(signal ? null : { code, out }) })
    if (input != null) child.stdin.end(input)
  })
}

const PY_CHECK = 'import ast,sys\nsrc=open(sys.argv[1],encoding="utf-8").read()\ntry:\n  ast.parse(src,sys.argv[1])\nexcept SyntaxError as e:\n  print(f"{e.filename}:{e.lineno}:{e.offset}: {e.msg}");sys.exit(1)'

/** Devolve uma mensagem curta de erro de sintaxe, ou '' se estiver tudo certo (ou não houver verificador). */
export async function checkSyntax(file) {
  const ext = path.extname(file).toLowerCase()
  let st
  try { st = fs.statSync(file) } catch { return '' }
  if (!st.isFile() || st.size > 2 * 1024 * 1024) return ''
  let r = null
  if (ext === '.json') {
    try { JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { return `JSON inválido: ${e.message}` }
    return ''
  }
  if (['.js', '.mjs', '.cjs'].includes(ext)) r = await run(process.execPath, ['--check', file])
  else if (ext === '.py' && has('python3')) r = await run('python3', ['-c', PY_CHECK, file])
  else if (['.sh', '.bash'].includes(ext)) r = await run('bash', ['-n', file])
  if (!r || r.code === 0) return ''
  const text = r.out.replace(/\n{2,}/g, '\n').trim().split('\n').slice(0, 8).join('\n')
  return text || 'erro de sintaxe'
}

/** Anexa o diagnóstico ao resultado da ferramenta (sem marcar como erro: a edição foi feita). */
export async function withDiagnostics(result, files) {
  const problems = []
  for (const f of files) {
    const msg = await checkSyntax(f)
    if (msg) problems.push(`${f}\n${msg}`)
  }
  if (!problems.length) return result
  result.output = `${result.output}\n\nATENÇÃO — a verificação de sintaxe após a edição encontrou problemas; corrija antes de continuar:\n${problems.join('\n\n')}`
  result.display = { ...(result.display || {}), diagnostics: problems }
  return result
}
