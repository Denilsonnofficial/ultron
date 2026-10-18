"""Harness de terminal: `ultron` num terminal abre isto.

Texto livre conversa com ela; comandos começam com "/". Tab completa.
"""
import math
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time

from . import config

# ------------------------------------------------------------------ cores
R = "\033[0m"
NEG = "\033[1m"
TENUE = "\033[2m"


def rgb(r, g, b, fundo=False):
    return f"\033[{48 if fundo else 38};2;{r};{g};{b}m"


AZUL = rgb(61, 139, 255)
CIANO = rgb(51, 224, 255)
CINZA = rgb(138, 147, 160)
VERDE = rgb(110, 210, 140)
VERM = rgb(255, 99, 99)
AMAR = rgb(230, 180, 80)
TEXTO = rgb(225, 232, 240)

# ------------------------------------------------------------------ logo em pixel art
FONTE = {  # 5 linhas, 0/1 por pixel
    "A": ["01110", "10001", "11111", "10001", "10001"], "B": ["11110", "10001", "11110", "10001", "11110"],
    "C": ["01111", "10000", "10000", "10000", "01111"], "D": ["11110", "10001", "10001", "10001", "11110"],
    "E": ["11111", "10000", "11110", "10000", "11111"], "F": ["11111", "10000", "11110", "10000", "10000"],
    "G": ["01111", "10000", "10011", "10001", "01111"], "H": ["10001", "10001", "11111", "10001", "10001"],
    "I": ["111", "010", "010", "010", "111"], "J": ["00111", "00010", "00010", "10010", "01100"],
    "K": ["10010", "10100", "11000", "10100", "10010"], "L": ["10000", "10000", "10000", "10000", "11111"],
    "M": ["10001", "11011", "10101", "10001", "10001"], "N": ["10001", "11001", "10101", "10011", "10001"],
    "O": ["01110", "10001", "10001", "10001", "01110"], "P": ["11110", "10001", "11110", "10000", "10000"],
    "Q": ["01110", "10001", "10101", "10010", "01101"], "R": ["11110", "10001", "11110", "10010", "10001"],
    "S": ["01111", "10000", "01110", "00001", "11110"], "T": ["11111", "00100", "00100", "00100", "00100"],
    "U": ["10001", "10001", "10001", "10001", "01110"], "V": ["10001", "10001", "10001", "01010", "00100"],
    "W": ["10001", "10001", "10101", "11011", "10001"], "X": ["10001", "01010", "00100", "01010", "10001"],
    "Y": ["10001", "01010", "00100", "00100", "00100"], "Z": ["11111", "00010", "00100", "01000", "11111"],
    " ": ["000", "000", "000", "000", "000"], "-": ["000", "000", "111", "000", "000"],
    "3": ["11110", "00001", "01110", "00001", "11110"],
}


# cabeça angular do Ultron em pixel art (k = contorno, B = azul, b = azul escuro, E = olho, m = boca)
_CABECA = [
    "........kkkk........",
    ".....kkkBBBBkkk.....",
    "...kkBBBbbbbBBBkk...",
    "..kBBbbbbbbbbbbBBk..",
    ".kBBbbbbbbbbbbbbBBk.",
    ".kBbbEEEEbbEEEEbbBk.",
    "kBBbbbEEEbbEEEbbbBBk",
    "kBbbbbbbbBBbbbbbbbBk",
    ".kBbbbbbbBBbbbbbbBk.",
    ".kBBbbbbbbbbbbbbBBk.",
    "..kBBbbmmmmmmbbBBk..",
    "...kBBbbbmmbbbBBk...",
    "....kkBBbbbbBBkk....",
    "......kkBBBBkk......",
    "........kkkk........",
    "....................",
]
_CORES = {"k": (30, 90, 170), "B": (90, 180, 255), "b": (20, 60, 120), "E": (225, 245, 255),
          "m": (120, 200, 255)}


def _hud(px=None):
    """Grade de pixels da cabeça do Ultron."""
    return [[_CORES.get(ch) for ch in linha] for linha in _CABECA]


def _texto_pixel(texto):
    linhas = [[] for _ in range(5)]
    for ch in texto.upper():
        g = FONTE.get(ch)
        if not g:
            continue
        for i in range(5):
            linhas[i] += [int(b) for b in g[i]] + [0]
    return linhas


def logo():
    """Linhas ANSI: cabeça do Ultron em meio-bloco + Ultron em letras de pixel com degradê dourado."""
    hud = _hud()
    saida = []
    for y in range(0, len(hud), 2):
        s = ""
        for x in range(len(hud[0])):
            cima, baixo = hud[y][x], hud[y + 1][x] if y + 1 < len(hud) else None
            if cima and baixo:
                s += rgb(*cima) + rgb(*baixo, fundo=True) + "▀" + R
            elif cima:
                s += rgb(*cima) + "▀" + R
            elif baixo:
                s += rgb(*baixo) + "▄" + R
            else:
                s += " "
        saida.append(s)
    letras = _texto_pixel("ULTRON")
    larg = len(letras[0]) or 1
    for i, linha in enumerate(letras):
        t_txt = ""
        for j, b in enumerate(linha):
            t = j / larg
            cor = rgb(int(60 + 40 * t), int(150 + 80 * t), 255)
            t_txt += (cor + "██" + R) if b else "  "
        saida[i + 1] += "    " + t_txt
    return saida


# ------------------------------------------------------------------ seletor interativo
def selecionar(titulo, itens, inicial=0, busca=""):
    """Lista com caixa de pesquisa, como nos harnesses de IA.
    itens: [(rótulo_ansi, texto_para_busca, valor)]. Digitar filtra, setas navegam,
    Enter escolhe, Esc cancela. Devolve o valor ou None."""
    import termios

    if not itens:
        return None
    fd = sys.stdin.fileno()
    antigo = termios.tcgetattr(fd)
    novo = termios.tcgetattr(fd)
    novo[3] &= ~(termios.ICANON | termios.ECHO | termios.ISIG)
    chave = lambda s: "".join(ch for ch in s.lower() if ch.isalnum() or ch == " ")  # noqa: E731
    sel, topo, desenhadas = inicial, 0, 0
    altura = max(5, min(12, shutil.get_terminal_size((90, 24)).lines - 8))

    def filtrar():
        partes = [chave(p).replace(" ", "") for p in busca.split() if chave(p).strip()]
        return [it for it in itens if all(p in chave(it[1]).replace(" ", "") for p in partes)]

    def desenhar(lista):
        nonlocal desenhadas, topo
        larg = shutil.get_terminal_size((90, 24)).columns
        if sel < topo:
            topo = sel
        elif sel >= topo + altura:
            topo = sel - altura + 1
        linhas = [f"  {CIANO}{NEG}{titulo}{R}",
                  f"  {CINZA}buscar:{R} {TEXTO}{busca}{R}{CIANO}▏{R}  {CINZA}{len(lista)} de {len(itens)}{R}"]
        for i in range(topo, min(len(lista), topo + altura)):
            rot = lista[i][0]
            visivel = len(re.sub(r"\x1b\[[0-9;]*m", "", rot))
            if visivel > larg - 8:
                rot = re.sub(r"\x1b\[[0-9;]*m", "", rot)[: larg - 9] + "…"
            if i == sel:
                linhas.append(f"  {CIANO}{NEG}›{R} {rgb(30, 60, 90, fundo=True)}{rot}{R}")
            else:
                linhas.append(f"    {rot}")
        if not lista:
            linhas.append(f"    {CINZA}nada combina{R}")
        linhas += [""] * (altura - min(altura, max(1, len(lista) - topo)))
        linhas.append(f"  {CINZA}digite para filtrar · setas navegam · Enter escolhe · Esc cancela{R}")
        out = ""
        if desenhadas:
            out += f"\033[{desenhadas}F"
        out += "\033[J" + "\n".join(linhas) + "\n"
        sys.stdout.write(out)
        sys.stdout.flush()
        desenhadas = len(linhas)

    try:
        termios.tcsetattr(fd, termios.TCSADRAIN, novo)
        sys.stdout.write("\033[?25l")
        lista = filtrar()
        while True:
            sel = max(0, min(sel, len(lista) - 1))
            desenhar(lista)
            tecla = os.read(fd, 32).decode(errors="ignore")
            if tecla in ("\r", "\n"):
                return lista[sel][2] if lista else None
            if tecla in ("\x1b", "\x03") or tecla == "\x1b\x1b":
                return None
            if tecla in ("\x1b[A", "\x1bOA"):
                sel -= 1
            elif tecla in ("\x1b[B", "\x1bOB"):
                sel += 1
            elif tecla == "\x1b[5~":
                sel -= altura
            elif tecla == "\x1b[6~":
                sel += altura
            elif tecla in ("\x7f", "\x08"):
                busca = busca[:-1]
                lista, sel, topo = filtrar(), 0, 0
            elif tecla.startswith("\x1b"):
                continue
            elif tecla.isprintable():
                busca += tecla
                lista, sel, topo = filtrar(), 0, 0
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, antigo)
        if desenhadas:
            sys.stdout.write(f"\033[{desenhadas}F\033[J")
        sys.stdout.write("\033[?25h")
        sys.stdout.flush()


# ------------------------------------------------------------------ harness
COMANDOS = {
    "/ajuda": "lista os comandos",
    "/status": "base, modelo, persona e gadget",
    "/modelo": "/modelo [filtro]  lista com busca para trocar o modelo",
    "/modelos": "o mesmo que /modelo",
    "/nome": "/nome <nome>  nome pelo qual ela responde (e que acorda o gadget)",
    "/genero": "/genero masculino|feminino  muda a voz e a concordância",
    "/personalidade": "/personalidade [texto]  mostra ou muda (sem texto: escolher um modelo pronto)",
    "/autonomia": "/autonomia alto|medio|baixo",
    "/skill": "/skill [nova|ver <nome>|remover <nome>]  habilidades extras dela",
    "/memoria": "mostra o perfil permanente e a memória de curto prazo",
    "/lembrar": "/lembrar <busca>  procura na memória de longo prazo",
    "/base": "/base ligar|desligar",
    "/gadget": "abre (ou reinicia) a esfera flutuante",
    "/tema": "/tema [nome]  skin do gadget (sem nome: escolher numa lista)",
    "/microfone": "escolhe o microfone do gadget",
    "/volume": "/volume [0-150]  volume da voz dela no gadget, em %",
    "/foco": "liga/desliga o foco: o gadget escuta direto, sem precisar do nome",
    "/interromper": "liga/desliga cortar a fala dele falando por cima (desligue em debate entre dois assistentes)",
    "/raciocinio": "/raciocinio [padrao|baixo|medio|alto|maximo]  quanto o modelo pensa antes de responder",
    "/voz": "liga/desliga ouvir as respostas em voz aqui no terminal",
    "/configurar": "assistente completo de configuração",
    "/limpar": "limpa a tela",
    "/sair": "sai do harness (o gadget continua)",
}


class Harness:
    def __init__(self):
        self.cfg = config.carregar()
        self.persona = {}
        self.ligada = True
        self.respostas = {}          # tipo -> queue
        self.em_conversa = False
        self.saida = queue.Queue()   # eventos da conversa em andamento
        self.falar = False
        self.reprodutor = None
        from .rede import Rede

        self.rede = Rede(self.cfg["base"], self.cfg["token"], self._json, self._audio, self._conexao, "harness")
        self.conectado = threading.Event()

    # ---------- rede
    def _conexao(self, ok):
        if ok:
            self.conectado.set()
        else:
            self.conectado.clear()

    def _audio(self, pcm):
        if self.falar and self.reprodutor and self.em_conversa:
            self.reprodutor.adicionar(pcm)

    def _json(self, m):
        t = m.get("t")
        if t == "config":
            self.persona = m.get("persona", {})
            self.ligada = m.get("ligada", True)
        if self.em_conversa and t in ("estado", "frase", "resposta", "ouvi", "erro"):
            self.saida.put(m)
        q = self.respostas.get(t)
        if q is not None:
            q.put(m)

    def pedir(self, msg, tipo, tempo=60):
        q = self.respostas.setdefault(tipo, queue.Queue())
        while not q.empty():
            q.get_nowait()
        self.rede.json(msg)
        try:
            resp = q.get(timeout=tempo)
        except queue.Empty:
            raise RuntimeError("a base não respondeu")
        return resp

    def pedir_com_erro(self, msg, tipo, tempo=60):
        """Espera a resposta `tipo` ou um erro da base."""
        qe = self.respostas.setdefault("erro", queue.Queue())
        while not qe.empty():
            qe.get_nowait()
        q = self.respostas.setdefault(tipo, queue.Queue())
        while not q.empty():
            q.get_nowait()
        self.rede.json(msg)
        fim = time.time() + tempo
        while time.time() < fim:
            try:
                return q.get(timeout=0.1)
            except queue.Empty:
                pass
            try:
                raise RuntimeError(qe.get_nowait().get("msg"))
            except queue.Empty:
                pass
        raise RuntimeError("a base não respondeu")

    # ---------- tela
    def cabecalho(self):
        nome = self.persona.get("nome") or self.cfg.get("nome", "Ultron")
        from .__main__ import VERSAO

        modelo = "?"
        try:
            modelo = self.pedir({"t": "modelo_get"}, "modelos", 20)["atual"]
        except Exception:
            pass
        larg = min(shutil.get_terminal_size((90, 24)).columns, 100)
        print()
        for linha in logo():
            print("  " + linha)
        print()
        estado = f"{VERDE}base conectada{R}" if self.conectado.is_set() else f"{VERM}sem base{R}"
        if not self.ligada:
            estado = f"{AMAR}base desligada{R}"
        apelido = "" if nome.upper() == "Ultron" else f"  {CINZA}·{R} {CINZA}nome:{R} {TEXTO}{nome}{R}"
        print(f"  {TEXTO}{NEG}Ultron{R} {CINZA}v{VERSAO}{R}{apelido}"
              f"  {CINZA}·{R} {estado}  {CINZA}·{R} {CIANO}{modelo}{R}")
        print(f"  {CINZA}{'─' * (larg - 4)}{R}")
        print(f"  {CINZA}Escreva para conversar com {nome}. {TEXTO}/{CINZA} abre os comandos, Tab completa,"
              f" Ctrl+C interrompe uma resposta.{R}\n")

    def ajuda(self):
        for c, d in COMANDOS.items():
            print(f"  {CIANO}{c:<15}{R} {CINZA}{d}{R}")
        print()

    def info(self, txt):
        print(f"  {CINZA}{txt}{R}")

    def ok(self, txt):
        print(f"  {VERDE}{txt}{R}")

    def erro(self, txt):
        print(f"  {VERM}{txt}{R}")

    # ---------- conversa
    def conversar(self, texto):
        while not self.saida.empty():
            self.saida.get_nowait()
        self.em_conversa = True
        self.rede.json({"t": "texto", "texto": texto})
        quadros = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
        estado, detalhe, i, escreveu = "pensando", "", 0, False
        nome = self.persona.get("nome", "Ultron")
        try:
            while True:
                try:
                    m = self.saida.get(timeout=0.1)
                except queue.Empty:
                    if not escreveu or estado in ("pensando", "agindo"):
                        rot = f"executando: {detalhe[:60]}" if estado == "agindo" else "pensando"
                        sys.stdout.write(f"\r\033[K  {AZUL}{quadros[i % len(quadros)]}{R} {CINZA}{rot}{R}")
                        sys.stdout.flush()
                        i += 1
                    continue
                t = m["t"]
                if t == "estado":
                    estado, detalhe = m["valor"], m.get("detalhe", "")
                elif t == "frase":
                    sys.stdout.write("\r\033[K")
                    if not escreveu:
                        sys.stdout.write(f"  {CIANO}{NEG}{nome}{R}  ")
                        escreveu = True
                    else:
                        sys.stdout.write("  " + " " * (len(nome) + 2))
                    print(f"{TEXTO}{m['texto']}{R}")
                elif t == "erro":
                    sys.stdout.write("\r\033[K")
                    self.erro(m.get("msg", "erro"))
                elif t == "resposta":
                    sys.stdout.write("\r\033[K")
                    if not escreveu and m.get("texto"):
                        print(f"  {CIANO}{NEG}{nome}{R}  {TEXTO}{m['texto']}{R}")
                    print()
                    break
        except KeyboardInterrupt:
            self.rede.json({"t": "parar"})
            if self.reprodutor:
                self.reprodutor.limpar()
            sys.stdout.write("\r\033[K")
            self.info("interrompido\n")
        finally:
            if self.falar and self.reprodutor:
                try:
                    while self.reprodutor.tocando():
                        time.sleep(0.05)
                except KeyboardInterrupt:
                    self.reprodutor.limpar()
                    self.rede.json({"t": "parar"})
            self.em_conversa = False

    # ---------- comandos
    def cmd_status(self, _):
        p = self.persona
        from .app import pid_gadget

        try:
            mod = self.pedir({"t": "modelo_get"}, "modelos", 20)["atual"]
        except Exception:
            mod = "?"
        linhas = [
            ("base", (f"{VERDE}conectada{R}" if self.conectado.is_set() else f"{VERM}desconectada{R}")
             + f" {CINZA}({self.cfg['base']}){R}"),
            ("ligada", "sim" if self.ligada else f"{AMAR}não{R}"),
            ("modelo", f"{CIANO}{mod}{R}"),
            ("nome", p.get("nome", "?")), ("gênero", p.get("genero", "?")),
            ("autonomia", p.get("autonomia", "?")), ("te chama de", p.get("usuario", "?")),
            ("personalidade", p.get("personalidade", "?")),
            ("gadget", f"{VERDE}aberto{R}" if pid_gadget() else f"{CINZA}fechado{R}"),
            ("microfone", self.cfg.get("microfone") or "padrão do sistema"),
            ("voz no terminal", "ligada" if self.falar else "desligada"),
        ]
        for k, v in linhas:
            print(f"  {CINZA}{k:<15}{R} {TEXTO}{v}{R}")
        print()

    def _escolher(self, opcoes, titulo="Escolha"):
        if sys.stdin.isatty():
            return selecionar(titulo, [(o, re.sub(r"\x1b\[[0-9;]*m", "", o), i) for i, o in enumerate(opcoes)])
        for i, o in enumerate(opcoes, 1):
            print(f"  {AZUL}{i:>3}{R}  {o}")
        try:
            r = input(f"  {CINZA}{titulo} (número, Enter cancela):{R} ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return None
        return int(r) - 1 if r.isdigit() and 1 <= int(r) <= len(opcoes) else None

    def _rot_modelo(self, m, atual):
        preco = f"{VERDE}grátis{R}" if m["gratis"] else f"{AMAR}pago{R}"
        marca = f" {CIANO}(atual){R}" if m["id"] == atual else ""
        return f"{TEXTO}{m['id']}{R}  {preco}{marca}"

    def cmd_modelos(self, arg):
        self.cmd_modelo(arg)

    def cmd_modelo(self, arg):
        info = self.pedir({"t": "modelo_get"}, "modelos", 30)
        todos = info["disponiveis"]
        exatos = [m for m in todos if m["id"] == arg]
        if exatos:
            escolha = exatos[0]
        else:
            ordem = sorted(todos, key=lambda m: (m["id"] != info["atual"], not m["gratis"], m["id"]))
            itens = [(self._rot_modelo(m, info["atual"]), m["id"] + (" gratis free" if m["gratis"] else " pago"), m)
                     for m in ordem]
            escolha = selecionar(f"Modelo  {CINZA}(atual: {info['atual']}){R}", itens, busca=arg)
            if escolha is None:
                return
        if not escolha["gratis"]:
            try:
                if input(f"  {AMAR}{escolha['id']} é pago (cobra no OpenRouter). Trocar mesmo? (s/n):{R} ").strip().lower() != "s":
                    return
            except (EOFError, KeyboardInterrupt):
                print()
                return
        try:
            r = self.pedir_com_erro({"t": "modelo_set", "modelo": escolha["id"]}, "modelos", 30)
            self.ok(f"Modelo agora: {r['atual']}\n")
        except RuntimeError as e:
            self.erro(str(e))

    def _persona(self, **mud):
        r = self.pedir({"t": "config_set", "persona": mud}, "config", 20)
        self.persona = r.get("persona", self.persona)
        return self.persona

    def cmd_nome(self, arg):
        if not arg:
            self.info(f"Nome atual: {self.persona.get('nome')}. Use /nome <novo nome>.")
            return
        self._persona(nome=arg)
        self.cfg = config.carregar()
        self.cfg["nome"], self.cfg["apelidos"] = arg, []
        config.salvar(self.cfg)
        self.ok(f"Agora ela se chama {arg}.")
        self._reabrir_gadget_se_aberto("para ouvir o nome novo")
        self.info("Dica: /configurar calibra o reconhecimento do nome com a sua voz.\n")

    def cmd_genero(self, arg):
        arg = arg.lower().strip()
        if arg.startswith("f"):
            arg = "feminino"
        elif arg.startswith("m"):
            arg = "masculino"
        else:
            self.info(f"Gênero atual: {self.persona.get('genero')}. Use /genero masculino|feminino.")
            return
        self._persona(genero=arg)
        self.ok(f"Gênero: {arg} (a voz muda na próxima fala).\n")

    def cmd_personalidade(self, arg):
        if not arg:
            from .assistente import PERSONALIDADES

            self.info(f"Atual: {self.persona.get('personalidade')}")
            i = self._escolher([f"{n}: {CINZA}{d}{R}" for n, d in PERSONALIDADES] + ["Escrever a minha"], "Personalidade")
            if i is None:
                return
            if i < len(PERSONALIDADES):
                arg = PERSONALIDADES[i][1]
            else:
                try:
                    arg = input(f"  {CINZA}Descreva:{R} ").strip()
                except (EOFError, KeyboardInterrupt):
                    return
            if not arg:
                return
        self._persona(personalidade=arg)
        self.ok("Personalidade atualizada (vale a partir da próxima conversa).\n")

    def cmd_autonomia(self, arg):
        arg = arg.lower().replace("é", "e").strip()
        if arg not in ("alto", "medio", "baixo"):
            self.info(f"Autonomia atual: {self.persona.get('autonomia')}. Use /autonomia alto|medio|baixo.")
            return
        self._persona(autonomia=arg)
        self.ok(f"Autonomia: {arg}.\n")

    def _ler_bloco(self, titulo):
        print(f"  {CINZA}{titulo} (termine com uma linha só com um ponto: .){R}")
        linhas = []
        while True:
            try:
                l = input("  │ ")
            except EOFError:
                break
            if l.strip() == ".":
                break
            linhas.append(l)
        return "\n".join(linhas).strip()

    def cmd_skill(self, arg):
        partes = arg.split(maxsplit=1)
        sub = partes[0].lower() if partes else ""
        resto = partes[1].strip() if len(partes) > 1 else ""
        try:
            if sub in ("", "listar", "lista"):
                r = self.pedir({"t": "skill_listar"}, "skills")
                if not r["lista"]:
                    self.info("Nenhuma skill ainda. Crie com /skill nova.\n")
                for s in r["lista"]:
                    marca = f" {AMAR}(interna){R}" if s.get("interna") else ""
                    print(f"  {CIANO}{s['nome']}{R}{marca}  {CINZA}{s['descricao'][:110]}{R}")
                print()
            elif sub in ("nova", "adicionar", "add"):
                self.info("Uma skill ensina um procedimento a ela. O modelo lê a descrição e usa a skill quando ela se aplica.")
                try:
                    nome = resto or input(f"  {CINZA}Nome (ex.: deploy-site):{R} ").strip()
                    desc = input(f"  {CINZA}Quando usar (descrição curta):{R} ").strip()
                except (EOFError, KeyboardInterrupt):
                    print()
                    return
                instr = self._ler_bloco("Instruções, passo a passo")
                r = self.pedir_com_erro({"t": "skill_salvar", "nome": nome, "descricao": desc, "instrucoes": instr}, "skills")
                self.ok(f"Skill salva. Agora ela tem {len(r['lista'])} skill(s).\n")
            elif sub == "ver":
                r = self.pedir({"t": "skill_listar"}, "skills")
                s = next((s for s in r["lista"] if s["nome"] == resto), None)
                if not s:
                    self.erro("Não existe essa skill.")
                    return
                print(f"  {CIANO}{NEG}{s['nome']}{R}  {CINZA}{s['descricao']}{R}")
                for l in s["instrucoes"].splitlines():
                    print(f"  {TEXTO}{l}{R}")
                print()
            elif sub in ("remover", "apagar", "rm"):
                r = self.pedir_com_erro({"t": "skill_remover", "nome": resto}, "skills")
                self.ok(f"Removida. Restam {len(r['lista'])}.\n")
            else:
                self.info(COMANDOS["/skill"])
        except RuntimeError as e:
            self.erro(str(e))

    def cmd_memoria(self, _):
        r = self.pedir({"t": "memoria_get"}, "memoria")
        print(f"  {CIANO}{NEG}Perfil permanente{R}")
        for l in (r["perfil"] or "(vazio)").splitlines():
            print(f"  {TEXTO}{l}{R}")
        print(f"\n  {CIANO}{NEG}Memória de curto prazo{R}")
        for l in (r["curta"] or "(vazia)").splitlines():
            print(f"  {TEXTO}{l}{R}")
        self.info(f"\nLongo prazo: {r['falas']} falas guardadas" + (f" desde {r['desde']}" if r["desde"] else "") + ".\n")

    def cmd_lembrar(self, arg):
        if not arg:
            self.info("Use /lembrar <palavras>.")
            return
        r = self.pedir({"t": "lembrar", "busca": arg}, "lembrancas")
        if not r["itens"]:
            self.info("Nada encontrado.\n")
        for it in r["itens"]:
            print(f"  {CINZA}{it['quando']}{R} {CIANO}{it['quem']}{R}: {TEXTO}{it['texto'][:300]}{R}")
        print()

    def cmd_base(self, arg):
        if arg not in ("ligar", "desligar"):
            self.info(f"A base está {'ligada' if self.ligada else 'desligada'}. Use /base ligar|desligar.")
            return
        self.rede.json({"t": "base", "ligada": arg == "ligar"})
        self.ligada = arg == "ligar"
        self.ok(f"Base {'ligada' if self.ligada else 'desligada'}.\n")

    def _reabrir_gadget_se_aberto(self, motivo=""):
        from .app import abrir_gadget_destacado, pid_gadget

        if pid_gadget():
            abrir_gadget_destacado()
            self.info(f"Gadget reiniciado {motivo}.".replace("  ", " "))

    def cmd_gadget(self, _):
        from .app import abrir_gadget_destacado

        abrir_gadget_destacado()
        self.ok("Gadget aberto.\n")

    def cmd_tema(self, arg):
        from .gadget import TEMAS

        chaves = list(TEMAS)
        atual = config.carregar().get("tema", "ultron")
        if arg:
            alvo = next((c for c in chaves if c.startswith(arg.lower()) or TEMAS[c]["nome"].lower().startswith(arg.lower())), None)
            if not alvo:
                self.erro("Tema desconhecido. Opções: " + ", ".join(TEMAS[c]["nome"] for c in chaves))
                return
        else:
            i = self._escolher([TEMAS[c]["nome"] + (f" {CIANO}(atual){R}" if c == atual else "") for c in chaves], "Tema")
            if i is None:
                return
            alvo = chaves[i]
        cfg = config.carregar()
        cfg["tema"] = alvo
        config.salvar(cfg)
        self.ok(f"Tema: {TEMAS[alvo]['nome']}.")
        self._reabrir_gadget_se_aberto("com o tema novo")
        print()

    def cmd_foco(self, _):
        cfg = config.carregar()
        cfg["foco"] = not cfg.get("foco")
        config.salvar(cfg)
        self.ok("Foco ligado: o gadget escuta direto, sem precisar do nome." if cfg["foco"] else "Foco desligado.")
        self._reabrir_gadget_se_aberto("com o foco novo")
        print()

    def cmd_interromper(self, _):
        cfg = config.carregar()
        cfg["interromper_por_voz"] = not cfg.get("interromper_por_voz", True)
        config.salvar(cfg)
        self.ok("Interromper por voz ligado: falar por cima corta a fala." if cfg["interromper_por_voz"]
                else "Interromper por voz desligado: ninguém corta a fala falando por cima (clique no gadget corta).")
        self._reabrir_gadget_se_aberto("com a mudança")
        print()

    def cmd_raciocinio(self, arg):
        niveis = ["padrao", "baixo", "medio", "alto", "maximo"]
        atual = self.pedir({"t": "raciocinio_get"}, "raciocinio", 20)
        if arg not in niveis:
            nomes = {"padrao": "Padrão do modelo", "baixo": "Baixo (rápido)", "medio": "Médio", "alto": "Alto",
                     "maximo": "Máximo (lento)"}
            rotulo = lambda n: nomes[n] + (f" {CIANO}(atual){R}" if n == atual["nivel"] else "")  # noqa: E731
            i = self._escolher([rotulo(n) for n in niveis], "Raciocínio")
            if i is None:
                return
            arg = niveis[i]
        r = self.pedir_com_erro({"t": "raciocinio_set", "nivel": arg}, "raciocinio", 20)
        extra = f"variante {r['variante']}" if r.get("variante") else "este modelo não tem ajuste próprio; vale como instrução"
        self.ok(f"Raciocínio: {r['nivel']} ({extra}).\n")

    def cmd_volume(self, arg):
        cfg = config.carregar()
        if not arg.strip().rstrip("%").isdigit():
            self.info(f"Volume atual: {round(cfg.get('volume', 1.0) * 100)}%. Use /volume <0 a 150>.")
            return
        cfg["volume"] = max(0, min(150, int(arg.strip().rstrip("%")))) / 100
        config.salvar(cfg)
        self.ok(f"Volume da voz: {round(cfg['volume'] * 100)}%.")
        self._reabrir_gadget_se_aberto("com o volume novo")
        print()

    def cmd_microfone(self, _):
        from .audio import listar_microfones

        mics = listar_microfones()
        i = self._escolher(["Padrão do sistema"] + [d for _, d in mics], "Microfone")
        if i is None:
            return
        self.cfg = config.carregar()
        self.cfg["microfone"] = None if i == 0 else mics[i - 1][0]
        config.salvar(self.cfg)
        self.ok("Microfone salvo.")
        self._reabrir_gadget_se_aberto("com o microfone novo")
        print()

    def cmd_voz(self, _):
        self.falar = not self.falar
        if self.falar and self.reprodutor is None:
            from .audio import Reprodutor

            self.reprodutor = Reprodutor()
        self.ok(f"Voz no terminal {'ligada' if self.falar else 'desligada'}.\n")

    def cmd_configurar(self, _):
        from . import assistente

        assistente.rodar()
        self.cfg = config.carregar()
        self._reabrir_gadget_se_aberto("com a configuração nova")
        self.rede.json({"t": "config_get"})

    def cmd_limpar(self, _):
        os.system("clear")
        self.cabecalho()

    # ---------- laço
    def _completar(self, texto, estado):
        import readline

        linha = readline.get_line_buffer()
        if " " not in linha:
            op = [c + " " for c in COMANDOS if c.startswith(linha)]
        else:
            cmd, _, resto = linha.partition(" ")
            subs = {"/genero": ["masculino", "feminino"], "/autonomia": ["alto", "medio", "baixo"],
                    "/base": ["ligar", "desligar"], "/skill": ["nova", "ver", "remover", "listar"],
                    "/raciocinio": ["padrao", "baixo", "medio", "alto", "maximo"],
                    "/tema": ["ultron", "r2d2", "sabre", "rebelde", "bb8", "estrela", "holograma", "azul", "reator", "hal", "ambar", "esmeralda", "neon", "retro", "aurora", "grafite"]}.get(cmd, [])
            op = [s + " " for s in subs if s.startswith(resto)]
        return op[estado] if estado < len(op) else None

    def rodar(self):
        try:
            import readline

            readline.set_completer(self._completar)
            readline.set_completer_delims("")
            readline.parse_and_bind("tab: complete")
            hist = os.path.join(config.DADOS, "historico_harness")
            try:
                readline.read_history_file(hist)
            except OSError:
                pass
            import atexit

            atexit.register(lambda: readline.write_history_file(hist))
        except ImportError:
            pass
        self.rede.start()
        if not self.conectado.wait(8):
            self.erro(f"Não consegui conectar na base ({self.cfg['base']}). Os comandos locais funcionam.")
        else:
            try:
                self.pedir({"t": "config_get"}, "config", 10)
            except RuntimeError:
                pass
        self.cabecalho()
        nome = self.persona.get("nome", "Ultron")
        while True:
            try:
                linha = input(f"{AZUL}{NEG}›{R} ").strip()
            except EOFError:
                print()
                break
            except KeyboardInterrupt:
                print()
                continue
            if not linha:
                continue
            if not linha.startswith("/"):
                if not self.conectado.is_set():
                    self.erro("Sem conexão com a base.")
                    continue
                self.conversar(linha)
                continue
            if linha == "/":
                itens = [(f"{CIANO}{c:<15}{R} {CINZA}{d}{R}", c + " " + d, c) for c, d in COMANDOS.items()]
                escolhido = selecionar("Comandos", itens)
                if not escolhido:
                    continue
                linha = escolhido
            cmd, _, arg = linha.partition(" ")
            cmd = cmd.lower()
            if cmd in ("/sair", "/exit", "/quit"):
                break
            if cmd == "/ajuda" or cmd == "/help":
                self.ajuda()
                continue
            alvo = getattr(self, "cmd_" + cmd[1:], None) if cmd[1:].isidentifier() else None
            if not alvo:
                self.erro(f"Comando desconhecido: {cmd}. /ajuda lista os comandos.")
                continue
            try:
                alvo(arg.strip())
            except RuntimeError as e:
                self.erro(str(e))
            except KeyboardInterrupt:
                print()
        if self.reprodutor:
            self.reprodutor.fechar()
        self.info(f"Até mais. O gadget continua ouvindo pelo nome \"{nome}\".")


def rodar():
    Harness().rodar()
    return 0
