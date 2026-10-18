// Definição dos provedores suportados pelo Snake.
//
// free (o que o provedor oferece sem pagar; o rótulo de cada modelo vem do catálogo):
//   'nokey'  → há modelo grátis sem chave (Pollinations, tier anônimo)
//   'key'    → plano gratuito ou modelos :free, mas exige uma chave (conta grátis)
//   'local'  → roda na sua máquina (Ollama, LM Studio)
//   false    → pago (cobra pelo uso)
// plan: rótulo curto do plano quando o padrão de `free` não descreve bem o provedor.

import { getAuth } from '../config.js'

export const PROVIDERS = {
  cohere: {
    id: 'cohere', name: 'Cohere', kind: 'openai', baseURL: 'https://api.cohere.ai/compatibility/v1',
    env: ['COHERE_API_KEY'], keyRequired: true, free: 'key', plan: 'preço por modelo; exige chave',
    note: 'North Mini Code é candidato; valide tools e código na sua conta', keyURL: 'https://dashboard.cohere.com/api-keys',
    catalog: 'modelsdev', modelsDev: 'cohere', preferred: ['north-mini-code-1-0'], compat: { streamOptions: false },
  },
  poolside: {
    id: 'poolside', name: 'Poolside', kind: 'openai', baseURL: 'https://inference.poolside.ai/v1',
    env: ['POOLSIDE_API_KEY'], keyRequired: true, free: 'key', plan: 'preço por modelo; exige chave',
    note: 'Laguna é candidato; valide tools e código na sua conta', keyURL: 'https://platform.poolside.ai',
    catalog: 'modelsdev', modelsDev: 'poolside', preferred: ['poolside/laguna-s-2.1', 'poolside/laguna-xs-2.1'],
  },
  pollinations: {
    id: 'pollinations',
    name: 'Pollinations',
    kind: 'openai',
    chatURL: 'https://text.pollinations.ai/openai',
    modelsURL: 'https://text.pollinations.ai/models',
    env: ['POLLINATIONS_API_KEY', 'POLLINATIONS_TOKEN'],
    keyRequired: false,
    free: 'nokey',
    note: 'grátis e sem chave; limite de uso por IP',
    keyURL: 'https://auth.pollinations.ai',
    catalog: 'pollinations',
    preferred: ['openai-fast'],
  },
  llm7: {
    id: 'llm7',
    name: 'LLM7',
    kind: 'openai',
    baseURL: 'https://api.llm7.io/v1',
    env: ['LLM7_API_KEY'],
    keyRequired: true,
    free: false,
    plan: 'pago (cota diária)',
    note: 'exige token; cobra por uso depois da cota do plano',
    keyURL: 'https://dash.llm7.io',
    catalog: 'llm7',
    preferred: ['DeepSeek-V4-Flash-0731', 'GLM-5.3-Flash', 'kimi-k2.7-code', 'gpt-oss:20b'],
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'openai',
    baseURL: 'https://openrouter.ai/api/v1',
    env: ['OPENROUTER_API_KEY'],
    keyRequired: true,
    free: 'key',
    plan: 'modelos :free grátis',
    note: 'centenas de modelos; os :free são grátis com chave gratuita',
    keyURL: 'https://openrouter.ai/keys',
    catalog: 'openrouter',
    headers: { 'X-Title': 'Snake' },
    extraBody: { usage: { include: true } },
    cacheControl: (modelId) => /^(anthropic\/|google\/gemini)/.test(modelId),
    preferred: [
      'poolside/laguna-s-2.1:free',
      'cohere/north-mini-code:free',
      'nvidia/nemotron-3-super-120b-a12b:free',
      'nvidia/nemotron-3-ultra-550b-a55b:free',
      'openrouter/free',
    ],
  },
  google: {
    id: 'google',
    name: 'Google Gemini',
    kind: 'openai',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
    keyRequired: true,
    free: 'key',
    note: 'tier grátis com chave do AI Studio',
    keyURL: 'https://aistudio.google.com/apikey',
    catalog: 'modelsdev',
    modelsDev: 'google',
    preferred: ['gemini-flash-latest', 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash'],
  },
  groq: {
    id: 'groq',
    name: 'Groq',
    kind: 'openai',
    baseURL: 'https://api.groq.com/openai/v1',
    env: ['GROQ_API_KEY'],
    keyRequired: true,
    free: 'key',
    note: 'tier grátis, muito rápido',
    keyURL: 'https://console.groq.com/keys',
    catalog: 'modelsdev',
    modelsDev: 'groq',
    preferred: ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'],
  },
  cerebras: {
    id: 'cerebras',
    name: 'Cerebras',
    kind: 'openai',
    baseURL: 'https://api.cerebras.ai/v1',
    env: ['CEREBRAS_API_KEY'],
    keyRequired: true,
    free: 'key',
    note: 'tier grátis, muito rápido',
    keyURL: 'https://cloud.cerebras.ai',
    catalog: 'modelsdev',
    modelsDev: 'cerebras',
    preferred: ['gpt-oss-120b', 'qwen-3.8-27b'],
  },
  mistral: {
    id: 'mistral',
    name: 'Mistral',
    kind: 'openai',
    baseURL: 'https://api.mistral.ai/v1',
    env: ['MISTRAL_API_KEY'],
    keyRequired: true,
    free: 'key',
    note: 'plano Experiment grátis',
    keyURL: 'https://console.mistral.ai/api-keys',
    catalog: 'modelsdev',
    modelsDev: 'mistral',
    compat: { streamOptions: false, toolIdFormat: 'alnum9', toolMessageName: true },
    preferred: ['labs-devstral-small-2512', 'labs-leanstral-1-5-1', 'mistral-medium-latest', 'mistral-small-latest'],
  },
  github: {
    id: 'github',
    name: 'GitHub Models',
    kind: 'openai',
    baseURL: 'https://models.github.ai/inference',
    env: ['GITHUB_TOKEN', 'GH_TOKEN'],
    keyRequired: true,
    free: 'key',
    note: 'grátis com token do GitHub (limites diários)',
    keyURL: 'https://github.com/settings/personal-access-tokens',
    catalog: 'github',
    preferred: ['openai/gpt-4.1', 'openai/gpt-4o'],
  },
  nvidia: {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    kind: 'openai',
    baseURL: 'https://integrate.api.nvidia.com/v1',
    env: ['NVIDIA_API_KEY'],
    keyRequired: true,
    free: 'key',
    note: 'créditos grátis para desenvolvedores',
    keyURL: 'https://build.nvidia.com',
    catalog: 'modelsdev',
    modelsDev: 'nvidia',
    preferred: ['deepseek-ai/deepseek-v4.1-flash', 'z-ai/glm-5.3', 'moonshotai/kimi-k3'],
  },
  zai: {
    id: 'zai',
    name: 'Z.ai (GLM)',
    kind: 'openai',
    baseURL: 'https://api.z.ai/api/paas/v4',
    env: ['ZAI_API_KEY', 'ZHIPU_API_KEY'],
    keyRequired: true,
    free: 'key',
    note: 'GLM-4.7-Flash/4.5-Flash têm preço zero; outros Flash podem ser pagos',
    keyURL: 'https://z.ai/manage-apikey/apikey-list',
    catalog: 'modelsdev',
    modelsDev: 'zai',
    preferred: ['glm-4.7-flash', 'glm-5.3-flash', 'glm-5.3'],
  },
  huggingface: {
    id: 'huggingface',
    name: 'Hugging Face',
    kind: 'openai',
    baseURL: 'https://router.huggingface.co/v1',
    env: ['HF_TOKEN', 'HUGGINGFACE_API_KEY'],
    keyRequired: true,
    free: 'key',
    note: 'créditos mensais grátis',
    keyURL: 'https://huggingface.co/settings/tokens',
    catalog: 'modelsdev',
    modelsDev: 'huggingface',
    preferred: ['zai-org/GLM-4.7-Flash', 'zai-org/GLM-5.3-Flash'],
  },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    kind: 'anthropic',
    baseURL: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1',
    env: ['ANTHROPIC_API_KEY'],
    keyRequired: true,
    free: false,
    keyURL: 'https://console.anthropic.com/settings/keys',
    catalog: 'modelsdev',
    modelsDev: 'anthropic',
    preferred: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'],
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai',
    baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    env: ['OPENAI_API_KEY'],
    keyRequired: true,
    free: false,
    keyURL: 'https://platform.openai.com/api-keys',
    catalog: 'modelsdev',
    modelsDev: 'openai',
    compat: { maxTokensField: 'max_completion_tokens' },
    preferred: ['gpt-6-sol', 'gpt-6.1-sol', 'gpt-5.6', 'gpt-5.5'],
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'openai',
    baseURL: 'https://api.deepseek.com/v1',
    env: ['DEEPSEEK_API_KEY'],
    keyRequired: true,
    free: false,
    keyURL: 'https://platform.deepseek.com/api_keys',
    catalog: 'modelsdev',
    modelsDev: 'deepseek',
    preferred: ['deepseek-v4-flash', 'deepseek-flash', 'deepseek-v4-pro'],
  },
  xai: {
    id: 'xai',
    name: 'xAI (Grok)',
    kind: 'openai',
    baseURL: 'https://api.x.ai/v1',
    env: ['XAI_API_KEY'],
    keyRequired: true,
    free: false,
    keyURL: 'https://console.x.ai',
    catalog: 'modelsdev',
    modelsDev: 'xai',
    preferred: ['grok-4.7', 'grok-build-0.1'],
  },
  moonshot: {
    id: 'moonshot',
    name: 'Moonshot (Kimi)',
    kind: 'openai',
    baseURL: 'https://api.moonshot.ai/v1',
    env: ['MOONSHOT_API_KEY'],
    keyRequired: true,
    free: false,
    keyURL: 'https://platform.moonshot.ai/console/api-keys',
    catalog: 'modelsdev',
    modelsDev: 'moonshotai',
    preferred: ['kimi-k2.7-code', 'kimi-k3'],
  },
  together: {
    id: 'together',
    name: 'Together AI',
    kind: 'openai',
    baseURL: 'https://api.together.xyz/v1',
    env: ['TOGETHER_API_KEY'],
    keyRequired: true,
    free: false,
    keyURL: 'https://api.together.ai/settings/api-keys',
    catalog: 'modelsdev',
    modelsDev: 'togetherai',
    preferred: ['zai-org/GLM-5.3-Flash'],
  },
  fireworks: {
    id: 'fireworks',
    name: 'Fireworks AI',
    kind: 'openai',
    baseURL: 'https://api.fireworks.ai/inference/v1',
    env: ['FIREWORKS_API_KEY'],
    keyRequired: true,
    free: false,
    keyURL: 'https://fireworks.ai/account/api-keys',
    catalog: 'modelsdev',
    modelsDev: 'fireworks-ai',
    preferred: ['accounts/fireworks/models/glm-5p3-flash'],
  },
  ollama: {
    id: 'ollama',
    name: 'Ollama (local)',
    kind: 'openai',
    baseURL: (process.env.OLLAMA_HOST ? normalizeHost(process.env.OLLAMA_HOST) : 'http://localhost:11434') + '/v1',
    env: [],
    keyRequired: false,
    free: 'local',
    note: 'modelos locais, grátis e offline',
    keyURL: 'https://ollama.com/download',
    catalog: 'ollama',
    preferred: [],
  },
  lmstudio: {
    id: 'lmstudio',
    name: 'LM Studio (local)',
    kind: 'openai',
    baseURL: 'http://127.0.0.1:1234/v1',
    env: ['LMSTUDIO_API_KEY'],
    keyRequired: false,
    free: 'local',
    note: 'modelos locais via LM Studio',
    keyURL: 'https://lmstudio.ai',
    catalog: 'openai-list',
    preferred: [],
  },
}

function normalizeHost(h) {
  const withProto = /^https?:\/\//.test(h) ? h : `http://${h}`
  return withProto.replace(/\/+$/, '')
}

/** Registra provedores personalizados vindos da configuração. */
export function registerCustomProviders(config) {
  for (const [id, p] of Object.entries(config.providers || {})) {
    if (!p || typeof p !== 'object') continue
    const base = PROVIDERS[id] || {}
    PROVIDERS[id] = {
      ...base,
      id,
      name: p.name || base.name || id,
      kind: p.kind || base.kind || 'openai',
      baseURL: p.baseURL || p.baseUrl || base.baseURL,
      chatURL: p.chatURL || base.chatURL,
      env: p.env || base.env || [],
      apiKey: p.apiKey || base.apiKey,
      keyRequired: p.keyRequired ?? base.keyRequired ?? false,
      free: p.free ?? base.free ?? false,
      headers: { ...(base.headers || {}), ...(p.headers || {}) },
      extraBody: { ...(base.extraBody || {}), ...(p.extraBody || {}) },
      compat: { ...(base.compat || {}), ...(p.compat || {}) },
      catalog: p.models ? 'config' : base.catalog || 'openai-list',
      configModels: p.models || base.configModels,
      preferred: p.preferred || base.preferred || [],
      custom: !base.id,
    }
  }
}

/** Resolve a chave de API: variável de ambiente → ~/.snake/auth.json → config. */
export function resolveKey(providerId) {
  const p = PROVIDERS[providerId]
  if (!p) return null
  for (const name of p.env || []) if (process.env[name]) return { key: process.env[name], source: `env ${name}` }
  const auth = getAuth()
  if (auth[providerId]) return { key: auth[providerId], source: 'auth.json' }
  if (p.apiKey) return { key: p.apiKey, source: 'config' }
  return null
}

export function isUsable(providerId) {
  const p = PROVIDERS[providerId]
  if (!p) return false
  return !p.keyRequired || !!resolveKey(providerId)
}

export function freeLabel(p) {
  if (p.plan) return p.plan
  switch (p.free) {
    case 'nokey':
      return 'grátis sem chave'
    case 'key':
      return 'plano gratuito'
    case 'local':
      return 'local'
    default:
      return 'pago'
  }
}
