// Gratuidade é uma propriedade do modelo: só é "grátis" o que tem preço zero comprovado
// (catálogo com 0/0) ou acesso anônimo sem cobrança. Cota diária não é gratuidade.
import { fmtPrice } from '../ui/format.js'

export function validPrice(value) {
  if (value == null || value === '' || typeof value === 'boolean') return undefined
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

export function tokenPricing(input, output, cacheRead, cacheWrite) {
  input = validPrice(input)
  output = validPrice(output)
  if (input === undefined || output === undefined) return null
  return { input, output, cacheRead: validPrice(cacheRead), cacheWrite: validPrice(cacheWrite) }
}

export function isZeroPrice(pricing) {
  return !!pricing && pricing.input === 0 && pricing.output === 0 &&
    Object.values(pricing).every((v) => v == null || v === 0)
}

/** Rótulo curto de custo: "grátis", "local", "$0.3/$1.2" (US$ por 1M tokens) ou "preço ?". */
export function costLabel(model) {
  if (model.catalogStale) return 'preço a confirmar'
  if (model.access === 'local') return 'LOCAL'
  if (model.access === 'subscription') return 'ASSINATURA'
  if (model.free && isZeroPrice(model.pricing)) return model.toolCheck?.ok ? 'GRÁTIS' : 'zero · não verificado'
  if (model.pricing) return `PAGO $${fmtPrice(model.pricing.input)}/$${fmtPrice(model.pricing.output)}`
  if (model.access === 'quota') return 'COTA DO PLANO'
  return 'preço ?'
}

/** Frase completa para dicas: preços por categoria de token. */
export function priceSentence(model) {
  const p = model.pricing
  if (!p || model.free) return ''
  const parts = [`entrada $${fmtPrice(p.input)}`, `saída $${fmtPrice(p.output)}`]
  if (p.cacheRead != null) parts.push(`cache $${fmtPrice(p.cacheRead)}`)
  return `US$ por 1M tokens: ${parts.join(' · ')}`
}
