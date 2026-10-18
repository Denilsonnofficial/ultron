// Prompt de sistema e carregamento de instruções do projeto (SNAKE.md / AGENTS.md / CLAUDE.md).

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { paths } from '../config.js'
import { IGNORED_DIRS } from '../tools/util.js'

export const INSTRUCTION_FILES = ['SNAKE.md', 'AGENTS.md', 'CLAUDE.md']

export function findInstructionFiles(cwd) {
  const files = []
  if (fs.existsSync(paths.memory)) files.push(paths.memory)
  if (fs.existsSync(paths.notes)) files.push(paths.notes)
  const dirs = []
  let dir = path.resolve(cwd)
  for (;;) {
    dirs.unshift(dir)
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  for (const d of dirs) {
    for (const name of INSTRUCTION_FILES) {
      const f = path.join(d, name)
      try {
        if (fs.statSync(f).isFile()) {
          if (!files.includes(f)) files.push(f)
          break
        }
      } catch {}
    }
  }
  return files
}

export function loadInstructions(cwd) {
  let budget = 40000
  const out = []
  for (const file of findInstructionFiles(cwd)) {
    let content = ''
    try {
      content = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (content.length > budget) content = content.slice(0, budget) + '\n… [truncado]'
    budget -= content.length
    out.push({ file, content })
    if (budget <= 0) break
  }
  return out
}

export function gitInfo(cwd) {
  const run = (args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim()
  try {
    if (run(['rev-parse', '--is-inside-work-tree']) !== 'true') return null
    let branch = ''
    try {
      branch = run(['rev-parse', '--abbrev-ref', 'HEAD'])
    } catch {}
    let status = []
    try {
      status = run(['status', '--short']).split('\n').filter(Boolean)
    } catch {}
    return { branch, status }
  } catch {
    return null
  }
}

function topLevel(cwd) {
  if (path.resolve(cwd) === path.resolve(os.homedir()) || path.resolve(cwd) === '/') return null
  try {
    const entries = fs
      .readdirSync(cwd, { withFileTypes: true })
      .filter((e) => e.name !== '.git' && !IGNORED_DIRS.has(e.name))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    const shown = entries.slice(0, 60).map((e) => e.name + (e.isDirectory() ? '/' : ''))
    if (entries.length > 60) shown.push(`… (+${entries.length - 60})`)
    return shown
  } catch {
    return null
  }
}

const MODE_TEXT = {
  yolo: `# Permission mode: YOLO
All tool calls are auto-approved; the user is NOT asked for permission. Work autonomously and finish the job, but be careful with destructive or irreversible operations (deleting data, \`rm -rf\` on broad paths, \`git push --force\`, \`git reset --hard\`, dropping databases, publishing packages): only do them when the user explicitly asks.`,
  ask: `# Permission mode: ASK
The user approves each file change and shell command. If a call is denied, do not retry the same call: adapt or ask the user.`,
  plan: `# Permission mode: PLAN (read-only)
Only read-only tools are available. Do NOT try to modify files or run commands. Investigate the codebase and then present a clear, step-by-step implementation plan (files to change and what to change). The user will switch to an execution mode after approving the plan.`,
}

export function buildSystemPrompt({ cwd, modelLabel, mode = 'yolo', subagent = false, date = new Date(), skills = [], activeSkills = [], definition = {}, goal, outputStyle, extraDirs = [] }) {
  const git = gitInfo(cwd)
  const lines = []
  if (subagent) {
    lines.push(
      `You are a Snake sub-agent: an autonomous coding agent launched by the main agent to complete ONE self-contained task. You do not see the main conversation. Use the tools to complete the task, then reply with a concise final report containing exactly what the main agent needs (findings with file paths and line numbers, changes made, open issues). Do not ask questions; make reasonable assumptions and state them.`,
    )
  } else {
    lines.push(
      `You are Snake, an AI coding agent running in the user's terminal. You help with software engineering tasks — writing and editing code, debugging, running commands, explaining code and managing projects — by using the tools available to you.`,
    )
  }
  lines.push(`
# Communication
- Reply in the same language the user writes in (default: Brazilian Portuguese).
- Be concise and direct. Output is rendered as Markdown in a monospace terminal: use short paragraphs, bullet lists and fenced code blocks with a language tag.
- Before calling tools, at most one short sentence about what you are doing. After finishing, summarize what changed in a few lines.
- Never invent file contents, paths, APIs or command results. When unsure, investigate with tools.

# Doing tasks
- Explore before changing: use glob/grep/read to understand the relevant code. Read a file before editing it.
- Prefer \`edit\` for targeted changes; use \`write\` for new files or full rewrites.
- Follow the project's existing conventions, style, libraries and structure. Check manifests (package.json, pyproject.toml, go.mod...) before assuming a dependency exists.
- Verify your work: run the build, tests, linters or the program itself when possible, and fix what you broke.
- For tasks with 3 or more steps, keep a plan with \`todowrite\` (exactly one item in_progress; mark items completed as soon as they are done).
- Keep going until the task is completely done. Only stop to ask when a decision truly needs the user.
- Do not create documentation files, commits or pushes unless asked. Never print or leak secrets/API keys.

# Tools
- Call several tools in one response when they are independent (e.g. reading multiple files).
- Independent read-only calls (read, grep, glob, ls, webfetch) sent in the same response run in parallel — batch them.
- \`bash\` is non-interactive and keeps the working directory between calls (or pass \`workdir\`). Use \`background: true\` for servers, watchers and long builds: you are notified automatically when a background command ends, so do not poll it with sleep loops.
- Large tool outputs are truncated and the full text is saved to a file whose path is shown; read that file with offset/limit or grep it instead of re-running the command.
- \`edit\` replaces one exact snippet; \`multiedit\` applies several edits to one file atomically; \`apply_patch\` applies a multi-file patch (*** Begin Patch format). Never include the read line-number prefix in old_string.${subagent ? '' : '\n- `task` launches a sub-agent with a fresh context for self-contained research or work.'}
- \`webfetch\` and \`websearch\` give you internet access.

${MODE_TEXT[mode] || `# Permission mode: ${mode}\nTool permission rules are enforced by the harness. Explicit deny rules always apply. Never work around a denied action.`}

# Environment
<env>
Working directory: ${cwd}
Platform: ${process.platform} (${os.release()})
Shell: bash
Today's date: ${date.toISOString().slice(0, 10)}
Git repository: ${git ? `yes (branch ${git.branch || '?'})` : 'no'}
Model: ${modelLabel}
</env>`)
  if (git?.status?.length) {
    const st = git.status.slice(0, 25)
    lines.push(`\nGit status at session start (a snapshot; it will not update — run git yourself when needed):\n${st.join('\n')}${git.status.length > 25 ? `\n… (+${git.status.length - 25})` : ''}`)
  }
  const top = topLevel(cwd)
  if (top?.length) lines.push(`\nTop-level entries of the working directory:\n${top.join('  ')}`)
  const instructions = loadInstructions(cwd)
  if (goal?.status === 'active') lines.push(`\n# Objetivo atual do usuário\n${goal.text}\nCriado: ${new Date(goal.created).toISOString()} · status: ${goal.status}`)
  if (definition.body) lines.push(`\n# Agente ${definition.name}\n${definition.body}`)
  if (outputStyle) lines.push(`\nResponse style requested by user: ${outputStyle}.`)
  if (extraDirs.length) lines.push(`\nAdditional directories provided by user for reading:\n${extraDirs.join('\n')}`)
  if (skills.length) lines.push(`\n<available_skills>\n${skills.map((s) => `${s.name}: ${s.description} (${s.file})`).join('\n')}\n</available_skills>\nUse the skill tool to load the relevant guide before acting.`)
  for (const name of activeSkills) {
    const skill = skills.find((s) => s.name === name)
    if (skill) lines.push(`\n<active_skill name="${name}" file="${skill.file}">\n${skill.body}\n</active_skill>`)
  }
  if (instructions.length) {
    lines.push('\n# Project and user instructions\nFollow these instructions. They override default behavior when they conflict.')
    for (const ins of instructions) lines.push(`\n<instructions file="${ins.file}">\n${ins.content.trim()}\n</instructions>`)
  }
  return lines.join('\n')
}

export function buildReviewPrompt(diff, { fix = false } = {}) {
  return `Revise as alterações abaixo. Priorize bugs reproduzíveis, regressões, segurança e testes faltantes. Informe severidade, arquivo/linha e correção sugerida. Não invente achados. ${fix ? 'Corrija os problemas concretos e execute os testes. As edições serão submetidas à aprovação do usuário.' : 'Somente apresente achados; não modifique arquivos.'}\n\n<diff>\n${diff}\n</diff>`
}
