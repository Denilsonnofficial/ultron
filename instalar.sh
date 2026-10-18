#!/usr/bin/env bash
# Instala o Ultron para o usuário atual: assistente de voz 100% local (GPU NVIDIA).
# uso: ./instalar.sh [--sem-configurar] [--remover]
set -euo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"
RAIZ="${XDG_DATA_HOME:-$HOME/.local/share}/ultron"
APP="$RAIZ/app"
DADOS="$RAIZ/dados"
BIN="$HOME/.local/bin"
UNIDADES="$HOME/.config/systemd/user"
VOSK_URL="https://alphacephei.com/vosk/models/vosk-model-small-pt-0.3.zip"
KOKORO_URL="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
MODELO_BASE="${ULTRON_MODELO_BASE:-qwen3.5:9b}"     # medido: 0,15 s até a 1ª palavra numa RTX 3060
PORTA="${ULTRON_PORTA:-8792}"
CONFIGURAR=1

passo() { printf '\033[38;5;75m==>\033[0m %s\n' "$*"; }
aviso() { printf '\033[38;5;245m    %s\033[0m\n' "$*"; }
erro() { printf '\033[38;5;203mErro:\033[0m %s\n' "$*" >&2; exit 1; }
tem() { command -v "$1" >/dev/null 2>&1; }
sudo_() { if [ "$(id -u)" = "0" ]; then sh -c "$*"; else sudo sh -c "$*"; fi; }

for a in "$@"; do
  case "$a" in
    --sem-configurar) CONFIGURAR=0 ;;
    --remover)
      passo "Removendo o Ultron"
      systemctl --user disable --now ultron.service ultron-base.service 2>/dev/null || true
      rm -f "$UNIDADES/ultron.service" "$UNIDADES/ultron-base.service" "$BIN/ultron" \
            "$HOME/.local/share/applications/ultron.desktop" "$HOME/.local/share/applications/ultron-terminal.desktop" \
            "$HOME/.config/environment.d/ultron.conf"
      systemctl --user daemon-reload 2>/dev/null || true
      printf '  A memória, os modelos de voz e as configurações ficaram em %s e ~/.config/ultron.\n' "$RAIZ"
      printf '  O modelo do Ollama continua instalado: ollama rm ultron-cerebro %s\n' "$MODELO_BASE"
      exit 0 ;;
    *) erro "opção desconhecida: $a" ;;
  esac
done

[ "$(uname -s)" = "Linux" ] || erro "o Ultron é para Linux"
[ "$(id -u)" != "0" ] || erro "rode como o seu usuário, não como root (o sudo é pedido quando precisar)"
if tem nvidia-smi && nvidia-smi >/dev/null 2>&1; then
  aviso "GPU: $(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | head -1)"
else
  aviso "sem GPU NVIDIA: o modelo e a transcrição vão rodar na CPU (bem mais lento)"
fi

# ---------------------------------------------------------------- dependências do sistema
falta=()
tem python3 || falta+=(python)
tem curl || falta+=(curl)
tem unzip || tem bsdtar || falta+=(unzip)
tem parec && tem pacat && tem pactl || falta+=(pulse)
python3 -c 'import ctypes.util,sys; sys.exit(0 if ctypes.util.find_library("portaudio") else 1)' 2>/dev/null || falta+=(portaudio)
python3 -c 'import venv, ensurepip' 2>/dev/null || falta+=(venv)
tem notify-send || falta+=(notify)
if ! tem node || [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 20 ]; then falta+=(node); fi

if [ ${#falta[@]} -gt 0 ]; then
  if tem apt-get; then
    declare -A P=([python]=python3 [curl]=curl [unzip]=unzip [pulse]=pulseaudio-utils [portaudio]=libportaudio2
                  [venv]="python3-venv python3-pip" [notify]=libnotify-bin [node]=nodejs)
    extra="libxcb-cursor0 libegl1 libxkbcommon-x11-0 libgl1"
    cmd="apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y"
  elif tem pacman; then
    declare -A P=([python]=python [curl]=curl [unzip]=unzip [pulse]=libpulse [portaudio]=portaudio
                  [venv]=python [notify]=libnotify [node]=nodejs)
    extra="xcb-util-cursor"
    cmd="pacman -S --needed --noconfirm"
  elif tem dnf; then
    declare -A P=([python]=python3 [curl]=curl [unzip]=unzip [pulse]=pulseaudio-utils [portaudio]=portaudio
                  [venv]=python3-pip [notify]=libnotify [node]=nodejs)
    extra="xcb-util-cursor"
    cmd="dnf install -y"
  elif tem zypper; then
    declare -A P=([python]=python3 [curl]=curl [unzip]=unzip [pulse]=pulseaudio-utils [portaudio]=portaudio
                  [venv]=python3-pip [notify]=libnotify-tools [node]=nodejs)
    extra="libxcb-cursor0"
    cmd="zypper install -y"
  else
    erro "instale: ${falta[*]} (não reconheci o gerenciador de pacotes)"
  fi
  pacotes=""
  for f in "${falta[@]}"; do pacotes="$pacotes ${P[$f]}"; done
  passo "Instalando dependências do sistema:$pacotes"
  aviso "vai pedir a sua senha (sudo)"
  sudo_ "$cmd $pacotes $extra" || sudo_ "$cmd $pacotes"
fi
tem node && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || erro "o snake precisa do Node.js 20 ou mais novo"

# ---------------------------------------------------------------- Ollama + modelo
if ! tem ollama; then
  passo "Instalando o Ollama (roda o modelo de linguagem na GPU)"
  curl -fsSL https://ollama.com/install.sh | sh
fi
if ! curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  sudo_ "systemctl enable --now ollama" 2>/dev/null || (nohup ollama serve >/dev/null 2>&1 &)
  for _ in $(seq 30); do curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && break; sleep 1; done
fi
curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1 || erro "o Ollama não respondeu em 127.0.0.1:11434"
if ! ollama list | grep -q "^${MODELO_BASE%%:*}:${MODELO_BASE##*:} "; then
  passo "Baixando o modelo $MODELO_BASE (uns 6,6 GB)"
  ollama pull "$MODELO_BASE"
fi
passo "Criando o modelo ultron-cerebro ($MODELO_BASE com janela de 16 mil tokens)"
tmpm="$(mktemp)"; printf 'FROM %s\nPARAMETER num_ctx 16384\n' "$MODELO_BASE" > "$tmpm"
ollama create ultron-cerebro -f "$tmpm" >/dev/null; rm -f "$tmpm"

# ---------------------------------------------------------------- ambiente python
passo "Ambiente Python em $RAIZ/venv"
mkdir -p "$RAIZ" "$DADOS" "$BIN"
[ -x "$RAIZ/venv/bin/python" ] || python3 -m venv --system-site-packages "$RAIZ/venv"
PY="$RAIZ/venv/bin/python"
"$PY" -m pip install -q --disable-pip-version-check --upgrade pip >/dev/null 2>&1 || true
passo "Pacotes de voz (Whisper na GPU, Kokoro) — alguns GB na primeira vez"
"$PY" -m pip install -q --disable-pip-version-check aiohttp websockets numpy vosk sounddevice \
  faster-whisper nvidia-cublas-cu12 nvidia-cudnn-cu12 kokoro-onnx
if ! "$PY" -c 'import PySide6.QtWidgets' 2>/dev/null; then
  passo "Instalando a interface (PySide6)"
  "$PY" -m pip install -q --disable-pip-version-check PySide6-Essentials
fi

# ---------------------------------------------------------------- programa
passo "Copiando o programa (com o harness snake embutido)"
rm -rf "$APP"; mkdir -p "$APP"
cp -r "$AQUI/ultron_base" "$AQUI/ultron_cliente" "$AQUI/bin" "$AQUI/skills" "$AQUI/snake" "$AQUI/prompt.md" "$AQUI/ultron.svg" "$APP/"
find "$APP" -name __pycache__ -prune -exec rm -rf {} +
chmod +x "$APP"/bin/* "$APP/snake/bin/snake.js"

# ---------------------------------------------------------------- modelos de voz
mkdir -p "$DADOS/modelos/kokoro"
for f in kokoro-v1.0.onnx voices-v1.0.bin; do
  if [ ! -s "$DADOS/modelos/kokoro/$f" ]; then
    passo "Baixando a voz local Kokoro ($f)"
    curl -fL --progress-bar -o "$DADOS/modelos/kokoro/$f.tmp" "$KOKORO_URL/$f" && mv "$DADOS/modelos/kokoro/$f.tmp" "$DADOS/modelos/kokoro/$f"
  fi
done
if [ ! -f "$DADOS/modelos/vosk-pt/final.mdl" ] && [ ! -f "$DADOS/modelos/vosk-pt/am/final.mdl" ]; then
  passo "Baixando o reconhecedor local do nome (Vosk PT, 31 MB)"
  mkdir -p "$DADOS/modelos"; tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/m.zip" "$VOSK_URL"
  (cd "$tmp" && (unzip -q m.zip || bsdtar -xf m.zip))
  rm -rf "$DADOS/modelos/vosk-pt"; mv "$tmp"/vosk-model-small-pt-* "$DADOS/modelos/vosk-pt"; rm -rf "$tmp"
fi
passo "Preparando a transcrição (Whisper large-v3-turbo, 1,6 GB na primeira vez)"
ULTRON_DADOS="$DADOS" PYTHONPATH="$APP" "$PY" -c 'from ultron_base.voz import Ouvido; o = Ouvido(); print("    transcrição na", o.dispositivo)' 2>&1 | grep -v -i "warning" || aviso "o Whisper termina de baixar na primeira vez que a base subir"

# ---------------------------------------------------------------- base local
[ -s "$DADOS/token" ] || "$PY" -c 'import secrets;print(secrets.token_urlsafe(24))' > "$DADOS/token"
chmod 600 "$DADOS/token"
cat > "$DADOS/base.env" <<ENV
ULTRON_TOKEN=$(cat "$DADOS/token")
ULTRON_DADOS=$DADOS
ULTRON_PORTA=$PORTA
ULTRON_NODE=$(command -v node)
PATH=$APP/bin:$BIN:/usr/local/bin:/usr/bin:/bin
PYTHONPATH=$APP
PYTHONUNBUFFERED=1
ENV
chmod 600 "$DADOS/base.env"

cat > "$BIN/ultron" <<SH
#!/bin/sh
export PYTHONPATH="$APP" ULTRON_DADOS="$DADOS"
exec "$PY" -m ultron_cliente "\$@"
SH
chmod +x "$BIN/ultron"

passo "Atalhos, ícone e início automático"
mkdir -p "$HOME/.local/share/applications" "$UNIDADES" "$HOME/.local/share/icons/hicolor/scalable/apps"
cp "$AQUI/ultron.svg" "$HOME/.local/share/icons/hicolor/scalable/apps/ultron.svg"
cat > "$HOME/.local/share/applications/ultron.desktop" <<DSK
[Desktop Entry]
Type=Application
Name=Ultron
Comment=Assistente de voz 100% local
Exec=$BIN/ultron gadget
Icon=$APP/ultron.svg
Terminal=false
Categories=Utility;
StartupNotify=false
DSK
cat > "$HOME/.local/share/applications/ultron-terminal.desktop" <<DSK
[Desktop Entry]
Type=Application
Name=Ultron Terminal
Comment=Conversa por texto e comandos (modelo, skills, persona)
Exec=$BIN/ultron terminal
Icon=$APP/ultron.svg
Terminal=false
Categories=Utility;
DSK
cat > "$UNIDADES/ultron-base.service" <<UNIT
[Unit]
Description=Ultron (base local: snake + Ollama, memória, voz)
After=network-online.target ollama.service

[Service]
EnvironmentFile=$DADOS/base.env
ExecStart=$PY -m ultron_base.servidor
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT
cat > "$UNIDADES/ultron.service" <<UNIT
[Unit]
Description=Ultron (gadget de voz)
PartOf=graphical-session.target
After=graphical-session.target ultron-base.service

[Service]
ExecStart=$BIN/ultron gadget
Restart=on-failure
RestartSec=5

[Install]
WantedBy=graphical-session.target
UNIT
if systemctl --user daemon-reload 2>/dev/null; then
  systemctl --user enable --now ultron-base.service >/dev/null 2>&1 && aviso "base local rodando (systemctl --user status ultron-base)"
  systemctl --user enable ultron.service >/dev/null 2>&1 && aviso "o gadget abre sozinho ao entrar na sessão"
else
  aviso "sem systemd de usuário: o comando ultron sobe a base quando precisar"
fi

for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
  [ -f "$rc" ] && ! grep -qs 'ultron: ~/.local/bin' "$rc" && printf '\nexport PATH="$HOME/.local/bin:$PATH"  # ultron: ~/.local/bin\n' >> "$rc"
done
mkdir -p "$HOME/.config/environment.d"
printf 'PATH=%s:${PATH}\n' "$BIN" > "$HOME/.config/environment.d/ultron.conf"

passo "Pronto. Comando: ultron   (num terminal abre o harness; fora dele, o gadget)"
if [ "$CONFIGURAR" = 1 ] && [ -t 0 ] && [ -t 1 ]; then
  exec "$BIN/ultron" configurar
elif [ "$CONFIGURAR" = 1 ]; then
  aviso "rode 'ultron configurar' num terminal para escolher nome, voz, personalidade e microfone"
fi
