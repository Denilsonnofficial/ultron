// Ferramentas de web: webfetch (baixa uma URL como texto/markdown) e websearch (DuckDuckGo).

import { VERSION } from '../config.js'
import { pick } from './util.js'

const UA = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 snake-harness/${VERSION}`

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', middot: '·' }

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

/** Converte HTML em markdown simplificado. */
export function htmlToMarkdown(html) {
  let s = html
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  s = s.replace(/<(script|style|noscript|svg|iframe|template|head|nav|footer|form)[\s\S]*?<\/\1>/gi, '')
  s = s.replace(/<pre(?:\s[^>]*)?>([\s\S]*?)<\/pre>/gi, (_, c) => '\n```\n' + decodeEntities(c.replace(/<[^>]+>/g, '')) + '\n```\n')
  s = s.replace(/<h([1-6])(?:\s[^>]*)?>([\s\S]*?)<\/h\1>/gi, (_, n, c) => `\n\n${'#'.repeat(Number(n))} ${c.replace(/<[^>]+>/g, '').trim()}\n\n`)
  s = s.replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, c) => {
    const text = c.replace(/<[^>]+>/g, '').trim()
    return text ? `[${text}](${href})` : ''
  })
  s = s.replace(/<code(?:\s[^>]*)?>([\s\S]*?)<\/code>/gi, (_, c) => '`' + c.replace(/<[^>]+>/g, '') + '`')
  s = s.replace(/<(strong|b)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi, '**$2**')
  s = s.replace(/<(em|i)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi, '*$2*')
  s = s.replace(/<li(?:\s[^>]*)?>/gi, '\n- ')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<\/(p|div|section|article|ul|ol|table|tr|blockquote|header|main)>/gi, '\n\n')
  s = s.replace(/<(td|th)(?:\s[^>]*)?>/gi, ' | ')
  s = s.replace(/<[^>]+>/g, '')
  s = decodeEntities(s)
  s = s
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
  return s.replace(/\n{3,}/g, '\n\n').trim()
}

const MAX_DOWNLOAD = 5 * 1024 * 1024

/** Lê o corpo em fluxo e para em `max` bytes (uma página gigante não trava a ferramenta nem a memória). */
async function readBody(res, max = MAX_DOWNLOAD) {
  if (!res.body) return { text: await res.text(), cut: false }
  const reader = res.body.getReader()
  const chunks = []
  let size = 0
  let cut = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > max) {
      chunks.push(value.subarray(0, value.length - (size - max)))
      cut = true
      try { await reader.cancel() } catch {}
      break
    }
    chunks.push(value)
  }
  return { text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'), cut }
}

export const webfetch = {
  name: 'webfetch',
  label: 'WebFetch',
  readOnly: true,
  description: 'Fetch a URL and return its content. HTML is converted to markdown by default (format: "markdown" | "text" | "html"). Downloads are capped at 5 MB and long content is truncated. Useful for documentation, issues, changelogs and JSON APIs.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Full URL (http/https)' },
      format: { type: 'string', enum: ['markdown', 'text', 'html'], description: 'Output format for HTML pages (default markdown)' },
      timeout: { type: 'integer', description: 'Timeout in seconds (default 30, max 120)' },
      max_chars: { type: 'integer', description: 'Maximum characters to return (default 40000)' },
    },
    required: ['url'],
  },
  summary(args) {
    return String(pick(args, 'url', 'link') || '')
  },
  async run(args, ctx) {
    let url = String(pick(args, 'url', 'link') || '').trim()
    if (!url) return { output: 'Erro: parâmetro "url" é obrigatório.', isError: true }
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url
    const max = Math.min(200000, Number(pick(args, 'max_chars', 'limit')) || 40000)
    const format = String(pick(args, 'format') || 'markdown').toLowerCase()
    const seconds = Math.min(120, Math.max(1, Number(pick(args, 'timeout')) || 30))
    const timeout = AbortSignal.timeout(seconds * 1000)
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout
    let res
    let body
    try {
      res = await fetch(url, { headers: { 'User-Agent': UA, Accept: format === 'html' ? 'text/html,*/*' : 'text/markdown,text/html,application/json,text/plain,*/*', 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' }, redirect: 'follow', signal })
      body = await readBody(res)
    } catch (e) {
      const reason = timeout.aborted ? `tempo esgotado após ${seconds}s` : e.cause?.code || e.message
      return { output: `Erro ao baixar ${url}: ${reason}`, isError: true, display: { summary: 'falhou' } }
    }
    const type = res.headers.get('content-type') || ''
    if (/^(image|audio|video)\/|application\/(octet-stream|zip|pdf)/i.test(type)) {
      return { output: `URL: ${res.url}\nStatus: ${res.status}\nTipo: ${type}\n\n[conteúdo binário não exibido]`, isError: !res.ok, display: { summary: `${res.status} · binário` } }
    }
    const raw = body.text
    const isHtml = /html/i.test(type) || /^\s*<(!doctype|html)/i.test(raw)
    let text = !isHtml || format === 'html' ? raw : format === 'text' ? htmlToMarkdown(raw).replace(/[*_`#]+/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') : htmlToMarkdown(raw)
    if (body.cut) text += '\n\n… [download interrompido em 5 MB]'
    if (text.length > max) text = text.slice(0, max) + `\n\n… [conteúdo truncado em ${max} caracteres de ${text.length}]`
    const kb = (Buffer.byteLength(raw) / 1024).toFixed(1)
    return {
      output: `URL: ${res.url}\nStatus: ${res.status}\nTipo: ${type}\n\n${text}`,
      isError: !res.ok,
      display: { summary: `${res.status} ${res.statusText || ''} · ${kb} KB`.replace(/\s+·/, ' ·').trim() },
    }
  },
}

export async function duckSearch(query, { max = 8, signal } = {}) {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal })
  const html = await res.text()
  const results = []
  const linkRe = /<a[^>]+href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi
  const snippetRe = /<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi
  const links = [...html.matchAll(linkRe)]
  const snippets = [...html.matchAll(snippetRe)].map((m) => decodeEntities(m[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim())
  links.forEach((m, i) => {
    let href = decodeEntities(m[1])
    const uddg = /[?&]uddg=([^&]+)/.exec(href)
    if (uddg) href = decodeURIComponent(uddg[1])
    if (href.startsWith('//')) href = 'https:' + href
    if (/duckduckgo\.com\/y\.js/.test(href)) return
    results.push({ title: decodeEntities(m[2].replace(/<[^>]+>/g, '')).trim(), url: href, snippet: snippets[i] || '' })
  })
  return results.slice(0, max)
}

export const websearch = {
  name: 'websearch',
  label: 'WebSearch',
  readOnly: true,
  description: 'Search the web (DuckDuckGo) and return titles, URLs and snippets. Use webfetch afterwards to read a result.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      max_results: { type: 'integer', description: 'Number of results (default 8)' },
    },
    required: ['query'],
  },
  summary(args) {
    return String(pick(args, 'query', 'q') || '')
  },
  async run(args, ctx) {
    const query = String(pick(args, 'query', 'q') || '').trim()
    if (!query) return { output: 'Erro: parâmetro "query" é obrigatório.', isError: true }
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000)
    let results
    try {
      results = await duckSearch(query, { max: Number(pick(args, 'max_results', 'limit')) || 8, signal })
    } catch (e) {
      return { output: `Erro na busca: ${e.cause?.code || e.message}`, isError: true }
    }
    if (!results.length) return { output: 'Nenhum resultado (a busca pode ter sido bloqueada; tente outra consulta).', display: { summary: 'nenhum resultado' } }
    const text = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`).join('\n\n')
    return { output: text, display: { summary: `${results.length} resultado${results.length === 1 ? '' : 's'}` } }
  },
}
