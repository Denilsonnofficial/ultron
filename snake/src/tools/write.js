import fs from 'node:fs'
import path from 'node:path'
import { diffLines } from './diff.js'
import { countLines, displayPath, pick, resolvePath } from './util.js'

export default {
  name: 'write',
  label: 'Write',
  readOnly: false,
  description:
    'Create a new file or completely overwrite an existing one with the given content. Parent directories are created automatically. Prefer `edit` for changing parts of existing files.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (relative or absolute)' },
      content: { type: 'string', description: 'Full content of the file' },
    },
    required: ['path', 'content'],
  },
  summary(args, ctx) {
    const p = pick(args, 'path', 'file_path', 'filePath', 'file')
    return p ? displayPath(ctx.cwd, resolvePath(ctx.cwd, p)) : ''
  },
  async run(args, ctx) {
    const p = pick(args, 'path', 'file_path', 'filePath', 'file')
    let content = pick(args, 'content', 'text', 'contents')
    if (!p) return { output: 'Erro: parâmetro "path" é obrigatório.', isError: true }
    if (content === undefined) return { output: 'Erro: parâmetro "content" é obrigatório.', isError: true }
    if (typeof content !== 'string') content = JSON.stringify(content, null, 2)
    const abs = resolvePath(ctx.cwd, p)
    const rel = displayPath(ctx.cwd, abs)
    let old = null
    try {
      if (fs.statSync(abs).isDirectory()) return { output: `Erro: ${abs} é um diretório.`, isError: true }
      old = fs.readFileSync(abs, 'utf8')
    } catch {}
    ctx.checkpoint?.(abs, old)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
    ctx.markRead?.(abs, fs.statSync(abs).mtimeMs)
    const lines = countLines(content)
    if (old === null) {
      const preview = content.split('\n').slice(0, 400)
      return {
        output: `Arquivo criado: ${rel} (${lines} linhas).`,
        display: {
          summary: `Criou ${rel} (${lines} linha${lines === 1 ? '' : 's'})`,
          path: rel,
          diff: { added: lines, removed: 0, lines: preview.map((text, i) => ({ type: 'add', newNo: i + 1, text })), more: Math.max(0, lines - preview.length) },
        },
      }
    }
    const diff = diffLines(old, content, { maxLines: 400 })
    return {
      output: `Arquivo sobrescrito: ${rel} (${lines} linhas; +${diff.added} −${diff.removed}).`,
      display: { summary: `Sobrescreveu ${rel} (+${diff.added} −${diff.removed})`, diff, path: rel },
    }
  },
}
