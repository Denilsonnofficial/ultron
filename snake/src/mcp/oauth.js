import crypto from 'node:crypto'
import http from 'node:http'
import path from 'node:path'
import { VERSION, paths, readJSON, writeJSON } from '../config.js'

const authFile = () => path.join(paths.home, 'mcp-auth.json')
const b64 = (v) => v.toString('base64url')
export function pkce() { const verifier = b64(crypto.randomBytes(48)); return { verifier, challenge: b64(crypto.createHash('sha256').update(verifier).digest()) } }
function secure(url) {
  const value = new URL(url)
  if (value.protocol !== 'https:' && !(value.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(value.hostname))) throw new Error('OAuth exige HTTPS (ou loopback local)')
  return value
}
async function jsonFetch(url, options = {}) {
  secure(url)
  const response = await fetch(url, { ...options, redirect: 'error', signal: options.signal || AbortSignal.timeout(10000) })
  if (!response.ok) throw new Error(`OAuth HTTP ${response.status}`)
  return response.json()
}
export async function discoverOAuth(resource, { signal } = {}) {
  const url = secure(resource)
  const probe = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'snake', version: VERSION } } }), redirect: 'error', signal: signal || AbortSignal.timeout(10000) })
  const auth = probe.headers.get('www-authenticate') || ''; await probe.body?.cancel()
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(auth)?.[1] || `${url.origin}/.well-known/oauth-protected-resource${url.pathname === '/' ? '' : url.pathname}`
  const resourceMetadata = await jsonFetch(metadataUrl, { signal })
  if (resourceMetadata.resource && resourceMetadata.resource.replace(/\/$/, '') !== resource.replace(/\/$/, '')) throw new Error('OAuth: metadata pertence a outro recurso')
  const issuer = resourceMetadata.authorization_servers?.[0]
  if (!issuer) throw new Error('Servidor não anunciou um authorization server OAuth')
  const base = secure(issuer), candidates = [`${base.origin}/.well-known/oauth-authorization-server${base.pathname === '/' ? '' : base.pathname}`, issuer.replace(/\/$/, '') + '/.well-known/openid-configuration']
  let metadata
  for (const candidate of candidates) { try { metadata = await jsonFetch(candidate, { signal }); break } catch {} }
  if (!metadata || metadata.issuer !== issuer) throw new Error('OAuth: issuer inválido ou descoberta indisponível')
  if (!metadata.authorization_endpoint || !metadata.token_endpoint) throw new Error('OAuth: endpoints ausentes')
  secure(metadata.authorization_endpoint); secure(metadata.token_endpoint)
  if (metadata.code_challenge_methods_supported && !metadata.code_challenge_methods_supported.includes('S256')) throw new Error('OAuth requer PKCE S256')
  return { ...metadata, scopes: resourceMetadata.scopes_supported || [] }
}

export async function loginMcp(name, config, { onUrl, signal, timeout = 180000 } = {}) {
  const metadata = await discoverOAuth(config.url, { signal }), state = b64(crypto.randomBytes(24)), { verifier, challenge } = pkce()
  let resolveCode, rejectCode
  const codePromise = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject })
  // Rejeições do callback são observadas mesmo se o registro de cliente falhar.
  codePromise.catch(() => {})
  const callback = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname !== '/callback' || url.searchParams.get('state') !== state) { res.writeHead(400); res.end('Estado OAuth inválido'); return }
    if (url.searchParams.has('error')) { res.end('Autorização negada'); rejectCode(new Error(url.searchParams.get('error'))); return }
    const code = url.searchParams.get('code'); if (!code) { res.writeHead(400); res.end('Código ausente'); return }
    res.end('Snake autorizado. Volte ao terminal.'); resolveCode(code)
  })
  await new Promise((resolve, reject) => { callback.once('error', reject); callback.listen(config.oauth?.callbackPort || 0, '127.0.0.1', resolve) })
  const redirectUri = `http://127.0.0.1:${callback.address().port}/callback`
  const timer = setTimeout(() => rejectCode(new Error('Tempo de login OAuth esgotado')), timeout)
  const abort = () => rejectCode(new DOMException('Interrompido', 'AbortError'))
  signal?.addEventListener('abort', abort, { once: true })
  try {
    let clientId = config.oauth?.clientId
    if (!clientId) {
      if (!metadata.registration_endpoint) throw new Error('Servidor não aceita registro dinâmico. Configure mcp.<nome>.oauth.clientId e callbackPort.')
      const registration = await jsonFetch(metadata.registration_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Snake', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }), signal })
      clientId = registration.client_id
      if (!clientId) throw new Error('Registro OAuth não retornou client_id')
    }
    const authorize = new URL(metadata.authorization_endpoint)
    const scope = config.oauth?.scope || metadata.scopes.join(' ')
    for (const [k, v] of Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: 'S256', resource: config.url, ...(scope ? { scope } : {}) })) authorize.searchParams.set(k, v)
    await onUrl?.(authorize.href)
    if (signal?.aborted) abort()
    const code = await codePromise
    const tokens = await jsonFetch(metadata.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier, resource: config.url }), signal })
    if (!tokens.access_token || (tokens.token_type && tokens.token_type.toLowerCase() !== 'bearer')) throw new Error('OAuth não devolveu token Bearer')
    const all = readJSON(authFile(), {})
    all[name] = { resource: config.url, clientId, tokenEndpoint: metadata.token_endpoint, ...tokens, expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null }
    writeJSON(authFile(), all, 0o600)
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); await new Promise((resolve) => callback.close(resolve)) }
}

export async function mcpToken(name, config) {
  const all = readJSON(authFile(), {}), saved = all[name]
  if (!saved || saved.resource !== config.url) return null
  if (!saved.expiresAt || saved.expiresAt > Date.now() + 30000) return saved.access_token
  if (!saved.refresh_token) throw new Error(`OAuth expirado: /mcp login ${name}`)
  const fresh = await jsonFetch(saved.tokenEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: saved.refresh_token, client_id: saved.clientId, resource: saved.resource }) })
  if (!fresh.access_token) throw new Error('Renovação OAuth falhou')
  all[name] = { ...saved, ...fresh, expiresAt: fresh.expires_in ? Date.now() + fresh.expires_in * 1000 : null }; writeJSON(authFile(), all, 0o600)
  return fresh.access_token
}
