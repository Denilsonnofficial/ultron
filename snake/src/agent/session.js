// Sessões persistentes em ~/.snake/sessions (uma por arquivo + índice).

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { paths, readJSON, writeJSON } from '../config.js'
import { UsageTracker } from './usage.js'

const INDEX = () => path.join(paths.sessions, 'index.json')

export function newSessionId() {
  const d = new Date()
  const stamp = d.toISOString().slice(0, 19).replace(/[-:T]/g, '')
  return `ses_${stamp}_${crypto.randomBytes(3).toString('hex')}`
}

function titleFrom(text) {
  const t = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > 70 ? t.slice(0, 69) + '…' : t
}

export class Session {
  constructor(data = {}) {
    this.id = data.id || newSessionId()
    this.title = data.title || ''
    this.cwd = data.cwd || process.cwd()
    this.model = data.model || null
    this.created = data.created || Date.now()
    this.updated = data.updated || this.created
    this.messages = data.messages || []
    this.todos = data.todos || []
    this.usage = data.usage instanceof UsageTracker ? data.usage : new UsageTracker(data.usage)
    this.ephemeral = !!data.ephemeral
    for (const key of ['events', 'skills', 'goals', 'jobs', 'undoStack', 'redoStack', 'summaries', 'inbox']) this[key] = data[key] || []
    this.goal = data.goal || null
    this.plan = data.plan || null
    this.agent = data.agent || 'build'
    this.parentId = data.parentId || null
    this.compactCount = data.compactCount || 0
    if (!this.ephemeral) {
      try {
        this.inbox = fs.readFileSync(this.inboxFile(), 'utf8').trim().split('\n').filter(Boolean).map((s) => JSON.parse(s))
      } catch {}
    }
  }

  static create({ cwd, model, ephemeral = false }) {
    return new Session({ cwd, model, ephemeral })
  }

  static file(id) {
    if (!/^[a-zA-Z0-9_-]+$/.test(String(id))) throw new Error('ID de sessão inválido')
    return path.join(paths.sessions, `${id}.json`)
  }

  static load(id) {
    if (!/^[a-zA-Z0-9_-]+$/.test(String(id))) return null
    const data = readJSON(Session.file(id), null)
    if (!data) return null
    return new Session(data)
  }

  static list({ cwd = null, limit = 50 } = {}) {
    const index = readJSON(INDEX(), [])
    return index.filter((s) => !cwd || s.cwd === cwd).slice(0, limit)
  }

  static latest(cwd) {
    const [first] = Session.list({ cwd, limit: 1 })
    return first ? Session.load(first.id) : null
  }

  /** Encontra por id completo ou prefixo/sufixo. */
  static resolve(idOrPrefix) {
    if (!idOrPrefix) return null
    const direct = Session.load(idOrPrefix)
    if (direct) return direct
    const hit = Session.list({ limit: 1000 }).find((s) => s.id.startsWith(idOrPrefix) || s.id.endsWith(idOrPrefix))
    return hit ? Session.load(hit.id) : null
  }

  firstUserText() {
    const m = this.messages.find((x) => x.role === 'user' && !x.synthetic)
    return m ? m.content : ''
  }

  toJSON() {
    return {
      id: this.id,
      title: this.title,
      cwd: this.cwd,
      model: this.model,
      created: this.created,
      updated: this.updated,
      messages: this.messages,
      todos: this.todos,
      usage: this.usage.toJSON(),
      ...Object.fromEntries(['events', 'skills', 'goals', 'goal', 'plan', 'agent', 'parentId', 'jobs', 'undoStack', 'redoStack', 'summaries', 'compactCount', 'inbox'].map((key) => [key, this[key]])),
    }
  }

  save() {
    if (this.ephemeral) return
    if (!this.title) this.title = titleFrom(this.firstUserText()) || 'sessão sem título'
    this.updated = Date.now()
    writeJSON(Session.file(this.id), this.toJSON(), 0o600)
    const index = readJSON(INDEX(), []).filter((s) => s.id !== this.id)
    index.unshift({
      id: this.id,
      title: this.title,
      cwd: this.cwd,
      model: this.model,
      created: this.created,
      updated: this.updated,
      messages: this.messages.length,
      cost: this.usage.total.cost,
      tokens: this.usage.total.input + this.usage.total.output + this.usage.total.cacheRead + this.usage.total.cacheWrite,
    })
    index.sort((a, b) => b.updated - a.updated)
    writeJSON(INDEX(), index.slice(0, 500))
  }

  delete() {
    fs.rmSync(Session.file(this.id), { force: true })
    fs.rmSync(this.inboxFile(), { force: true })
    writeJSON(
      INDEX(),
      readJSON(INDEX(), []).filter((s) => s.id !== this.id),
    )
  }

  event(type, data = {}) {
    this.events.push({ type, at: Date.now(), ...data })
    if (this.events.length > 5000) this.events.splice(0, this.events.length - 5000)
  }

  inboxFile() { return Session.file(this.id).replace(/\.json$/, '.inbox.jsonl') }
  saveInbox() {
    if (this.ephemeral) return
    fs.mkdirSync(paths.sessions, { recursive: true })
    const tmp = this.inboxFile() + '.tmp'
    fs.writeFileSync(tmp, this.inbox.map((v) => JSON.stringify(v)).join('\n') + (this.inbox.length ? '\n' : ''), { mode: 0o600 })
    fs.renameSync(tmp, this.inboxFile())
    this.save()
  }
  enqueue(text) {
    const entry = { id: crypto.randomUUID(), text, at: Date.now(), status: 'queued' }
    this.inbox.push(entry)
    this.saveInbox()
    return entry
  }
  acknowledge(id) { this.inbox = this.inbox.filter((e) => e.id !== id); this.saveInbox() }
  fork() {
    const data = JSON.parse(JSON.stringify(this.toJSON()))
    const child = new Session({ ...data, id: newSessionId(), title: `Cópia · ${this.title}`, parentId: this.id, created: Date.now(), inbox: [], undoStack: [], redoStack: [], jobs: [] })
    child.event('fork', { source: this.id })
    child.save()
    return child
  }
  static import(data, cwd) {
    if (!data || !Array.isArray(data.messages) || data.messages.some((m) => !['user', 'assistant', 'tool'].includes(m.role))) throw new Error('Formato de sessão inválido')
    // Importações nunca ganham a capacidade de restaurar caminhos arbitrários.
    const session = new Session({ ...data, id: newSessionId(), cwd, undoStack: [], redoStack: [], inbox: [], jobs: [], ephemeral: false })
    session.event('import')
    session.save()
    return session
  }
}
