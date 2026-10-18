#!/usr/bin/env bash
# Gera run/ultron-<versão>.run: instalador autoextraível (offline do código; baixa o resto).
set -euo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"
VER=$(sed -n 's/^VERSAO = "\(.*\)"/\1/p' "$AQUI/ultron_cliente/__main__.py")
SAIDA="$AQUI/run/ultron-$VER.run"
mkdir -p "$AQUI/run"
rm -f "$AQUI"/run/ultron-*.run
{
cat <<'HDR'
#!/bin/sh
# Instalador do Ultron. uso: sh ultron.run [--sem-configurar | --remover]
set -e
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
L=$(awk '/^__CARGA__$/{print NR+1; exit}' "$0")
tail -n +"$L" "$0" | tar -xz -C "$T"
bash "$T/instalar.sh" "$@"
exit $?
__CARGA__
HDR
tar -cz -C "$AQUI" --exclude=__pycache__ instalar.sh ultron.svg prompt.md ultron_base ultron_cliente bin skills snake
} > "$SAIDA"
chmod +x "$SAIDA"
echo "$SAIDA"
