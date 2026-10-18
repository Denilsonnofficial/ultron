// Checkpoints para /undo e /redo.
//
// Dentro de um repositório git, o estado da árvore de trabalho é gravado num repositório git "sombra"
// em ~/.snake/snapshots/<projeto> (o índice e os commits do usuário nunca são tocados). Cada turno guarda
// só dois hashes de árvore e a lista de arquivos alterados, então a sessão continua pequena e nada roda
// de forma síncrona na interface. Fora de um repositório (ou para arquivos fora dele), valem os
// checkpoints das ferramentas de edição: o conteúdo anterior de cada arquivo que write/edit tocaram.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { paths } from '../config.js'

const GIT_TIMEOUT = 20000
const MAX_FILE_BYTES = 2 * 1024 * 1024

export function fileState(file) {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return undefined
    return { data: fs.readFileSync(file).toString('base64'), mode: stat.mode & 0o777 }
  } catch (e) { if (e.code === 'ENOENT') return null; throw e }
}
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** Executa git sem bloquear a interface; nunca lança erro, devolve { code, stdout, stderr }. */
export function runGit(args, { cwd, env = {}, timeout = GIT_TIMEOUT, input } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...env }, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    } catch (e) { return resolve({ code: -1, stdout: '', stderr: e.message }) }
    const out = [], err = []
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, timeout)
    child.stdout.on('data', (d) => out.push(d))
    child.stderr.on('data', (d) => err.push(d))
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout: '', stderr: e.message }) })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code: signal ? -1 : code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') + (signal ? `\n(git encerrado: ${signal})` : '') })
    })
    if (input != null) child.stdin.end(input)
  })
}

/** Raiz do repositório git que contém `cwd`, ou null (home e / nunca contam: são grandes demais). */
export async function gitRoot(cwd) {
  const r = await runGit(['rev-parse', '--show-toplevel'], { cwd, timeout: 5000 })
  if (r.code !== 0) return null
  const root = r.stdout.trim()
  if (!root || root === '/' || path.resolve(root) === path.resolve(os.homedir())) return null
  return root
}

export class ShadowRepo {
  constructor(root) {
    this.root = root
    this.gitDir = path.join(paths.home, 'snapshots', crypto.createHash('sha1').update(root).digest('hex').slice(0, 16))
    this.ready = null
  }

  git(args, opts = {}) {
    return runGit(args, { cwd: this.root, ...opts, env: { GIT_DIR: this.gitDir, GIT_WORK_TREE: this.root, ...(opts.env || {}) } })
  }

  init() {
    this.ready ||= (async () => {
      if (!fs.existsSync(path.join(this.gitDir, 'HEAD'))) {
        fs.mkdirSync(this.gitDir, { recursive: true })
        const r = await this.git(['init', '-q'])
        if (r.code !== 0) throw new Error(`git init: ${r.stderr.trim()}`)
        for (const [k, v] of [['core.autocrlf', 'false'], ['core.fsmonitor', 'false'], ['gc.auto', '0'], ['core.quotepath', 'false']]) await this.git(['config', k, v])
      }
      // A pasta .snake do projeto e o próprio .git nunca entram no snapshot.
      fs.mkdirSync(path.join(this.gitDir, 'info'), { recursive: true })
      const exclude = path.join(this.gitDir, 'info', 'exclude')
      if (!fs.existsSync(exclude)) fs.writeFileSync(exclude, '.snake/\n.git/\nnode_modules/\n')
    })()
    return this.ready
  }

  /** Arquivos novos grandes ficam de fora (o snapshot é para código, não para dados). */
  async excludeLarge() {
    const r = await this.git(['ls-files', '-z', '--others', '--exclude-standard'])
    if (r.code !== 0) return
    const big = []
    for (const rel of r.stdout.split('\0').filter(Boolean)) {
      try { if (fs.statSync(path.join(this.root, rel)).size > MAX_FILE_BYTES) big.push('/' + rel.replace(/([*?[\]!#\\])/g, '\\$1')) } catch {}
      if (big.length > 5000) break
    }
    if (big.length) fs.appendFileSync(path.join(this.gitDir, 'info', 'exclude'), big.join('\n') + '\n')
  }

  /** Grava o estado atual da árvore e devolve o hash (ou lança erro). */
  async track() {
    await this.init()
    await this.excludeLarge()
    const add = await this.git(['add', '-A', '--', '.'])
    if (add.code !== 0) throw new Error(`git add: ${add.stderr.trim().split('\n').pop() || 'falhou'}`)
    const tree = await this.git(['write-tree'])
    if (tree.code !== 0) throw new Error(`git write-tree: ${tree.stderr.trim()}`)
    return tree.stdout.trim()
  }

  async changes(before, after) {
    if (before === after) return []
    const r = await this.git(['diff', '--no-renames', '--name-status', '-z', before, after])
    if (r.code !== 0) throw new Error(`git diff: ${r.stderr.trim()}`)
    const parts = r.stdout.split('\0').filter(Boolean)
    const files = []
    for (let i = 0; i + 1 < parts.length; i += 2) files.push({ status: parts[i][0], path: path.join(this.root, parts[i + 1]) })
    return files
  }

  async blobOf(tree, abs) {
    const rel = path.relative(this.root, abs)
    const r = await this.git(['ls-tree', tree, '--', rel])
    const m = /^\d+ blob ([0-9a-f]+)\t/.exec(r.stdout)
    return m ? m[1] : null
  }

  async hashFile(abs) {
    if (!fs.existsSync(abs)) return null
    const r = await this.git(['hash-object', '--', path.relative(this.root, abs)])
    return r.code === 0 ? r.stdout.trim() : undefined
  }

  /** Coloca `abs` no estado que tinha em `tree` (removendo se não existia). */
  async restore(tree, abs) {
    const rel = path.relative(this.root, abs)
    if (await this.blobOf(tree, abs)) {
      const r = await this.git(['checkout', tree, '--', rel])
      if (r.code !== 0) throw new Error(`git checkout ${rel}: ${r.stderr.trim()}`)
    } else fs.rmSync(abs, { force: true })
  }
}

const repos = new Map()
function repoFor(root) {
  if (!repos.has(root)) repos.set(root, new ShadowRepo(root))
  return repos.get(root)
}

/** Início do turno: grava o estado da árvore (só em repositórios git). */
export async function beginSnapshot(cwd) {
  const root = await gitRoot(cwd)
  if (!root) return { root: null, tree: null, cwd }
  const repo = repoFor(root)
  try { return { root, tree: await repo.track(), cwd } }
  catch (e) { return { root, tree: null, cwd, error: e.message } }
}

/** Fim do turno: registra o que mudou (árvore git + checkpoints das ferramentas) na pilha de undo. */
export async function finishSnapshot(session, before, checkpoint) {
  const entry = { id: crypto.randomUUID(), at: Date.now(), files: [] }
  const covered = new Set()
  if (before?.root && before.tree) {
    const repo = repoFor(before.root)
    const after = await repo.track()
    const changed = await repo.changes(before.tree, after)
    if (changed.length) {
      entry.git = { root: before.root, before: before.tree, after, files: changed.map((f) => f.path) }
      for (const f of changed) covered.add(f.path)
    }
  }
  for (const [file, original] of checkpoint) {
    if (covered.has(file)) continue
    const prev = original === null ? null : { data: Buffer.from(original).toString('base64'), mode: fileState(file)?.mode || 0o644 }
    const next = fileState(file)
    if (next !== undefined && !equal(prev, next)) entry.files.push({ path: file, before: prev, after: next })
  }
  const changes = [...(entry.git?.files || []), ...entry.files.map((f) => f.path)]
  if (changes.length) {
    session.undoStack.push(entry)
    session.undoStack = session.undoStack.slice(-30)
    session.redoStack = []
  }
  return changes
}

/** Desfaz (ou refaz) os `count` turnos mais recentes. */
export async function restoreSnapshots(session, count = 1, redo = false) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('Informe uma quantidade positiva de turnos')
  const from = redo ? session.redoStack : session.undoStack, to = redo ? session.undoStack : session.redoStack
  const selected = from.slice(-count).reverse()
  if (!selected.length) return null
  // Confere antes de mexer em qualquer coisa: arquivos alterados fora do snapshot não são sobrescritos.
  // Cada arquivo é comparado com o estado do primeiro turno (o mais próximo do presente) que o tocou.
  const checked = new Set()
  for (const snap of selected) {
    if (snap.git) {
      const repo = repoFor(snap.git.root)
      const expectedTree = redo ? snap.git.before : snap.git.after
      for (const file of snap.git.files) {
        if (checked.has(file)) continue
        checked.add(file)
        const want = await repo.blobOf(expectedTree, file)
        const have = await repo.hashFile(file)
        if (have !== undefined && want !== have) throw new Error(`Arquivo mudou fora do checkpoint: ${file}. Preserve suas alterações antes de desfazer/refazer.`)
      }
    }
    for (const f of snap.files || []) {
      if (checked.has(f.path)) continue
      checked.add(f.path)
      if (!equal(fileState(f.path), redo ? f.before : f.after)) throw new Error(`Arquivo mudou fora do checkpoint: ${f.path}. Preserve suas alterações antes de desfazer/refazer.`)
    }
  }
  const restored = []
  for (const snap of selected) {
    if (snap.git) {
      const repo = repoFor(snap.git.root)
      const tree = redo ? snap.git.after : snap.git.before
      for (const file of snap.git.files) {
        await repo.restore(tree, file)
        restored.push({ path: file, deleted: !fs.existsSync(file) })
      }
    }
    for (const f of snap.files || []) {
      writeState(f.path, redo ? f.after : f.before)
      restored.push({ path: f.path, deleted: (redo ? f.after : f.before) === null })
    }
  }
  for (const snap of selected) { from.pop(); to.push(snap) }
  session.event(redo ? 'redo' : 'undo', { turns: selected.length, files: restored.map((r) => r.path) })
  session.save()
  return restored.length ? restored : null
}

function writeState(file, state) {
  if (state === null) fs.rmSync(file, { force: true })
  else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(state.data, 'base64')); fs.chmodSync(file, state.mode) }
}
