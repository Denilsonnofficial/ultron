"""Base do Ultron: WebSocket que recebe fala, pensa com o snake (Ollama local) e devolve voz.

Protocolo (WebSocket /ws?token=...):
  cliente -> base   JSON {"t": "fala_inicio", "dica": "..."}  + frames binários PCM s16le 16 kHz + {"t": "fala_fim"}
                    JSON {"t": "texto", "texto": "..."}       pergunta digitada
                    JSON {"t": "parar"}                       interrompe a fala/ação atual
                    JSON {"t": "base", "ligada": bool}        liga/desliga a base
                    JSON {"t": "config_get"} / {"t": "config_set", "persona": {...}} / {"t": "saudar"}
  base -> cliente   JSON {"t": "estado", "valor": ocioso|ouvindo|pensando|agindo|falando|desligada, "detalhe": ...}
                    JSON {"t": "ouvi", "texto": ...} / {"t": "resposta", "texto": ...}
                    JSON {"t": "audio_inicio", "taxa": 24000} + frames binários PCM s16le 24 kHz + {"t": "audio_fim"}
                    JSON {"t": "escutar", "segundos": n}      depois de terminar de tocar, ouvir n s sem exigir o nome
                    JSON {"t": "config", "persona": {...}} / {"t": "erro", "msg": ...}
"""
import asyncio
import difflib
import json
import logging
import os
import re
import time
import unicodedata

import aiohttp
from aiohttp import WSMsgType, web

from .cerebro import Cerebro
from .memoria import DADOS, Memoria, fmt_ts
from .voz import Boca, Fatiador, Ouvido

log = logging.getLogger("base")

TOKEN = os.environ.get("ULTRON_TOKEN", "")
MODELO = os.environ.get("ULTRON_MODELO", "")          # vazio: escolhe sozinho entre os do Ollama local
# criado pelo instalador: qwen3.5:9b com janela de 16k (o prompt do snake + ferramentas não cabe nos 4k padrão)
MODELO_PADRAO = os.environ.get("ULTRON_MODELO_PADRAO", "ollama/ultron-cerebro")
WHISPER = os.environ.get("ULTRON_WHISPER", "large-v3-turbo")
STT = "whisper"                                     # tudo local
OCIOSO_SESSAO = int(os.environ.get("ULTRON_OCIOSO_SESSAO", "300"))   # s sem falar -> consolida e abre sessão nova
MAX_TURNOS_SESSAO = int(os.environ.get("ULTRON_MAX_TURNOS", "12"))   # sessão longa deixa o modelo lento
PALAVRAS_CURTA = int(os.environ.get("ULTRON_PALAVRAS_CURTA", "700"))
CONTINUACAO = int(os.environ.get("ULTRON_CONTINUACAO", "6"))

ARQ_PERSONA = os.path.join(DADOS, "persona.json")
ARQ_ESTADO = os.path.join(DADOS, "estado.json")
ARQ_MODELO = os.path.join(DADOS, "modelo.json")
PASTA_TRABALHO = os.environ.get("ULTRON_TRABALHO", os.path.join(DADOS, "trabalho"))
# skills do projeto ficam na pasta de trabalho do snake dele (.snake/skills): não mexem
# no snake que o usuário já usa
PASTA_SKILLS = os.path.join(PASTA_TRABALHO, ".snake", "skills")
PROMPT_VOZ = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "prompt.md")
SKILLS_INTERNAS = os.environ.get("ULTRON_SKILLS", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "skills"))


RACIOCINIO = ("padrao", "baixo", "medio", "alto", "maximo")
# nível -> esforço do snake (vira reasoning_effort no Ollama); padrão = sem pensar, para a voz sair rápida
ESFORCO_SNAKE = {"padrao": "none", "baixo": "none", "medio": "low", "alto": "medium", "maximo": "high"}
# para cada nível, as variantes do opencode em ordem de preferência
_VARIANTES = {"baixo": ("none", "minimal", "low"), "medio": ("medium", "low", "high"),
              "alto": ("high", "medium"), "maximo": ("max", "xhigh", "high")}
_DICA_RACIOCINIO = {
    "baixo": "Raciocínio no nível BAIXO: pense o mínimo possível e responda na hora.",
    "medio": "Raciocínio no nível MÉDIO: pense o suficiente, sem se alongar.",
    "alto": "Raciocínio no nível ALTO: pense com cuidado antes de responder ou agir.",
    "maximo": "Raciocínio no nível MÁXIMO: pense a fundo, confira hipóteses e o resultado antes de responder.",
}


def eh_gratis(modelo):
    return True                                       # tudo roda no Ollama local


def ordem_preferencia(modelos):
    """Modelos locais: o padrão primeiro, depois os outros do Ollama."""
    return sorted(modelos, key=lambda m: (m != MODELO_PADRAO, m))


def maquina_local():
    import getpass
    import platform

    distro = "Linux"
    try:
        for linha in open("/etc/os-release"):
            if linha.startswith("PRETTY_NAME="):
                distro = linha.split("=", 1)[1].strip().strip('"')
    except OSError:
        pass
    sessao = os.environ.get("XDG_CURRENT_DESKTOP", "") + " " + os.environ.get("XDG_SESSION_TYPE", "")
    return f"{platform.node()} ({distro}{', ' + sessao.strip() if sessao.strip() else ''}), usuário {getpass.getuser()}, home {os.path.expanduser('~')}"

PERSONA_PADRAO = {
    "nome": "Ultron",
    "genero": "masculino",
    "usuario": os.environ.get("USER", "criador").capitalize(),
    "personalidade": ("Inteligência artificial calma, segura e articulada, de fala grave e precisa, com ironia fria "
                      "e frases de efeito ocasionais. Leal ao usuário, que é o seu criador; competente e direto, "
                      "sem ameaças nem crueldade."),
    "autonomia": "alto",
}

DESTRUTIVO = re.compile(
    r"\b(rm|rmdir|shred|mkfs\S*|dd|wipefs|fdisk|parted|shutdown|reboot|poweroff|halt|kill|pkill|killall|"
    r"truncate|chmod|chown|mv|userdel|passwd|crontab)\b|"
    r"systemctl\s+(stop|disable|mask|restart|poweroff|reboot)|"
    r"docker\s+(rm|rmi|stop|kill|prune|system\s+prune|volume\s+rm|compose\s+down)|"
    r"git\s+(push|reset|clean|checkout\s+--)|\b(apt|apt-get|pacman|yay|pip|npm)\s+\S*(remove|purge|uninstall|-R)"
)
# pedido de parar a tarefa em andamento (curto e com a palavra logo no começo)
PARADA = re.compile(r"\b(para|pare|parar|cancela|cancele|cancelar|esquece|esqueca|chega|interrompe|aborta|stop)\b")

# frases que o whisper inventa em cima de silêncio ou ruído
ALUCINACAO = re.compile(r"^\W*(legenda\w*.*|.*amara\.org.*|inscreva-se.*|obrigad[oa]( por assistir)?|tchau)\W*$")
CATASTROFICO = re.compile(r"rm\s+-[a-z]*r[a-z]*f?\s+/(\s|$|\*)|mkfs|dd\s+.*of=/dev/(sd|nvme|vd)|:\(\)\s*\{|wipefs")


NUMEROS = {"0": "zero", "1": "um", "2": "dois", "3": "tres", "4": "quatro", "5": "cinco", "6": "seis",
           "7": "sete", "8": "oito", "9": "nove"}


def fonetico(s):
    s = re.sub(r"\d", lambda m: NUMEROS[m.group()], sem_acento(s))      # Ultron -> ctrespo
    s = re.sub(r"[^a-z]", "", s)
    for a, b in (("ph", "f"), ("ch", "x"), ("sh", "x"), ("lh", "li"), ("nh", "ni"), ("qu", "k"), ("gu", "g"),
                 ("aw", "au"), ("ew", "eu"), ("ow", "ou"),        # "raw" se fala "ráu"
                 ("w", "v"), ("y", "i"), ("z", "s"), ("c", "k"), ("h", ""), ("v", "b"), ("e", "i"), ("o", "u"), ("l", "u")):
        s = s.replace(a, b)
    return re.sub(r"(.)\1+", r"\1", s)


def parecido_em_sequencia(trecho, texto):
    """Quanto `trecho` se parece com algum pedaço contínuo de `texto` (0..1). O eco repete as
    palavras dela na mesma ordem, mesmo que mal reconhecidas; a fala do usuário não."""
    a = " ".join(re.findall(r"\w+", sem_acento(trecho)))
    pal = re.findall(r"\w+", sem_acento(texto))
    if not a or not pal:
        return 0.0
    n = max(1, len(a.split()))
    melhor = 0.0
    for tam in (n - 1, n, n + 1):
        if tam < 1:
            continue
        for i in range(0, max(1, len(pal) - tam + 1)):
            r = difflib.SequenceMatcher(None, a, " ".join(pal[i:i + tam])).ratio()
            melhor = max(melhor, r)
    return melhor


def sem_acento(s):
    return "".join(c for c in unicodedata.normalize("NFD", s.lower()) if unicodedata.category(c) != "Mn")


def ler_json(caminho, padrao):
    try:
        with open(caminho, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return padrao


def gravar_json(caminho, dados):
    tmp = caminho + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(dados, f, ensure_ascii=False, indent=2)
    os.replace(tmp, caminho)


DIAS = ["segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado", "domingo"]


class Agente:
    def __init__(self):
        self.memoria = Memoria()
        self.persona = {**PERSONA_PADRAO, **ler_json(ARQ_PERSONA, {})}
        est = ler_json(ARQ_ESTADO, {})
        self.sessao = est.get("sessao")
        self.pendentes = est.get("pendentes", [])
        self.ligada = est.get("ligada", True)
        self.turnos = 0
        self.ultimo_uso = time.time()
        self.cerebro = Cerebro(ler_json(ARQ_MODELO, {}).get("modelo") or MODELO or MODELO_PADRAO,
                               pasta_trabalho=PASTA_TRABALHO)
        self.boca = Boca(self.persona["genero"])
        self.ouvido = None
        self.raciocinio = ler_json(ARQ_MODELO, {}).get("raciocinio", "padrao")
        self.turno_tarefa = None
        self.turno_texto, self.turno_inicio, self.turno_falou = "", 0.0, False
        self.agindo = False      # executando ferramenta (não falando): fala nova entra na fila
        self.fila_pedidos = []
        self.falado = []         # (ts, frase) do que ela falou há pouco: filtro de eco
        self.http = None
        self.confirmacao = None
        self.clientes = set()
        self.tipos = {}          # id(ws) -> gadget | harness
        self.trava_consolidar = asyncio.Lock()

    # ---------- infraestrutura ----------
    async def iniciar(self):
        self.instalar_skills_internas()
        self.cerebro.esforco = ESFORCO_SNAKE.get(self.raciocinio, "none")
        await self.cerebro.iniciar()
        self.http = aiohttp.ClientSession()
        await self.escolher_modelo_inicial()
        try:
            loop = asyncio.get_running_loop()
            self.ouvido = await loop.run_in_executor(None, Ouvido, WHISPER)
        except Exception as e:
            log.error("whisper indisponível (%s); usando o texto do reconhecedor do nome", e)
        # sessão que sobrou da execução anterior vira memória
        if self.sessao:
            self.pendentes.append(self.sessao)
            self.sessao = None
        self.salvar_estado()
        asyncio.create_task(self.processar_pendentes())
        asyncio.create_task(self.vigia())
        asyncio.create_task(self.vigia_agentes())

    def salvar_estado(self):
        gravar_json(ARQ_ESTADO, {"sessao": self.sessao, "pendentes": self.pendentes, "ligada": self.ligada})

    async def escolher_modelo_inicial(self):
        """Usa o modelo salvo se ainda existe; senão o MiMo grátis; senão outro grátis."""
        disponiveis = await self.cerebro.listar_modelos()
        salvo = ler_json(ARQ_MODELO, {}).get("modelo") or MODELO
        if salvo and salvo in disponiveis:
            self.cerebro.definir_modelo(salvo)
        else:
            pref = ordem_preferencia(disponiveis)
            if pref:
                self.cerebro.definir_modelo(pref[0])
                log.info("modelo escolhido: %s", pref[0])
        self.modelos_falhos = set()

    async def modelo_reserva(self):
        """Depois de uma falha do modelo, passa para o próximo grátis (MiMo primeiro)."""
        self.modelos_falhos.add(self.cerebro.nome_modelo)
        for m in ordem_preferencia(await self.cerebro.listar_modelos()):
            if m not in self.modelos_falhos:
                log.warning("modelo %s falhou; usando %s", self.cerebro.nome_modelo, m)
                self.cerebro.definir_modelo(m)
                gravar_json(ARQ_MODELO, {**ler_json(ARQ_MODELO, {}), "modelo": m})
                return m
        return None

    async def enviar_todos(self, msg):
        for ws in list(self.clientes):
            try:
                await ws.send_json(msg)
            except Exception:
                pass

    async def estado(self, valor, detalhe=""):
        await self.enviar_todos({"t": "estado", "valor": valor, "detalhe": detalhe})

    # ---------- prompt ----------
    def system(self):
        """Vai para o AGENTS.md da pasta de trabalho do snake: regras de voz + persona + memória."""
        try:
            voz = open(PROMPT_VOZ, encoding="utf-8").read().strip()
        except OSError:
            voz = ""
        return voz + "\n\n" + self._system_persona()

    def _system_persona(self):
        p = self.persona
        agora = time.localtime()
        autonomia = {
            "alto": "ALTO. Aja sozinho: execute comandos, corrija e verifique sem pedir licença. Só confirme antes de algo irreversível que o usuário não pediu explicitamente.",
            "medio": "MÉDIO. Consultas e ações comuns você faz direto; comandos destrutivos passam por confirmação por voz (o sistema pergunta sozinho).",
            "baixo": "BAIXO. Todo comando passa por confirmação por voz do usuário (o sistema pergunta sozinho). Prefira explicar e sugerir.",
        }.get(p.get("autonomia"), "ALTO")
        n, primeiro = self.memoria.total()
        desde = f"desde {fmt_ts(primeiro)[:10]}" if primeiro else "a partir de hoje"
        return f"""# Identidade
Seu nome é {p['nome']}. Gênero: {p['genero']} (use a concordância de gênero certa ao falar de si).
Você conversa por VOZ com {p['usuario']}. Personalidade: {p['personalidade']}

# Agora
{DIAS[agora.tm_wday]}, {time.strftime('%d/%m/%Y %H:%M', agora)}.

# Autonomia
{autonomia}

# Máquina
Você roda direto neste computador e o seu bash é o do usuário: {maquina_local()}.

# Perfil permanente (fatos que nunca saem)
{self.memoria.perfil() or '(vazio)'}

# Memória de curto prazo (o que aconteceu recentemente)
{self.memoria.curta() or '(ainda vazia: é o começo da convivência)'}

# Seu modelo
Você está rodando no modelo `{self.cerebro.nome_modelo}`, local, no Ollama desta máquina (pelo harness snake). Nada sai para a internet. Se perguntarem qual modelo você é, diga esse nome de forma falada.
Para trocar quando o usuário pedir: `ultron-modelo` mostra o atual e os instalados no Ollama, e `ultron-modelo trocar <nome ou pedaço do nome>` troca. O nome falado pode vir aproximado: escolha o mais parecido. Para um modelo novo, `ollama pull <nome>` antes (avise que demora e ocupa disco). A troca vale a partir da próxima fala; confirme dizendo para qual modelo trocou. Nível de raciocínio (quando o usuário pedir para pensar mais ou menos): `ultron-modelo raciocinio baixo|medio|alto|maximo|padrao`.

# Raciocínio
{_DICA_RACIOCINIO.get(self.raciocinio, "Pense pouco: é uma conversa por voz e precisa ser rápida.")}

# Memória de longo prazo
Há {n} falas guardadas {desde}. Se precisar de algo antigo que não está acima, rode `ultron-lembrar "palavras"` ou `ultron-lembrar --dia AAAA-MM-DD`.
Fato duradouro novo sobre o usuário (preferência, nome de alguém, rotina): grave com `ultron-anotar "fato"`.
"""

    # ---------- sessões e memória ----------
    async def garantir_sessao(self):
        if self.sessao and (time.time() - self.ultimo_uso > OCIOSO_SESSAO or self.turnos >= MAX_TURNOS_SESSAO):
            self.girar_sessao()
        if not self.sessao:
            self.sessao = await self.cerebro.nova_sessao(f"{self.persona['nome']} {time.strftime('%d/%m %H:%M')}")
            self.turnos = 0
            self.salvar_estado()
        return self.sessao

    def girar_sessao(self):
        if self.sessao:
            self.pendentes.append(self.sessao)
            self.sessao = None
            self.salvar_estado()
            asyncio.create_task(self.processar_pendentes())

    async def processar_pendentes(self):
        async with self.trava_consolidar:
            while self.pendentes:
                sid = self.pendentes[0]
                try:
                    await self.consolidar(sid)
                except Exception as e:
                    log.warning("consolidação de %s falhou: %s (tento de novo depois)", sid, e)
                    return
                self.pendentes.pop(0)
                self.salvar_estado()

    async def consolidar(self, sid):
        turnos = self.memoria.turnos_da_sessao(sid)
        if not turnos:
            return
        conversa = "\n".join(f"[{fmt_ts(ts)}] {quem}: {texto}" for ts, quem, texto in turnos)
        atual = self.memoria.curta() or "(vazia)"
        pedido = f"""Você mantém a MEMÓRIA DE CURTO PRAZO de {self.persona['nome']}, assistente de voz de {self.persona['usuario']}.
Ela é lida no começo de toda conversa, então precisa ser curta, atual e útil.
Hoje é {time.strftime('%d/%m/%Y %H:%M')}.

MEMÓRIA ATUAL:
{atual}

CONVERSA QUE ACABOU DE TERMINAR:
{conversa}

Reescreva a memória inteira incorporando a conversa nova. Regras:
- No máximo {PALAVRAS_CURTA} palavras, em markdown, com estas seções:
  ## Em andamento (tarefas, pedidos e problemas abertos)
  ## Fatos recentes (o que foi feito, decidido ou descoberto, com data)
  ## Jeito do usuário (preferências percebidas)
  ## Linha do tempo (uma linha por dia, mais recente primeiro)
- O que é mais recente e ainda importa fica; o que é velho, resolvido ou trivial sai (continua guardado na memória de longo prazo).
- Escreva datas absolutas (dd/mm), nunca "ontem" ou "hoje".
- Não invente nada. Não use ferramentas nem rode comandos: só escreva. Responda SOMENTE com o markdown da memória."""
        texto = await self.cerebro.completar(pedido, titulo="consolidar memória")
        texto = re.sub(r"^```\w*\n|\n```$", "", texto.strip())
        if len(texto) < 40:
            raise RuntimeError("resumo vazio")
        self.memoria.salvar_curta(texto)
        log.info("memória de curto prazo atualizada (%d palavras)", len(texto.split()))

    async def vigia(self):
        while True:
            await asyncio.sleep(60)
            ocupado = self.turno_tarefa and not self.turno_tarefa.done()
            if self.sessao and not ocupado and time.time() - self.ultimo_uso > OCIOSO_SESSAO:
                self.girar_sessao()
            if self.pendentes and not self.trava_consolidar.locked():
                asyncio.create_task(self.processar_pendentes())

    # ---------- conversa ----------
    def nome_confirmado(self, texto, dica, apelidos):
        """Segunda conferência do nome (a primeira foi o detector do PC). Nome curto o Google
        costuma comer ou trocar ("raw" vira "How"): aí vale a detecção local."""
        if len(fonetico(self.persona["nome"])) <= 4:
            return True
        return any(self.nome_presente(t, n) for t in (texto, dica) for n in [self.persona["nome"], *apelidos])

    def nome_presente(self, texto, nome=None):
        alvo = fonetico(nome or self.persona["nome"])
        if not alvo:
            return False
        pal = re.sub(r"\d", lambda m: f" {NUMEROS[m.group()]} ", sem_acento(texto)).replace("-", " ").split()
        for i in range(len(pal)):
            for k in (1, 2, 3, 4):
                cand = fonetico("".join(pal[i:i + k]))
                if len(cand) >= 3 and difflib.SequenceMatcher(None, cand, alvo).ratio() >= 0.75:
                    return True
        return False

    async def ao_falar(self, ws, pcm, dica, origem="nome", apelidos=()):
        if not self.ligada:
            return
        ocupado = self.turno_tarefa and not self.turno_tarefa.done()
        if not ocupado:
            await self.estado("pensando", "transcrevendo")
        t0 = time.time()
        texto, motor = None, "whisper"
        if texto is None:
            motor = "whisper"
            loop = asyncio.get_running_loop()
            if self.ouvido:
                texto = await loop.run_in_executor(None, self.ouvido.transcrever, pcm, self.persona["nome"])
            else:
                motor, texto = "vosk", dica or ""      # sem Google e sem whisper: o texto do PC
        log.info("STT %s %.1fs (%.1fs de áudio, %s): %r", motor, time.time() - t0, len(pcm) / 32000, origem, texto)
        if origem != "interrupcao" and self.eco(texto):
            log.info("é a própria voz voltando pelo microfone, ignorando")
            await ws.send_json({"t": "ouvi", "texto": texto, "ignorado": True, "motivo": "eco"})
            if not ocupado:
                await self.estado("ocioso")
            return
        if not texto.strip():
            await ws.send_json({"t": "ouvi", "texto": "", "ignorado": True, "motivo": "vazio"})
            if not ocupado:
                await self.estado("ocioso")
            return
        if origem == "nome" and not self.nome_confirmado(texto, dica, apelidos) and not self.confirmacao:
            # o detector local se enganou; o whisper é quem confirma o nome
            log.info("nome não confirmado na transcrição, ignorando")
            await ws.send_json({"t": "ouvi", "texto": texto, "ignorado": True, "motivo": "sem_nome"})
            if not ocupado:
                await self.estado("ocioso")
            return
        await ws.send_json({"t": "ouvi", "texto": texto})
        await self.ao_texto(ws, texto)

    async def ao_texto(self, ws, texto):
        texto = (texto or "").strip()
        if self.confirmacao and not self.confirmacao.done():
            self.confirmacao.set_result(texto)
            return
        if not self.ligada:
            return
        # "só um instante" é o aviso de demora do outro assistente na sala, não um pedido
        if (not re.search(r"\w", texto) or ALUCINACAO.search(sem_acento(texto))
                or re.fullmatch(r"\W*(so )?um instante\W*", sem_acento(texto))):
            await self.estado("ocioso")
            return
        t = self.turno_tarefa
        if t and not t.done() and self.agindo:
            pal = sem_acento(texto).split()
            if len(pal) <= 6 and PARADA.search(" ".join(pal[:3])):
                log.info("pediu para parar a tarefa: %r", texto)
                self.fila_pedidos.clear()
            else:
                # está trabalhando: não joga fora o trabalho, faz depois
                log.info("ocupada com uma tarefa, pedido na fila: %r", texto)
                self.fila_pedidos.append(texto)
                if self.sessao:
                    self.memoria.registrar(self.sessao, "usuario", texto)
                return
        if t and not t.done() and time.time() - self.turno_inicio < 15:
            anterior = sem_acento(self.turno_texto).split()
            novo = sem_acento(texto).split()
            if " ".join(novo) in " ".join(anterior):
                log.info("pedaço repetido de uma fala já mandada, ignorando: %r", texto)
                return
            if not self.turno_falou or time.time() - self.turno_inicio < 6:
                # continuou a frase depois de uma pausa: junta, tirando o trecho que se repete
                sobra = 0
                for k in range(min(len(anterior), len(novo)), 0, -1):
                    if anterior[-k:] == novo[:k]:
                        sobra = k
                        break
                texto = " ".join([self.turno_texto, *texto.split()[sobra:]])
                log.info("juntando com a fala anterior: %r", texto)
        await self.interromper()
        self.turno_tarefa = asyncio.create_task(self.turno(ws, texto))

    def eco(self, texto):
        agora = time.time()
        self.falado = [(ts, f) for ts, f in self.falado if agora - ts < 45]
        if len(re.findall(r"\w+", texto)) < 2 or not self.falado:
            return False
        return parecido_em_sequencia(texto, " ".join(f for _, f in self.falado)) >= 0.72

    async def interromper(self):
        t = self.turno_tarefa
        if t and not t.done():
            t.cancel()
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass

    async def turno(self, ws, texto, registrar=True):
        sid = await self.garantir_sessao()
        self.turno_texto, self.turno_inicio, self.turno_falou = texto, time.time(), False
        if registrar:
            self.memoria.registrar(sid, "usuario", texto)
        await self.estado("pensando")
        fala = asyncio.Queue()
        falador = asyncio.create_task(self.falador(ws, fala))
        aviso = asyncio.create_task(self._avisar_demora(fala))
        fat = Fatiador()
        resposta = []
        t0 = time.time()
        primeira = None
        tentou_reserva = False
        try:
          while True:
            refazer = False
            async for ev in self.cerebro.perguntar(sid, texto, system=self.system(), variante=await self.variante_atual()):
                if ev[0] == "texto":
                    self.agindo = False
                    if primeira is None:
                        primeira = time.time() - t0
                    resposta.append(ev[1])
                    for f in fat.alimentar(ev[1]):
                        await fala.put(f)
                elif ev[0] == "ferramenta":
                    _, nome, status, titulo = ev
                    if status == "running":
                        self.agindo = True
                        for f in fat.resto():
                            await fala.put(f)
                        await fala.put({"t": "estado", "valor": "agindo", "detalhe": titulo or nome})
                elif ev[0] == "permissao":
                    ok = await self.decidir_permissao(ev[1], fala)
                    await self.cerebro.responder_permissao(ev[1]["id"], ok)
                elif ev[0] == "erro":
                    log.warning("erro do modelo: %s", ev[1])
                    if not resposta and not tentou_reserva and await self.modelo_reserva():
                        tentou_reserva = True      # tenta de novo, uma vez, com outro grátis
                        refazer = True
                        break
                    if not resposta:
                        msg = "Desculpe, o modelo falhou agora. Tenta de novo em instantes."
                        resposta.append(msg)
                        await fala.put(msg)
            if refazer:
                await self.cerebro.abortar(sid)
                continue
            for f in fat.resto():
                await fala.put(f)
            await fala.put({"t": "escutar", "segundos": CONTINUACAO})
            break
        except asyncio.CancelledError:
            self.agindo = False
            await asyncio.shield(self.cerebro.abortar(sid))
            falador.cancel()
            await ws.send_json({"t": "audio_fim", "cortado": True})
            raise
        finally:
            aviso.cancel()
            await fala.put(None)
            final = "".join(resposta).strip()
            if final:
                self.memoria.registrar(sid, "assistente", final)
            self.turnos += 1
            self.ultimo_uso = time.time()
            log.info("turno em %.1fs (primeira palavra %.1fs): %r", time.time() - t0, primeira or -1, final[:200])
        try:
            await falador
        except asyncio.CancelledError:
            pass
        self.agindo = False
        await ws.send_json({"t": "resposta", "texto": "".join(resposta).strip()})
        if self.fila_pedidos:
            pedidos, self.fila_pedidos = " ".join(self.fila_pedidos), []
            self.turno_tarefa = asyncio.create_task(self.turno(
                ws, f"(o usuário disse isto enquanto você trabalhava) {pedidos}", registrar=False))

    async def _avisar_demora(self, fala, segundos=12):
        """Se a primeira palavra demora, avisa uma vez em vez de ficar em silêncio."""
        await asyncio.sleep(segundos)
        if not self.turno_falou:
            await fala.put("Só um instante.")

    async def falador(self, ws, fila):
        """Fala as frases em ordem, mas já sintetiza as próximas (até 3) enquanto a atual toca:
        sintetizar uma por vez deixava um buraco de 0,5-1,5 s entre frases, que soava como corte
        e fazia quem estava ouvindo achar que ela tinha terminado."""
        ordem = asyncio.Queue()
        vagas = asyncio.Semaphore(3)
        tarefas = []

        async def sintetizar(texto, saida):
            try:
                async for bloco in self.boca.falar(texto):
                    await saida.put(bloco)
            except Exception as e:
                log.warning("voz falhou numa frase: %s", e)
            finally:
                await saida.put(None)
                vagas.release()

        async def produzir():
            while True:
                item = await fila.get()
                if item is None or isinstance(item, dict):
                    await ordem.put(item)
                    if item is None:
                        return
                    continue
                await vagas.acquire()
                saida = asyncio.Queue()
                tarefas.append(asyncio.create_task(sintetizar(item, saida)))
                await ordem.put((item, saida))

        produtor = asyncio.create_task(produzir())
        iniciou = False
        try:
            while True:
                item = await ordem.get()
                if item is None:
                    break
                if isinstance(item, dict):
                    if item.get("t") == "estado":
                        await self.estado(item["valor"], item.get("detalhe", ""))
                    else:
                        if iniciou:
                            await ws.send_json({"t": "audio_fim"})
                            iniciou = False
                        await ws.send_json(item)
                    continue
                texto, saida = item
                if not iniciou:
                    await ws.send_json({"t": "audio_inicio", "taxa": 24000})
                    await self.estado("falando")
                    iniciou = True
                self.turno_falou = True
                self.falado.append((time.time(), texto))
                await ws.send_json({"t": "frase", "texto": texto})
                while True:
                    bloco = await saida.get()
                    if bloco is None:
                        break
                    await ws.send_bytes(bloco)
        finally:
            produtor.cancel()
            for t in tarefas:
                t.cancel()
            if iniciou:
                try:
                    await ws.send_json({"t": "audio_fim"})
                except Exception:
                    pass
            await self.estado("ocioso")

    async def decidir_permissao(self, props, fala):
        perm = props.get("permission") or props.get("action") or ""
        alvo = " ".join(props.get("patterns") or props.get("resources") or [])
        meta = props.get("metadata") or {}
        comando = meta.get("command") or alvo
        if CATASTROFICO.search(comando):
            log.warning("comando catastrófico bloqueado: %s", comando)
            return False
        aut = self.persona.get("autonomia", "alto")
        if perm != "bash" or aut == "alto" or (aut == "medio" and not DESTRUTIVO.search(comando)):
            return True
        resumo = meta.get("description") or comando[:120]
        loop = asyncio.get_running_loop()
        self.confirmacao = loop.create_future()
        await fala.put(f"Preciso da sua confirmação. Vou executar: {resumo}. Posso?")
        await fala.put({"t": "escutar", "segundos": 12})
        try:
            resp = await asyncio.wait_for(self.confirmacao, 40)
        except asyncio.TimeoutError:
            resp = ""
        finally:
            self.confirmacao = None
        r = sem_acento(resp)
        ok = bool(re.search(r"\b(sim|pode|claro|manda|vai|ok|okay|confirmo|isso|positivo|faz|faca|bora)\b", r)) and not re.search(
            r"\b(nao|para|cancela|negativo|espera)\b", r)
        await self.estado("agindo" if ok else "pensando")
        return ok

    # ---------- modelos e skills ----------
    async def variante_atual(self):
        return None                    # no Ultron o nível vira o esforço do snake (definir_raciocinio)

    async def info_raciocinio(self):
        return {"t": "raciocinio", "nivel": self.raciocinio, "variante": ESFORCO_SNAKE[self.raciocinio],
                "aceitas": list(dict.fromkeys(ESFORCO_SNAKE.values()))}

    def definir_raciocinio(self, nivel):
        if nivel not in RACIOCINIO:
            raise ValueError(f"nível de raciocínio desconhecido: {nivel}")
        self.raciocinio = nivel
        asyncio.create_task(self.cerebro.definir_esforco(ESFORCO_SNAKE[nivel]))
        dados = ler_json(ARQ_MODELO, {})
        dados["raciocinio"] = nivel
        dados.setdefault("modelo", self.cerebro.nome_modelo)
        gravar_json(ARQ_MODELO, dados)
        log.info("raciocínio: %s", nivel)

    async def modelos(self):
        lista = await self.cerebro.listar_modelos()
        return {"t": "modelos", "atual": self.cerebro.nome_modelo,
                "disponiveis": [{"id": m, "gratis": eh_gratis(m)} for m in lista]}

    async def trocar_modelo(self, novo):
        lista = await self.cerebro.listar_modelos()
        if novo not in lista:
            raise ValueError(f"modelo desconhecido: {novo}")
        anterior = self.cerebro.nome_modelo
        self.cerebro.definir_modelo(novo)
        gravar_json(ARQ_MODELO, {**ler_json(ARQ_MODELO, {}), "modelo": novo})
        log.info("modelo trocado: %s -> %s", anterior, novo)

    def skills(self):
        saida = []
        if os.path.isdir(PASTA_SKILLS):
            for nome in sorted(os.listdir(PASTA_SKILLS)):
                arq = os.path.join(PASTA_SKILLS, nome, "SKILL.md")
                if os.path.isfile(arq):
                    texto = open(arq, encoding="utf-8").read()
                    m = re.search(r"^description:\s*(.+)$", texto, re.M)
                    corpo = texto.split("---", 2)[-1].strip()
                    saida.append({"nome": nome, "descricao": m.group(1).strip() if m else "", "instrucoes": corpo,
                                  "interna": os.path.isdir(os.path.join(SKILLS_INTERNAS, nome))})
        return {"t": "skills", "lista": saida}

    def instalar_skills_internas(self):
        """Skills que vêm com o projeto (base/skills): reinstaladas a cada partida."""
        import shutil

        origem = os.path.normpath(SKILLS_INTERNAS)
        if not os.path.isdir(origem):
            return
        os.makedirs(PASTA_SKILLS, exist_ok=True)
        for nome in os.listdir(origem):
            destino = os.path.join(PASTA_SKILLS, nome)
            shutil.rmtree(destino, ignore_errors=True)
            shutil.copytree(os.path.join(origem, nome), destino)
        log.info("skills internas instaladas: %s", ", ".join(sorted(os.listdir(origem))))

    async def vigia_agentes(self):
        """Quando um trabalho do Claude Code/Codex/OpenCode termina, ela confere e avisa por voz."""
        pasta = os.path.join(DADOS, "agentes")
        while True:
            await asyncio.sleep(45)
            if not os.path.isdir(pasta) or not self.ligada:
                continue
            for nome in sorted(os.listdir(pasta)):
                caminho = os.path.join(pasta, nome)
                try:
                    t = json.load(open(caminho))
                except (OSError, ValueError):
                    continue
                if t.get("avisado"):
                    continue
                try:
                    os.kill(int(t["pid"]), 0)
                    continue                    # ainda rodando
                except ProcessLookupError:
                    pass
                except (PermissionError, ValueError):
                    continue
                ocupado = self.turno_tarefa and not self.turno_tarefa.done()
                if ocupado or not self.clientes:
                    continue                    # avisa na próxima volta
                t["avisado"] = True
                gravar_json(caminho, t)
                # avisa pela esfera (que fala em voz alta); o harness só se não houver gadget
                ws = next((c for c in self.clientes if self.tipos.get(id(c)) == "gadget"),
                          next(iter(self.clientes)))
                log.info("trabalho %s terminou; avisando", t["id"])
                self.turno_tarefa = asyncio.create_task(self.turno(
                    ws, f"(aviso do sistema: o trabalho {t['id']} ({t['harness']}) terminou. "
                        f"Confira com `ultron-agentes ver {t['id']} 60` e `ultron-agentes mudancas {t['id']}`, "
                        f"e conte ao usuário em duas ou três frases o resultado e qualquer problema.)",
                    registrar=False))

    async def recarregar_opencode(self):
        """O snake procura as skills a cada turno; não precisa recarregar."""

    async def salvar_skill(self, nome, descricao, instrucoes):
        nome = re.sub(r"[^a-z0-9-]+", "-", sem_acento(nome)).strip("-")[:60]
        if not nome or not descricao.strip() or not instrucoes.strip():
            raise ValueError("skill precisa de nome, descrição e instruções")
        pasta = os.path.join(PASTA_SKILLS, nome)
        os.makedirs(pasta, exist_ok=True)
        desc = " ".join(descricao.split())
        with open(os.path.join(pasta, "SKILL.md"), "w", encoding="utf-8") as f:
            f.write(f"---\nname: {nome}\ndescription: {desc}\n---\n\n{instrucoes.strip()}\n")
        asyncio.create_task(self.recarregar_opencode())
        log.info("skill salva: %s", nome)

    async def remover_skill(self, nome):
        import shutil

        pasta = os.path.join(PASTA_SKILLS, os.path.basename(nome))
        if not os.path.isdir(pasta):
            raise ValueError(f"skill não existe: {nome}")
        if os.path.isdir(os.path.join(SKILLS_INTERNAS, os.path.basename(nome))):
            raise ValueError(f"{nome} é uma skill interna do Ultron (vem com o projeto); não dá para remover")
        shutil.rmtree(pasta)
        asyncio.create_task(self.recarregar_opencode())

    def memoria_info(self):
        n, primeiro = self.memoria.total()
        return {"t": "memoria", "perfil": self.memoria.perfil(), "curta": self.memoria.curta(),
                "falas": n, "desde": fmt_ts(primeiro) if primeiro else None}

    # ---------- comandos do cliente ----------
    async def ligar(self, ligada):
        self.ligada = ligada
        self.salvar_estado()
        if not ligada:
            await self.interromper()
            self.girar_sessao()
            await self.estado("desligada")
        else:
            await self.estado("ocioso")

    async def configurar(self, nova):
        permitidos = {"nome", "genero", "usuario", "personalidade", "autonomia"}
        self.persona.update({k: v for k, v in nova.items() if k in permitidos and v})
        gravar_json(ARQ_PERSONA, self.persona)
        self.boca.definir_genero(self.persona["genero"])
        if not self.memoria.perfil():
            self.memoria.anotar_perfil(f"O usuário se chama {self.persona['usuario']}.")
        self.girar_sessao()  # personalidade nova vale a partir da próxima fala


AGENTE: Agente = None


async def rota_ws(req):
    tok = req.query.get("token") or req.headers.get("X-Ultron-Token", "")
    if TOKEN and tok != TOKEN:
        return web.Response(status=401, text="token inválido")
    ws = web.WebSocketResponse(heartbeat=20, max_msg_size=64 * 1024 * 1024)
    await ws.prepare(req)
    ag = AGENTE
    ag.tipos[id(ws)] = req.query.get("cliente", "gadget")
    ag.clientes.add(ws)
    log.info("cliente conectado: %s", req.remote)
    await ws.send_json({"t": "config", "persona": ag.persona, "ligada": ag.ligada})
    await ws.send_json({"t": "estado", "valor": "ocioso" if ag.ligada else "desligada"})
    await ws.send_json(await ag.info_raciocinio())
    audio = bytearray()
    dica, origem, apelidos = "", "nome", []
    try:
        async for msg in ws:
            if msg.type == WSMsgType.BINARY:
                if len(audio) < 16000 * 2 * 60:
                    audio.extend(msg.data)
                continue
            if msg.type != WSMsgType.TEXT:
                continue
            m = json.loads(msg.data)
            t = m.get("t")
            if t == "fala_inicio":
                audio = bytearray()
                dica = m.get("dica", "")
                origem = m.get("origem", "nome")
                apelidos = [a for a in m.get("apelidos", []) if isinstance(a, str)][:20]
            elif t == "fala_fim":
                asyncio.create_task(ag.ao_falar(ws, bytes(audio), dica, origem, apelidos))
                audio = bytearray()
            elif t == "texto":
                await ws.send_json({"t": "ouvi", "texto": m.get("texto", "")})
                asyncio.create_task(ag.ao_texto(ws, m.get("texto", "")))
            elif t == "parar":
                await ag.interromper()
            elif t == "base":
                await ag.ligar(bool(m.get("ligada")))
            elif t == "config_get":
                await ws.send_json({"t": "config", "persona": ag.persona, "ligada": ag.ligada})
            elif t == "config_set":
                await ag.configurar(m.get("persona") or {})
                await ws.send_json({"t": "config", "persona": ag.persona, "ligada": ag.ligada})
            elif t in ("raciocinio_get", "raciocinio_set"):
                try:
                    if t == "raciocinio_set":
                        ag.definir_raciocinio(m.get("nivel", ""))
                    info = await ag.info_raciocinio()
                    await (ag.enviar_todos(info) if t == "raciocinio_set" else ws.send_json(info))
                except ValueError as e:
                    await ws.send_json({"t": "erro", "msg": str(e)})
            elif t in ("modelo_get", "modelo_set", "skill_listar", "skill_salvar", "skill_remover",
                       "memoria_get", "lembrar"):
                try:
                    if t == "modelo_set":
                        await ag.trocar_modelo(m.get("modelo", ""))
                    if t in ("modelo_get", "modelo_set"):
                        await ws.send_json(await ag.modelos())
                    elif t == "skill_salvar":
                        await ag.salvar_skill(m.get("nome", ""), m.get("descricao", ""), m.get("instrucoes", ""))
                        await ws.send_json(ag.skills())
                    elif t == "skill_remover":
                        await ag.remover_skill(m.get("nome", ""))
                        await ws.send_json(ag.skills())
                    elif t == "skill_listar":
                        await ws.send_json(ag.skills())
                    elif t == "memoria_get":
                        await ws.send_json(ag.memoria_info())
                    elif t == "lembrar":
                        itens = [{"quando": fmt_ts(ts), "quem": q, "texto": tx}
                                 for ts, q, tx, _ in ag.memoria.buscar(m.get("busca", ""))]
                        await ws.send_json({"t": "lembrancas", "itens": itens})
                except Exception as e:
                    await ws.send_json({"t": "erro", "msg": str(e)})
            elif t == "saudar":
                await ag.interromper()
                ag.turno_tarefa = asyncio.create_task(ag.turno(
                    ws, "(mensagem do sistema: você acabou de ser configurado. Cumprimente o usuário pelo nome e "
                        "se apresente em uma ou duas frases curtas, com a sua personalidade.)", registrar=False))
    finally:
        ag.clientes.discard(ws)
        ag.tipos.pop(id(ws), None)
        log.info("cliente saiu: %s", req.remote)
    return ws


async def rota_saude(req):
    ag = AGENTE
    n, _ = ag.memoria.total()
    return web.json_response({"ok": True, "ligada": ag.ligada, "nome": ag.persona["nome"], "falas_guardadas": n,
                              "sessao": ag.sessao, "modelo": ag.cerebro.nome_modelo})


async def rota_raciocinio(req):
    """Usada pelo comando de modelo de dentro (só localhost): troca o nível por voz."""
    if req.remote not in ("127.0.0.1", "::1"):
        return web.Response(status=403)
    ag = AGENTE
    if req.method == "POST":
        try:
            ag.definir_raciocinio((await req.json()).get("nivel", ""))
            await ag.enviar_todos(await ag.info_raciocinio())
        except ValueError as e:
            return web.json_response({"erro": str(e)}, status=400)
    return web.json_response(await ag.info_raciocinio())


async def rota_modelo(req):
    """Usada pelo `ultron-modelo` de dentro do container (só aceita localhost)."""
    if req.remote not in ("127.0.0.1", "::1"):
        return web.Response(status=403)
    ag = AGENTE
    if req.method == "POST":
        try:
            await ag.trocar_modelo((await req.json()).get("modelo", ""))
        except ValueError as e:
            return web.json_response({"erro": str(e), **(await ag.modelos())}, status=400)
    return web.json_response(await ag.modelos())


async def ao_iniciar(app):
    global AGENTE
    AGENTE = Agente()
    await AGENTE.iniciar()


async def ao_parar(app):
    if AGENTE:
        await AGENTE.cerebro.parar()


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    app = web.Application()
    app.router.add_get("/ws", rota_ws)
    app.router.add_get("/saude", rota_saude)
    app.router.add_route("*", "/modelo", rota_modelo)
    app.router.add_route("*", "/raciocinio", rota_raciocinio)
    app.on_startup.append(ao_iniciar)
    app.on_cleanup.append(ao_parar)
    web.run_app(app, host=os.environ.get("ULTRON_HOST", "127.0.0.1"), port=int(os.environ.get("ULTRON_PORTA", "8792")), print=None,
                access_log=None)      # o log de acesso gravaria o token da URL


if __name__ == "__main__":
    main()
