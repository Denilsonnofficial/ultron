---
name: ultron-codex
description: Use quando o usuário pedir para colocar o Codex (OpenAI, GPT) para trabalhar em algum projeto ou tarefa de código. Explica como disparar, acompanhar e conferir o trabalho dele em segundo plano.
---

# Codex como agente de trabalho

Use o Codex CLI desta máquina (`codex`). Se `command -v codex` não achar nada, diga que não está instalado.

## Disparar (em segundo plano)
```
ultron-agentes iniciar codex <pasta> "<tarefa completa e autossuficiente>" --modelo <modelo> --esforco medium --nome <apelido>
```
- Roda `codex exec` com `-s danger-full-access` (pode editar e executar sem pedir), `-C <pasta>`.
- `--modelo` é opcional (sem ele usa o padrão da conta do usuário). `--esforco` vira
  `model_reasoning_effort` (`low`, `medium`, `high`).
- Escreva a tarefa completa: ele não vê a conversa.

## Acompanhar e fiscalizar
`ultron-agentes lista`, `ultron-agentes ver <id> 60`, `ultron-agentes mudancas <id>`,
`ultron-agentes parar <id>`. Ao terminar, resuma o que mudou e aponte o que parecer errado.
