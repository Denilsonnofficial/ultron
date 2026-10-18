// API pública para integrar o harness em outros programas Node.js.
export { Agent } from './agent/agent.js'
export { Session } from './agent/session.js'
export { UsageTracker, cacheHitRate, costOf, promptTokens } from './agent/usage.js'
export { Catalog } from './providers/catalog.js'
export { PROVIDERS, registerCustomProviders } from './providers/registry.js'
export { McpManager } from './mcp/client.js'
export { DEFAULTS, VERSION, loadConfig } from './config.js'
export { getTools } from './tools/index.js'
