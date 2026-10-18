"""Configuração inicial no terminal."""
import json
import subprocess
import sys
import time

from . import config
from .audio import TAXA_MIC, DetectorNome, listar_microfones, normalizar
from .rede import url_com_token

PERSONALIDADES = [
    ("Ultron", "Inteligência artificial calma, segura e articulada, de fala grave e precisa, com ironia fria e "
               "frases de efeito ocasionais. Leal ao usuário, que é o seu criador; competente e direto, sem "
               "ameaças nem crueldade."),
    ("Parceiro direto", "Direto, educado e com humor leve. Fala como um parceiro de confiança, sem formalidade exagerada."),
    ("Mordomo britânico", "Formal, elegante e com ironia sutil, no estilo de um mordomo britânico muito competente."),
    ("Amigo descontraído", "Descontraído, animado e bem-humorado, usa gírias leves e trata o usuário como um amigo."),
    ("Técnico objetivo", "Seco, técnico e objetivo. Vai direto ao ponto com o mínimo de palavras, sem conversa fiada."),
]
AUTONOMIA = [
    ("alto", "Alto: age sozinho e só confirma o que for irreversível"),
    ("medio", "Médio: faz o comum sozinho e pede confirmação por voz antes de ações destrutivas"),
    ("baixo", "Baixo: pede confirmação por voz antes de qualquer comando"),
]

AZUL, CINZA, VERDE, VERM, NEG, FIM = "\033[38;5;75m", "\033[38;5;245m", "\033[38;5;114m", "\033[38;5;203m", "\033[1m", "\033[0m"


def titulo(t):
    print(f"\n{AZUL}{NEG}{t}{FIM}")


def perguntar(texto, padrao=""):
    extra = f" {CINZA}[{padrao}]{FIM}" if padrao else ""
    try:
        r = input(f"  {texto}{extra}: ").strip()
    except EOFError:
        r = ""
    return r or padrao


def escolher(texto, opcoes, padrao=1):
    for i, op in enumerate(opcoes, 1):
        print(f"   {AZUL}{i}{FIM}  {op}")
    while True:
        r = perguntar(texto, str(padrao))
        if r.isdigit() and 1 <= int(r) <= len(opcoes):
            return int(r) - 1
        print(f"  {VERM}Escolha um número de 1 a {len(opcoes)}.{FIM}")


def falar_com_base(cfg, mensagens, tempo=10):
    """Manda as mensagens e devolve a última resposta "config" (a base manda uma ao conectar
    e mais uma para cada config_get/config_set)."""
    from websockets.sync.client import connect

    esperadas = 1 + sum(1 for m in mensagens if m.get("t") in ("config_get", "config_set"))
    with connect(url_com_token(cfg["base"], cfg["token"]), open_timeout=8, max_size=None) as ws:
        for m in mensagens:
            ws.send(json.dumps(m))
        fim, vistas, ultima = time.time() + tempo, 0, None
        while vistas < esperadas and time.time() < fim:
            msg = ws.recv(timeout=max(0.1, fim - time.time()))
            if isinstance(msg, str):
                d = json.loads(msg)
                if d.get("t") == "config":
                    vistas, ultima = vistas + 1, d
        return ultima


def calibrar(nome, dispositivo):
    """Grava o usuário dizendo o nome e guarda como o reconhecedor local entende."""
    from vosk import KaldiRecognizer, Model, SetLogLevel

    SetLogLevel(-1)
    modelo = Model(config.MODELO_VOSK)
    ouvidos = []
    print(f"  Vou ouvir você dizer {NEG}{nome}{FIM} três vezes, uma por vez, com pausa entre elas.")
    for i in range(3):
        perguntar(f"Tentativa {i + 1}: aperte Enter e diga \"{nome}\"")
        rec = KaldiRecognizer(modelo, TAXA_MIC)
        cmd = ["parec", "--raw", "--format=s16le", f"--rate={TAXA_MIC}", "--channels=1"]
        if dispositivo:
            cmd.append(f"--device={dispositivo}")
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        texto, fim = "", time.time() + 4
        while time.time() < fim:
            if rec.AcceptWaveform(p.stdout.read(3200)):
                texto = json.loads(rec.Result()).get("text", "")
                if texto:
                    break
        p.kill()
        texto = texto or json.loads(rec.FinalResult()).get("text", "")
        print(f"    ouvi: {NEG}{texto or '(nada)'}{FIM}")
        if texto:
            ouvidos.append(texto)
    det = DetectorNome(nome)
    apelidos = sorted({normalizar(t).strip() for t in ouvidos if t and det.posicao(t) is None})
    acertos = sum(1 for t in ouvidos if det.posicao(t) is not None)
    print(f"  {VERDE}Reconheci o nome {acertos} de {len(ouvidos)} vezes direto.{FIM}", end=" ")
    if apelidos:
        print(f"Também vou aceitar: {', '.join(apelidos)}.")
    else:
        print()
    return apelidos


def rodar(base_padrao=None, token_padrao=None):
    cfg = config.carregar()
    print(f"\n{AZUL}{NEG}  Ultron  {FIM}{CINZA}  configuração{FIM}")
    print(f"  {CINZA}Enter aceita o valor entre colchetes.{FIM}")

    titulo("1. Base")
    persona = {}
    for tentativa in range(30):                  # a base local pode estar subindo (opencode)
        try:
            resp = falar_com_base(cfg, [{"t": "config_get"}])
            persona = (resp or {}).get("persona", {})
            print(f"  {VERDE}Base local encontrada.{FIM}")
            break
        except Exception as e:
            if tentativa == 0:
                print(f"  {CINZA}Esperando a base local subir...{FIM}")
            time.sleep(2)
    else:
        print(f"  {VERM}A base local não respondeu ({cfg['base']}). Veja: systemctl --user status ultron-base{FIM}")
        if perguntar("Continuar mesmo assim? (s/n)", "n").lower() != "s":
            sys.exit(1)

    titulo("2. Identidade")
    nome = perguntar("Nome pelo qual ele vai responder", cfg.get("nome") or persona.get("nome") or "Ultron")
    g = escolher("Gênero (define a voz)", ["Masculino", "Feminino"], 1 if persona.get("genero", "masculino") == "masculino" else 2)
    genero = ["masculino", "feminino"][g]
    usuario = perguntar("Como ele deve te chamar", persona.get("usuario") or "senhor")

    titulo("3. Personalidade")
    i = escolher("Personalidade", [f"{n}: {CINZA}{d}{FIM}" for n, d in PERSONALIDADES] + ["Escrever a minha"], 1)
    personalidade = PERSONALIDADES[i][1] if i < len(PERSONALIDADES) else perguntar("Descreva a personalidade")

    titulo("4. Autonomia")
    atual = [a for a, _ in AUTONOMIA].index(persona.get("autonomia", "alto")) + 1 if persona.get("autonomia") in ("alto", "medio", "baixo") else 1
    autonomia = AUTONOMIA[escolher("Nível de autonomia", [d for _, d in AUTONOMIA], atual)][0]

    titulo("5. Microfone")
    mics = listar_microfones()
    opcoes = ["Padrão do sistema"] + [d for _, d in mics]
    atual = 1 + next((k for k, (n, _) in enumerate(mics, 1) if n == cfg.get("microfone")), 0)
    j = escolher("Microfone", opcoes, atual)
    cfg["microfone"] = None if j == 0 else mics[j - 1][0]

    titulo("6. Calibrar o nome")
    if cfg.get("nome") != nome:
        cfg["apelidos"] = [] if nome.upper() != "ULTRON" else config.PADRAO["apelidos"]
    cfg["nome"] = nome
    if perguntar("Calibrar agora? Ajuda muito a reconhecer o nome com o seu sotaque (s/n)", "s").lower() == "s":
        try:
            cfg["apelidos"] = sorted(set(cfg.get("apelidos", [])) | set(calibrar(nome, cfg["microfone"])))
        except Exception as e:
            print(f"  {VERM}Calibração falhou: {e}{FIM}")

    nova = {"nome": nome, "genero": genero, "usuario": usuario, "personalidade": personalidade, "autonomia": autonomia}
    titulo("7. Salvando")
    try:
        falar_com_base(cfg, [{"t": "config_set", "persona": nova}])
        print(f"  {VERDE}Personalidade gravada na base.{FIM}")
    except Exception as e:
        print(f"  {VERM}Não consegui gravar na base: {e}{FIM}")
    cfg["configurado"] = True
    config.salvar(cfg)
    print(f"  {VERDE}Pronto.{FIM} Diga {NEG}\"{nome}\"{FIM} e faça o pedido na mesma frase, ou chame e espere o gadget acender.")
    print(f"  {CINZA}Clique no gadget para interromper ou chamar sem falar o nome. Botão direito abre as opções.{FIM}\n")
    return cfg
