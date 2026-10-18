import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { paths, VERSION } from './config.js'
import { PROVIDERS, resolveKey } from './providers/registry.js'

export async function diagnose({ network = true } = {}) {
  const rows = [{ name: 'Snake', status: 'ok', detail: VERSION }, { name: 'Node.js', status: Number(process.versions.node.split('.')[0]) >= 20 ? 'ok' : 'erro', detail: process.version }]
  for (const cmd of ['npm', 'git', 'rg', 'script']) {
    const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', timeout: 3000 })
    const hint = { rg: ' — busca usa o grep do sistema; instale ripgrep (apt/pkg install ripgrep) para buscas mais rápidas que respeitam .gitignore', script: ' — a ferramenta terminal (PTY) fica indisponível' }[cmd] || ''
    rows.push({ name: cmd, status: r.status === 0 ? 'ok' : 'aviso', detail: r.status === 0 ? (r.stdout || '').split('\n')[0] : 'não instalado' + hint })
  }
  try {
    fs.accessSync(paths.home, fs.constants.R_OK | fs.constants.W_OK)
    const stat = fs.statfsSync(paths.home)
    rows.push({ name: 'dados/disco', status: 'ok', detail: `${paths.home} · ${(stat.bavail * stat.bsize / 1024 ** 3).toFixed(1)} GiB livres` })
  } catch (e) { rows.push({ name: 'dados/disco', status: 'erro', detail: e.message }) }
  await Promise.all(Object.values(PROVIDERS).filter((p) => resolveKey(p.id)).map(async (p) => {
    let status = 'ok', detail = 'chave presente (não exibida)'
    if (network) {
      try {
        const r = await fetch(p.baseURL.replace(/\/$/, '') + '/models', { headers: p.kind === 'anthropic' ? { 'x-api-key': resolveKey(p.id).key, 'anthropic-version': '2023-06-01' } : { Authorization: `Bearer ${resolveKey(p.id).key}` }, signal: AbortSignal.timeout(5000) })
        status = r.ok ? 'ok' : 'aviso'; detail += ` · HTTP ${r.status}`
        await r.body?.cancel()
      } catch (e) { status = 'aviso'; detail += ` · ${e.message}` }
    }
    rows.push({ name: p.name, status, detail })
  }))
  return rows
}
