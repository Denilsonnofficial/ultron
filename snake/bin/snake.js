#!/usr/bin/env node
// 🐍 Snake — agente de código para o terminal.

const [major] = process.versions.node.split('.').map(Number)
if (major < 20) {
  console.error(`snake precisa do Node.js 20 ou mais novo (você tem ${process.versions.node}).`)
  process.exit(1)
}

const { main } = await import('../src/cli.js')
try {
  const code = await main(process.argv.slice(2))
  process.exit(typeof code === 'number' ? code : 0)
} catch (err) {
  console.error(err?.stack || String(err))
  process.exit(1)
}
