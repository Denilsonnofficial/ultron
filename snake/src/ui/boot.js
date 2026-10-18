import { spriteLines, SPRITE } from '../logo.js'
import { VERSION } from '../config.js'
import { t } from '../theme.js'
import { truncate } from './ansi.js'

export async function boot(app) {
  if (!process.stdout.isTTY || app.config.boot === false || process.env.SNAKE_NO_BOOT === '1') return
  const normal = app.term.footer
  const started = Date.now()
  let frame = 0, done = false, timer
  await new Promise((resolve) => {
    const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve() }
    app.skipBoot = finish
    const draw = () => {
      const sprite = SPRITE.map((row) => frame % 3 === 1 ? row.replaceAll('R', '.') : row)
      app.term.setFooter((cols, rows) => ({ lines: [...spriteLines(sprite).slice(0, Math.max(1, rows - 4)), t.primary(`snake v${VERSION}`) + t.muted(' · agente de código'), t.subtle('esc para começar')].map((l) => truncate(l, cols - 1)), cursor: null }))
      app.term.render(); frame++
      if (Date.now() - started >= 1100) finish()
      else timer = setTimeout(draw, 180)
    }
    draw()
  })
  app.term.clearFooter(); app.term.setFooter(normal); app.skipBoot = null
}
