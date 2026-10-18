import json
import os

PASTA = os.path.join(os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config")), "ultron")
ARQ = os.path.join(PASTA, "cliente.json")
DADOS = os.environ.get("ULTRON_DADOS", os.path.join(os.environ.get("XDG_DATA_HOME", os.path.expanduser("~/.local/share")), "ultron", "dados"))
MODELO_VOSK = os.path.join(DADOS, "modelos", "vosk-pt")

PADRAO = {
    "base": "ws://127.0.0.1:8792/ws",
    "token": "",
    "nome": "Ultron",
    # como o nome costuma ser falado e ouvido (a calibração acrescenta os da sua voz)
    "apelidos": ["ultrom", "ultron"],
    "sensibilidade": 0.78,   # 0..1, maior = exige pronúncia mais parecida
    "microfone": None,       # nome do dispositivo de entrada, None = padrão do sistema
    "mudo": False,
    "foco": False,           # botão de foco: escuta direto, sem precisar do nome
    "interromper_por_voz": True,   # falar por cima corta a voz dele (desligue para dois assistentes debaterem)
    "tempo_conversa": 20,    # s de silêncio até a conversa fechar e precisar do nome de novo
    "cancelar_eco": False,   # cancelador de eco do PipeWire: tira o eco, mas abafa você enquanto ela fala
    "posicao": None,
    "tema": "ultron",          # skin do gadget (botão de paleta)
    "volume": 1.0,           # volume da voz dela (0 a 1,5)          # skin do gadget (botão de paleta)
    "configurado": False,
}


def carregar():
    try:
        with open(ARQ, encoding="utf-8") as f:
            cfg = {**PADRAO, **json.load(f)}
    except (FileNotFoundError, json.JSONDecodeError):
        cfg = dict(PADRAO)
    if not cfg.get("token"):                 # a base local guarda o token aqui
        try:
            cfg["token"] = open(os.path.join(DADOS, "token")).read().strip()
        except OSError:
            pass
    return cfg


def salvar(cfg):
    os.makedirs(PASTA, exist_ok=True)
    tmp = ARQ + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, ARQ)
