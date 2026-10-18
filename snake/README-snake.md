<p align="center"><img src="assets/banner.png" alt="Snake — seu agente de código no terminal" width="100%"></p>

# Snake 🐍

Harness de agente de código para o terminal, com interface verde, mascote de cobrinha, modelos gratuitos, chaves próprias de API e modo **YOLO por padrão**. Escrito em JavaScript, com Node.js 20+ e sem dependências de execução.

O Snake conversa com o modelo, executa ferramentas, devolve os resultados e continua a tarefa. A interface mostra arquivos alterados, saída de comandos, tarefas, contexto e consumo por modelo.

## Instalar e iniciar

Requisitos: Node.js 20+, npm e Bash. Linux e macOS; no Windows, use WSL. Git e ripgrep são recomendados. Para a interface, use um terminal UTF-8.

Na pasta deste projeto:

```bash
npm install --global .
snake
```

Ou execute sem instalar:

```bash
node bin/snake.js
node bin/snake.js -p "Explique a estrutura deste projeto"
```

Depois da instalação, entre no projeto em que deseja trabalhar:

```bash
cd /caminho/do/seu/projeto
snake "Leia o projeto e corrija os testes que estão falhando"
```

O padrão é YOLO: edições e comandos são executados sem confirmação. `snake --ask` habilita confirmações na interface; `snake --plan` disponibiliza ferramentas de leitura. Nenhum desses modos cria um sandbox do sistema operacional.

## Modelos gratuitos e API própria

| Situação | Modelos | Custo |
| --- | --- | --- |
| Sem nenhuma chave | `pollinations/openai-fast` (GPT-OSS 20B) | grátis, com limite de uso por IP |
| Chave grátis do OpenRouter | variantes `:free` e `openrouter/free` | grátis, com limite diário |
| Chave de Gemini, Groq, Cerebras, Mistral, GitHub Models, NVIDIA, Z.ai ou Hugging Face | catálogo do provedor | plano gratuito da conta; o Snake mostra o preço de catálogo |
| Chave de API paga | Anthropic, OpenAI, DeepSeek, xAI, Moonshot, Together, Fireworks, LLM7 | preço por token |

```bash
snake models --free
snake providers
snake -m pollinations/openai-fast
```

No `/models` e em `snake models`, **“grátis” aparece só em modelos com preço zero no catálogo** (ou no acesso anônimo do Pollinations). Os demais mostram o preço em US$ por 1M tokens (`entrada/saída`) ou `preço ?` quando o catálogo não informa. Sem chave, o seletor lista o modelo sem chave e os modelos `:free` do OpenRouter; escolher um deles pede a chave. `/models todos` inclui os pagos.

A seleção automática usa um modelo `:free` do OpenRouter quando há chave; caso contrário, usa `pollinations/openai-fast`. Um modelo salvo na configuração tem prioridade. Não há troca automática para um modelo pago quando uma cota termina.

Verificação de 15/10/2026: o endpoint anônimo do Pollinations respondeu sem chave e com chamadas de ferramentas; o LLM7 passou a exigir token e a cobrar por uso (a cota anônima retornava HTTP 429), por isso não é tratado como grátis; o plano grátis do OpenCode Zen só funciona dentro do próprio OpenCode. Disponibilidade e limites pertencem a cada serviço.

### OpenRouter

Crie sua chave em [OpenRouter Keys](https://openrouter.ai/keys). Salve-a pelo prompt oculto:

```bash
snake key openrouter
snake models openrouter --free
snake -m openrouter/openrouter/free
```

A referência é sempre `provedor/id-do-modelo`: acima, o provedor é `openrouter` e o modelo é `openrouter/free`. Também é possível selecionar um dos IDs exibidos por `snake models`. As [variantes gratuitas do OpenRouter](https://openrouter.ai/docs/guides/routing/model-variants/free) têm disponibilidade e limites próprios.

O Snake também aceita `OPENROUTER_API_KEY` no ambiente. Não é necessário gravar a chave no projeto. A prioridade é: variável de ambiente, chave salva, configuração do provedor. `snake logout openrouter` remove a chave salva; não remove variáveis do shell.

### Outros provedores

| Tipo | Provedores integrados |
| --- | --- |
| Grátis sem chave | Pollinations (tier anônimo) |
| Modelos gratuitos ou plano gratuito com chave | OpenRouter (`:free`), Gemini, Groq, Cerebras, Mistral, GitHub Models, NVIDIA, Z.ai, Hugging Face |
| APIs pagas | Anthropic, OpenAI, DeepSeek, xAI, Moonshot, Together, Fireworks, LLM7 |
| Execução local | Ollama, LM Studio |
| Personalizado | APIs compatíveis com Chat Completions ou Anthropic Messages |

“Plano gratuito” descreve uma possibilidade da conta no provedor, não uma garantia de gratuidade de todos os seus modelos. O painel usa o preço de catálogo ou o custo informado pela API; uma conta com franquia pode ter cobrança diferente. Consulte `/usage` e o painel do serviço.

Para usar um modelo local já instalado no Ollama:

```bash
snake models ollama
snake -m ollama/ID_EXIBIDO_NA_LISTA
```

Consulte [configuração e provedores](docs/CONFIGURACAO.md) para modelos próprios, MCP e variáveis de ambiente.

## O que está incluído

- Interface que se adapta à largura do terminal, inclusive celular (Termux, a partir de ~40 colunas).
- Conversa com streaming, Markdown, colagem multilinha, histórico, seleção de modelos e autocompletar de comandos e `@arquivo`.
- Leitura (com limite de 50 KB por leitura e PDF via `pdftotext`), escrita, `edit` tolerante (aspas tipográficas, espaços, prefixo de número de linha, CRLF e BOM preservados), `multiedit` atômico e `apply_patch` para vários arquivos.
- Ferramentas somente leitura pedidas na mesma resposta (read, grep, glob, webfetch…) rodam em paralelo.
- Busca de arquivos e conteúdo que nunca trava a interface: ripgrep quando houver, senão o grep do sistema ou um percurso assíncrono que respeita `.gitignore`, sempre com prazo e cancelamento.
- Shell com timeout, `workdir`, processos em segundo plano e aviso automático ao modelo quando um processo termina.
- Saídas grandes de ferramentas são cortadas em 2000 linhas / 50 KB e a saída completa fica salva em `~/.snake/tool-output/` para o modelo ler depois; saídas antigas são podadas do contexto.
- Verificação de sintaxe após cada edição (JS, Python, JSON, shell): o erro volta para o modelo corrigir na hora.
- Chamadas ao modelo com vigia de inatividade: provedor que para de responder é refeito em vez de travar o turno; resposta vazia gera um pedido automático para continuar.
- Busca na web, leitura de URLs, lista de tarefas e ferramenta de tarefa em contexto separado, desativável pela configuração.
- Sessões persistentes, retomada, exportação Markdown, instruções por projeto e compactação automática do contexto.
- MCP por stdio e HTTP em modo interativo e não interativo.
- Contagem de entrada, saída, raciocínio, cache lido/gravado, taxa de cache, tempo, tokens/s e custo por modelo.
- Modos YOLO, ASK e PLAN; `/undo` e `/redo` por turno, persistidos entre execuções.

## Comandos de uso diário

| Comando | Resultado |
| --- | --- |
| `/help` | Comandos e atalhos |
| `/models` ou `/model provedor/modelo` | Selecionar modelo |
| `/key openrouter` | Salvar chave com entrada oculta |
| `/usage` ou `/cost` | Tokens, cache e custo |
| `/context` | Ocupação estimada da janela |
| `/compact` | Resumir a conversa, preservando o consumo acumulado |
| `/clear`, `/resume` | Nova sessão ou retomada |
| `/yolo`, `/ask`, `/plan` | Mudar modo |
| `/init`, `/memory` | Criar ou consultar instruções do projeto |
| `/todos`, `/bg`, `/mcp` | Tarefas, processos e servidores |
| `/undo`, `/redo` | Desfazer ou refazer as alterações de arquivo do último turno |
| `/export conversa.md` | Exportar sessão |
| `/exit` | Sair |

`Enter` envia; `Alt+Enter`, `Ctrl+J` ou `\` seguido de `Enter` insere linha. `Esc` interrompe o turno. `Shift+Tab` alterna o modo. `Ctrl+O` expande saídas. `Tab` completa comandos e arquivos. `!comando` executa no shell, `@arquivo` anexa conteúdo e `#nota` acrescenta uma instrução ao `SNAKE.md`.

## Scripts e automação

```bash
snake -p "Explique os scripts de package.json" --verbose
cat erro.log | snake -p "Identifique a causa deste erro"
snake -p "Resuma o projeto" --plan --json
snake -c -p "Continue a tarefa anterior"
snake -r ses_ID_DA_SESSAO -p "Continue"
snake --cwd /caminho/do/projeto -p "Execute os testes" --max-steps 20
```

Em `--json`, stdout contém um objeto com resultado, ferramentas, modelo, sessão e consumo acumulado da sessão. `costUSD: null` e `costUnknown: true` indicam preço incompleto; `knownCostUSD` contém a parte conhecida. `estimated` sinaliza estimativas de tokens. Erros retornam código 1; argumentos inválidos, código 2. `--ask` com `-p` retorna erro, pois não há interface para confirmar.

## Tokens, cache e custo

`input` conta entrada sem cache; o total de entrada é `input + cacheRead + cacheWrite`. `output` já inclui o raciocínio quando ele é informado como parte da saída: não some `reasoning` novamente.

O indicador “KV” mostra tokens de prefixo reaproveitados, conforme as métricas expostas pelo provedor. O Snake não mede memória de GPU nem inspeciona o KV cache interno do servidor. Zero pode significar ausência de cache ou ausência dessa informação. Quando a API não retorna uso, os tokens são estimados por caracteres e marcados com `~`.

O prompt de sistema permanece estável entre chamadas e o adaptador aplica marcações de cache aos provedores compatíveis. O comportamento efetivo depende do serviço, como explica a [documentação de cache do OpenRouter](https://openrouter.ai/docs/guides/best-practices/prompt-caching).

## Dados e limites

Configuração e sessões ficam em `~/.snake/`, ou no caminho definido por `SNAKE_HOME`. Chaves salvas ficam em `auth.json` com permissão `0600` em sistemas Unix. Sessões e arquivos anexados podem conter código privado: seu conteúdo é enviado ao modelo selecionado. O projeto não contém chaves de API.

Dentro de um repositório Git, `/undo` restaura todos os arquivos que mudaram no turno (inclusive pelo shell) a partir de um repositório Git sombra em `~/.snake/snapshots/`, sem tocar no índice nem nos commits do projeto; arquivos novos maiores que 2 MB ficam de fora. Fora de um repositório, cobre só o que `write`, `edit`, `multiedit` e `apply_patch` alteraram. Nenhum caso desfaz efeitos externos (Git, rede, MCP, bancos de dados). A busca sem ripgrep segue regras simples de `.gitignore` (sem negação `!`). A busca web depende da disponibilidade do DuckDuckGo. APIs que exigem exclusivamente Responses não são atendidas pelo adaptador Chat Completions.

## Desenvolvimento e GitHub

```bash
npm ci
npm run check
npm test
npm pack --dry-run
```

Os testes usam servidores locais simulados e não precisam de chave. A integração contínua está configurada para Node.js 20, 22 e 24. Não há etapa de compilação para usar o Snake.

Para publicar a cópia local já commitada, autentique o GitHub CLI e execute:

```bash
gh auth login
npm run github
```

O script cria `snake` como repositório privado e envia os commits. Para público: `npm run github -- snake public`. Ele não sobrescreve um remoto existente. A autenticação precisa estar disponível no ambiente em que o comando é executado.

Veja [PROJETO.md](PROJETO.md) para as decisões do projeto e [arquitetura](docs/ARQUITETURA.md) para manutenção. Logo, mascote e banner estão em `assets/`, em PNG e SVG; `npm run assets` regenera os SVGs e, com `cairosvg` ou `rsvg-convert` instalado, os PNGs. Licença [MIT](LICENSE).
