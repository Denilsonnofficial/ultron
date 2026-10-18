#!/usr/bin/env bash
# Instalador de uma linha do Ultron:
#   curl -fsSL https://raw.githubusercontent.com/Denilsonnofficial/ultron/main/install.sh | bash
# (se o repositório voltar a ser privado: ULTRON_TOKEN_GITHUB=<token> para baixar)
# Baixa o projeto e roda o instalador; a configuração (nome, voz, personalidade) usa o terminal.
set -euo pipefail
REPO="${ULTRON_REPO:-Denilsonnofficial/ultron}"
RAMO="${ULTRON_RAMO:-main}"
TOKEN="${ULTRON_TOKEN_GITHUB:-${GITHUB_TOKEN:-}}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
if [ -n "${ULTRON_FONTE:-}" ]; then                 # teste: instala de uma pasta local
  cp -r "$ULTRON_FONTE"/. "$tmp/ultron"
else
  printf '\033[38;5;214m==>\033[0m Baixando o Ultron (%s)\n' "$REPO"
  if [ -n "$TOKEN" ]; then
    url="https://api.github.com/repos/$REPO/tarball/$RAMO"
    ok=$(curl -fsSL -H "Authorization: Bearer $TOKEN" "$url" -o "$tmp/ultron.tar.gz" && echo s || echo n)
  else
    url="https://codeload.github.com/$REPO/tar.gz/refs/heads/$RAMO"
    ok=$(curl -fsSL "$url" -o "$tmp/ultron.tar.gz" && echo s || echo n)
  fi
  if [ "$ok" != s ]; then
    printf '\033[38;5;203mErro:\033[0m não consegui baixar %s (sem internet, ou o repositório ficou privado:\n' "$REPO" >&2
    printf '      nesse caso rode com ULTRON_TOKEN_GITHUB=<token>).\n' >&2
    exit 1
  fi
  mkdir -p "$tmp/x" && tar -xzf "$tmp/ultron.tar.gz" -C "$tmp/x"
  mv "$tmp"/x/* "$tmp/ultron"
fi
unset TOKEN ULTRON_TOKEN_GITHUB GITHUB_TOKEN    # o resto da instalação não precisa do token
# com "curl | bash" a entrada é o pipe: a configuração lê do terminal de verdade
if [ -t 1 ] && [ -e /dev/tty ] && : < /dev/tty 2>/dev/null; then
  bash "$tmp/ultron/instalar.sh" "$@" < /dev/tty
else
  bash "$tmp/ultron/instalar.sh" --sem-configurar "$@"
fi
