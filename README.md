# Ultron

Assistente de voz **100% local** para Linux com GPU NVIDIA: ouve, acorda pelo nome, conversa
por voz e controla o computador, sem mandar nada para a internet. Fork do
[Jarvis](https://github.com/Denilsonnofficial/jarvis) e do [C3PO](https://github.com/Denilsonnofficial/c3po)
com o cérebro, a transcrição e a voz rodando na própria máquina, e o harness **snake** (embutido)
no lugar do opencode.

Estado: **1.0.0**. Feito e medido numa RTX 3060 12 GB + Xeon E5-2680 v3 + 32 GB.

## Instalar

```
curl -fsSL https://raw.githubusercontent.com/Denilsonnofficial/ultron/main/install.sh | bash
```

Ou `git clone` + `./instalar.sh`, ou o offline `run/ultron-<versão>.run`. Remover:
`./instalar.sh --remover` (memória e modelos ficam).

O instalador (usuário comum; sudo só para pacotes do sistema e para instalar o Ollama):

1. Confere a GPU NVIDIA e instala o que faltar: Node.js 20+ (para o snake), PortAudio, utilitários
   do PulseAudio/PipeWire, libnotify, Qt.
2. Instala o **Ollama** se não houver, baixa o **Qwen3.5 9B** (6,6 GB) e cria o `ultron-cerebro`
   (o mesmo modelo com janela de 16 mil tokens: o prompt do snake + ferramentas não cabe nos 4 mil
   padrão do Ollama; os pesos não são duplicados).
3. Ambiente Python próprio em `~/.local/share/ultron/venv` com faster-whisper + CUDA (cuBLAS/cuDNN
   do pip, não precisa do CUDA do sistema), Kokoro (onnx), Vosk, PySide6.
4. Baixa a voz Kokoro (350 MB), o reconhecedor do nome (Vosk, 31 MB) e o Whisper large-v3-turbo.
5. Cria a base (`ultron-base.service`, 127.0.0.1:8792), o gadget (`ultron.service`), o comando
   `ultron`, os atalhos **Ultron** e **Ultron Terminal**, e abre a configuração (nome, gênero,
   como te chamar, personalidade, autonomia, microfone, calibração do nome).

## Como funciona

```
microfone ─► Vosk (só o nome) ─► Whisper large-v3-turbo (GPU) ─► snake serve ─► Ollama (GPU)
                                                                     │ bash, arquivos, skills
gadget (holograma) ◄── Kokoro pm_alex/pf_dora (CPU) ◄── frases ◄──────┘
```

| Parte | Escolha | Medido no PC de referência |
|---|---|---|
| Modelo | Qwen3.5 9B (`reasoning_effort: none`) | 1ª palavra em 0,15 s; resposta curta em 1,8 s; com ferramenta (bash) ~10 s pelo snake; ~6 GB de VRAM |
| Transcrição | faster-whisper large-v3-turbo int8 na GPU | 6 s de fala em 0,33 s; ~0,8 GB de VRAM; acertou até "Ultron" |
| Voz | Kokoro-82M onnx, vozes pt-BR pm_alex (padrão), pm_santa, pf_dora | ~4x mais rápido que o tempo real na CPU |
| Harness | snake (embutido em `snake/`) | passou no `check-models` com o Qwen |

Escolhas e porquês:

- **Qwen3.5 9B em vez do Gemma 4 12B:** as duas são as indicações de 2026 para 12 GB; o Qwen é menor,
  sobra VRAM para o Whisper, chama ferramentas bem e, sem o modo de pensar, responde quase na hora.
  Pelo `/modelo` dá para usar qualquer outro do Ollama (`ollama pull` antes).
- **Pensar ou não:** o Qwen pensa ~5 s antes de responder por padrão. O Ultron manda
  `reasoning_effort: "none"` (pela API compatível com OpenAI do Ollama; `think: false` ali piorou
  para 48 s). O botão de raciocínio liga o pensamento: Padrão/Baixo = sem pensar, Médio = low,
  Alto = medium, Máximo = high (o snake reinicia em ~2 s ao trocar).
- **snake embutido** (`snake/`, cópia do Snake 0.3.0 com dois ajustes: o nível de esforço `none` e o
  envio do `reasoning_effort` para o Ollama). Roda como `snake serve` com configuração própria
  (`SNAKE_HOME=~/.local/share/ultron/dados/snake`), modo yolo e estilo de saída falado.
  Identidade, regras de voz, persona e memória vão no `AGENTS.md` da pasta de trabalho do snake,
  que ele recarrega quando muda; skills em `<trabalho>/.snake/skills`.
- **Pronúncia:** o Kokoro diz "Ultron" melhor como "Últron" (`voz.py: PRONUNCIA`).

## Uso

Igual ao Jarvis/C3PO: diga "Ultron" e o pedido; a conversa fica aberta até 20 s de silêncio; fale
por cima para interromper. Botões do gadget (aparecem com o mouse): microfone, foco, raciocínio,
tema, volume, base. No terminal, `ultron` abre o harness com `/modelo`, `/raciocinio`, `/foco`,
`/interromper`, `/tema`, `/volume`, `/skill`, `/memoria`, `/nome`, `/personalidade`...

```
ultron               num terminal: harness; fora dele: gadget
ultron gadget        o gadget
ultron configurar    refaz a configuração
ultron atualizar     baixa a versão nova do GitHub
ultron texto "..."   pergunta digitada
```

## Gadget

Tema padrão **Ultron (holograma)**: cabeça angular em malha de baixo polígono, azul, com olhos em
fenda que brilham com a voz, boca que abre ao falar, linhas de varredura, cintilação, falhas de
sinal e partículas; fica vermelho quando está pensando. Também traz os temas do Jarvis e do C3PO.
Desenhado à mão em Qt (nenhuma imagem do filme).

## Memória e agentes

Iguais ao Jarvis: perfil permanente, memória curta dinâmica (até 700 palavras, renovada a cada
12 trocas ou 5 min parado) e longo prazo em SQLite (`ultron-lembrar`). Skills internas para pôr
Claude Code, Codex e OpenCode da máquina para trabalhar em segundo plano (`ultron-agentes`).

## Estrutura

```
install.sh / instalar.sh   instalação (curl | bash / local)
ultron_base/               base: cerebro.py (cliente do snake serve), voz.py (Whisper + Kokoro), memória
ultron_cliente/            gadget, microfone e detector do nome, harness, configuração
snake/                     harness de agente embutido (Node.js 20+, sem dependências de execução)
bin/  skills/              ferramentas e skills internas
```
