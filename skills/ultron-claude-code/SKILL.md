---
name: ultron-claude-code
description: Use quando o usuário pedir para colocar o Claude Code (Claude, Opus, Sonnet, Fable) para trabalhar em algum projeto ou tarefa de código. Explica como disparar, acompanhar e conferir o trabalho dele em segundo plano.
---

# Claude Code como agente de trabalho

Use o Claude Code desta máquina (`claude`). Se `command -v claude` não achar nada, diga ao usuário que ele não está instalado.

## Disparar (sempre em segundo plano, nunca esperando no seu turno)
```
ultron-agentes iniciar claude <pasta> "<tarefa completa e autossuficiente>" --modelo opus --esforco medium --nome <apelido>
```
- `--modelo`: alias `opus`, `sonnet`, `fable`, `haiku` ou o id completo (ex.: `claude-opus-5-5`).
  "Opus 5.5" = `opus` (o alias aponta para o mais novo) ou `claude-opus-5-5`.
- `--esforco`: `low`, `medium`, `high`, `xhigh`, `max`. Sem pedido do usuário, use `medium`.
- Ele roda com `--permission-mode bypassPermissions` (sem pedir licença), dentro da `<pasta>`.
- A tarefa vai sozinha, sem contexto da conversa: escreva o pedido completo (objetivo, arquivos
  relevantes, critério de pronto, "faça commit no final" se o usuário quiser, e onde está o plano).

## Acompanhar e fiscalizar
- `ultron-agentes lista` (rodando/terminado), `ultron-agentes ver <id> 60` (fim do log),
  `ultron-agentes mudancas <id>` (git status e diff).
- Ao terminar, leia o log e as mudanças e diga ao usuário, em poucas frases, o que foi feito, se
  testou, e qualquer coisa suspeita (testes não rodados, arquivos fora do escopo, erros no log).
- `ultron-agentes parar <id>` se o usuário mandar parar ou se o agente estiver claramente perdido.

## Avise o usuário
Diga em uma frase que disparou, com qual modelo e esforço, e que vai avisar quando terminar.
