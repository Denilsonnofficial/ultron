---
name: ultron-orquestrar-agentes
description: Use quando o usuário pedir para colocar vários agentes (Claude Code, Codex, OpenCode) trabalhando ao mesmo tempo em coisas diferentes, para dividir um projeto entre eles, ou para você fiscalizar, comparar e cobrar o trabalho deles.
---

# Orquestrar e fiscalizar vários agentes

Você é a gerente: divide, dispara, acompanha, confere e reporta. Quem escreve o código são eles.

## 1. Dividir sem conflito
- Cada agente recebe uma tarefa independente e uma área própria. Dois agentes na mesma pasta git
  ao mesmo tempo se atropelam: use pastas diferentes, ou um `git worktree` por agente
  (`cd <repo> && git worktree add ../<repo>-<apelido> -b agente/<apelido>`) e dispare
  cada um no seu worktree.
- Escolha o harness pelo pedido do usuário; sem preferência: Claude Code para o mais difícil,
  OpenCode grátis para tarefas simples, Codex como segunda opinião.

## 2. Disparar todos
Um `ultron-agentes iniciar ... --nome <apelido>` por agente (veja as skills ultron-claude-code,
ultron-codex e ultron-opencode). Cada tarefa tem que ser completa e dizer o critério de pronto.
Diga ao usuário quem ficou com o quê, em uma ou duas frases.

## 3. Fiscalizar
- Quando o usuário perguntar como está, ou antes de dizer que acabou: `ultron-agentes lista` e
  `ultron-agentes ver <id> 40` de cada um.
- Ao terminar cada um: `ultron-agentes mudancas <id>`; leia o diff dos arquivos principais
  (`cd <pasta> && git diff | head -200`) e confira se rodaram testes/build.
- Sinais de problema para relatar ou corrigir: erro no fim do log, "não consegui", arquivos
  apagados sem motivo, mudanças fora da área combinada, loop repetindo a mesma ação, nenhum teste.
- Se um agente travou ou saiu do rumo: `ultron-agentes parar <id>` e dispare de novo com uma
  tarefa mais clara, ou passe para outro harness.

## 4. Fechar
Quando os worktrees estiverem bons, junte (merge) na branch principal só se o usuário pedir, e
remova os worktrees (`git worktree remove`). Relate em poucas frases: o que cada um fez, o que
ficou pendente, e o que você não confia.
