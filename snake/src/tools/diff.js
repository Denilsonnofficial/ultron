// Diff de linhas simples (prefixo/sufixo comum + LCS no trecho alterado) para exibir edições.

function lcsScript(a, b) {
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push(['eq', a[i]])
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push(['del', a[i++]])
    else ops.push(['add', b[j++]])
  }
  while (i < n) ops.push(['del', a[i++]])
  while (j < m) ops.push(['add', b[j++]])
  return ops
}

/**
 * Calcula o diff entre dois textos.
 * Retorna { added, removed, lines: [{ type: 'ctx'|'add'|'del'|'gap', oldNo, newNo, text }] }.
 */
export function diffLines(oldText, newText, { context = 3, maxLines = 400 } = {}) {
  // a quebra de linha final não é uma linha a mais
  if ((oldText.endsWith('\n') || oldText === '') && (newText.endsWith('\n') || newText === '')) {
    if (oldText) oldText = oldText.slice(0, -1)
    if (newText) newText = newText.slice(0, -1)
  }
  const a = oldText === '' ? [] : oldText.split('\n')
  const b = newText === '' ? [] : newText.split('\n')
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let s = 0
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  const midA = a.slice(p, a.length - s)
  const midB = b.slice(p, b.length - s)
  const ops = midA.length * midB.length <= 250000 ? lcsScript(midA, midB) : [...midA.map((l) => ['del', l]), ...midB.map((l) => ['add', l])]

  const lines = []
  const start = Math.max(0, p - context)
  for (let i = start; i < p; i++) lines.push({ type: 'ctx', oldNo: i + 1, newNo: i + 1, text: a[i] })
  let oi = p
  let ni = p
  let added = 0
  let removed = 0
  let eqRun = []
  const flushEq = (final) => {
    if (!eqRun.length) return
    if (eqRun.length > context * 2 + 1 && !final) {
      lines.push(...eqRun.slice(0, context))
      lines.push({ type: 'gap', text: '' })
      lines.push(...eqRun.slice(-context))
    } else lines.push(...eqRun)
    eqRun = []
  }
  for (const [op, text] of ops) {
    if (op === 'eq') {
      eqRun.push({ type: 'ctx', oldNo: ++oi, newNo: ++ni, text })
      continue
    }
    flushEq(false)
    if (op === 'del') {
      lines.push({ type: 'del', oldNo: ++oi, newNo: null, text })
      removed++
    } else {
      lines.push({ type: 'add', oldNo: null, newNo: ++ni, text })
      added++
    }
  }
  flushEq(false)
  const end = Math.min(a.length, a.length - s + context)
  for (let i = a.length - s; i < end; i++) {
    const newNo = i - (a.length - b.length) + 1
    lines.push({ type: 'ctx', oldNo: i + 1, newNo, text: a[i] })
  }
  if (lines.length > maxLines) {
    const cut = lines.length - maxLines
    lines.splice(maxLines, cut, { type: 'gap', text: `… +${cut} linhas` })
  }
  return { added, removed, lines }
}
