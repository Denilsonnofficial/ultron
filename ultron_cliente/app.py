"""Liga microfone, rede, reprodução e gadget."""
import os
import subprocess
import sys
import threading
import time

from . import config
from .audio import (CancelaEco, DetectorNome, FonteMicrofone, Ouvinte, Reprodutor, listar_microfones, normalizar,
                    palavras, parecido_em_sequencia)
from .rede import Rede


class Cliente:
    """Núcleo sem interface (também usado no modo de teste)."""

    def __init__(self, cfg, fonte=None, gravar_em=None, ao_estado=None, log=False):
        self.cfg = cfg
        self.log = log
        self.ao_estado_ui = ao_estado or (lambda *_: None)
        self.eco = CancelaEco()
        # o cancelador do WebRTC abafa a voz do usuário enquanto ela fala (impede interromper);
        # por padrão fica desligado e o eco é barrado pelo filtro de texto
        com_eco = fonte is None and cfg.get("cancelar_eco", False) and self.eco.ligar(cfg.get("microfone"))
        self._p("[cancelamento de eco ligado]" if com_eco else "[sem cancelamento de eco]")
        self.reprodutor = Reprodutor(gravar_em, CancelaEco.SAIDA if com_eco else None, cfg.get("volume", 1.0))
        self.estado_base = "conectando"
        self.detalhe = ""
        self.local = None          # estado local que manda na tela (conversa/ouvindo)
        self.frases = []           # (ts, frase) que ela está falando: filtro de eco
        self.ultima_resposta = threading.Event()
        self.ligada = True
        self.rede = Rede(cfg["base"], cfg["token"], self._json, self.reprodutor.adicionar, self._conexao)
        detector = DetectorNome(cfg["nome"], cfg.get("apelidos", []), cfg.get("sensibilidade", 0.78))
        self.fonte = fonte or FonteMicrofone(CancelaEco.FONTE if com_eco else cfg.get("microfone"))
        self.ouvinte = Ouvinte(
            config.MODELO_VOSK, detector, self.fonte, self._acordou, self._falou, self._local,
            ao_interromper=self._interromper, tocando=self.reprodutor.tocando, eh_eco=self._eh_eco,
            ocupado=lambda: self.estado_base in ("pensando", "agindo", "falando"),
            tempo_conversa=cfg.get("tempo_conversa", 20), fala_clara=self._fala_clara,
            eco_ref=self.reprodutor.eco_ref, abafar=self._abafar, log=self._p,
        )
        self.ouvinte.pausado = bool(cfg.get("mudo"))
        self.raciocinio = "padrao"
        self.ao_raciocinio = lambda nivel: None
        if cfg.get("foco"):
            self.ouvinte.definir_foco(True)
        self.ouvinte.interromper_por_voz = cfg.get("interromper_por_voz", True)

    def iniciar(self):
        self.rede.start()
        self.ouvinte.start()

    def _p(self, *a):
        linha = " ".join(str(x) for x in (time.strftime("%H:%M:%S"), *a))
        if self.log:
            print(linha, flush=True)
        try:
            arq = os.path.join(config.DADOS, "cliente.log")
            if os.path.exists(arq) and os.path.getsize(arq) > 2_000_000:
                os.replace(arq, arq + ".1")
            with open(arq, "a", encoding="utf-8") as f:
                f.write(linha + "\n")
        except OSError:
            pass

    def _mostrar(self):
        estado = self.estado_base
        if self.local == "ouvindo" or (self.local == "conversa" and estado == "ocioso"):
            estado = self.local
        self.ao_estado_ui(estado, self.detalhe)

    def _eh_eco(self, texto):
        agora = time.time()
        self.frases = [(ts, f) for ts, f in self.frases if agora - ts < 40]
        if not palavras(texto):
            return True                      # só pedacinho enquanto ela fala: trata como eco
        if not self.frases:
            return False
        nota = parecido_em_sequencia(texto, " ".join(f for _, f in self.frases))
        # trecho curto sempre acha algo parecido no texto dela: exige mais semelhança
        tam = len(normalizar(texto).replace(" ", ""))
        # medido no PC do usuário: eco mal reconhecido fica em 0,53-0,67; fala dele em 0,15-0,47
        eco = nota >= (0.7 if tam < 10 else 0.55 if tam < 20 else 0.5)
        self._p(f"[{'eco' if eco else 'fala por cima'} {nota:.2f}] {texto!r}")
        return eco

    def _abafar(self, fator):
        self.reprodutor.abafar = fator

    def _fala_clara(self, texto):
        """Três palavras ou mais que não lembram nada do que ela está dizendo: é o usuário."""
        if len(texto.split()) < 4 or not self.frases:
            return len(texto.split()) >= 4
        return parecido_em_sequencia(texto, " ".join(f for _, f in self.frases)) < 0.4

    # ------------------------------------------------ eventos do ouvinte (thread do microfone)
    def _acordou(self):
        self._p("[nome detectado: conversa aberta]")
        if self.reprodutor.tocando():
            self._interromper()
        self.local = "ouvindo"
        self._mostrar()

    def _interromper(self):
        self._p("[interrompeu a fala]")
        self.frases.clear()
        self.reprodutor.limpar()
        self.rede.json({"t": "parar"})

    def _falou(self, pcm, dica, origem):
        self._p(f"[enviando {len(pcm) / 32000:.1f}s de áudio, {origem}] vosk ouviu: {dica!r}")
        self.local = "conversa"
        if not self.rede.fala(pcm, dica, origem, self.cfg.get("apelidos", [])):
            self.estado_base = "conectando"
        self._mostrar()

    def _local(self, evento):
        if evento in ("conversa", "ouvindo"):
            self.local = evento
        elif evento == "fim_conversa":
            self._p("[conversa encerrada por silêncio]")
            self.local = None
        self._mostrar()

    # ------------------------------------------------ eventos da base (thread da rede)
    def _conexao(self, ok):
        self._p("[conectado à base]" if ok else "[sem conexão com a base]")
        self.estado_base = "ocioso" if ok else "conectando"
        self._mostrar()

    def _json(self, m):
        t = m.get("t")
        if t == "estado":
            self.estado_base = m["valor"]
            self.detalhe = m.get("detalhe", "")
            if self.estado_base == "desligada":
                self.ligada = False
            elif not self.ligada and self.estado_base == "ocioso":
                self.ligada = True
            self._p(f"[base: {self.estado_base}] {self.detalhe}")
            self._mostrar()
        elif t == "frase":
            self.frases.append((time.time(), m.get("texto", "")))
        elif t == "ouvi":
            extra = f"  (ignorado: {m.get('motivo')})" if m.get("ignorado") else ""
            self._p(f"voce: {m['texto']}{extra}")
            if m.get("motivo") == "sem_nome":
                self.ouvinte.encerrar_conversa()      # o detector local acordou à toa
        elif t == "resposta":
            self._p(f"{self.cfg['nome']}: {m['texto']}")
            self.ultima_resposta.set()
        elif t == "audio_fim" and m.get("cortado"):
            self.reprodutor.limpar()
        elif t == "escutar":
            threading.Thread(target=self._janela_depois_de_tocar, args=(m.get("segundos", 6),), daemon=True).start()
        elif t == "config":
            self.ligada = m.get("ligada", True)
            if not self.ligada:
                self.estado_base = "desligada"
            pausar = bool(self.cfg.get("mudo")) or not self.ligada
            if pausar != self.ouvinte.pausado:      # sem isso, toda (re)conexão zerava a conversa aberta
                self.ouvinte.pausar(pausar)
            self._mostrar()
        elif t == "raciocinio":
            self.raciocinio = m.get("nivel", "padrao")
            self.ao_raciocinio(self.raciocinio)
        elif t == "erro":
            self._p("[erro da base]", m.get("msg"))

    def _janela_depois_de_tocar(self, segundos):
        time.sleep(0.3)
        limite = time.time() + 120
        while self.reprodutor.tocando() and time.time() < limite:
            time.sleep(0.05)
        if segundos > 0 and self.ouvinte.modo == "conversa":
            self.ouvinte.abrir_janela(segundos)

    # ------------------------------------------------ ações dos botões
    def alternar_mudo(self):
        self.cfg["mudo"] = not self.cfg.get("mudo")
        self.ouvinte.pausar(self.cfg["mudo"] or not self.ligada)
        config.salvar(self.cfg)
        return self.cfg["mudo"]

    def alternar_base(self):
        self.ligada = not self.ligada
        self.rede.json({"t": "base", "ligada": self.ligada})
        if not self.ligada:
            self.reprodutor.limpar()
        self.ouvinte.pausar(self.cfg.get("mudo") or not self.ligada)
        return self.ligada

    def trocar_microfone(self, nome):
        self.cfg["microfone"] = nome
        config.salvar(self.cfg)
        if self.cfg.get("cancelar_eco", False) and self.eco.ligar(nome):
            self.reprodutor.trocar_dispositivo(CancelaEco.SAIDA)
            self.ouvinte.trocar_fonte(FonteMicrofone(CancelaEco.FONTE))
        else:
            self.reprodutor.trocar_dispositivo(None)
            self.ouvinte.trocar_fonte(FonteMicrofone(nome))

    def alternar_foco(self):
        self.cfg["foco"] = not self.cfg.get("foco")
        atual = config.carregar()
        atual["foco"] = self.cfg["foco"]
        config.salvar(atual)
        self.ouvinte.definir_foco(self.cfg["foco"])
        if not self.cfg["foco"]:
            self.local = None
        self._mostrar()
        return self.cfg["foco"]

    def definir_raciocinio(self, nivel):
        self.rede.json({"t": "raciocinio_set", "nivel": nivel})

    def chamar_manual(self):
        """Clique na esfera: interrompe a fala, ou abre a conversa sem precisar do nome."""
        if self.reprodutor.tocando():
            self._interromper()
        else:
            self.ouvinte.abrir_janela(self.cfg.get("tempo_conversa", 20))

    def fechar(self):
        self.ouvinte.vivo = False
        self.fonte.fechar()
        self.reprodutor.fechar()
        self.eco.desligar()


def garantir_base(cfg, esperar=30):
    """Se a base local não responde, sobe ela: pelo serviço de usuário ou, sem systemd, direto."""
    import socket
    import urllib.parse

    u = urllib.parse.urlparse(cfg["base"])
    if u.hostname not in ("127.0.0.1", "localhost"):
        return True

    def no_ar():
        try:
            with socket.create_connection((u.hostname, u.port or 80), timeout=1):
                return True
        except OSError:
            return False

    if no_ar():
        return True
    if subprocess.run(["systemctl", "--user", "start", "ultron-base.service"], capture_output=True).returncode != 0:
        env = dict(os.environ)
        try:
            for linha in open(os.path.join(config.DADOS, "base.env")):
                if "=" in linha:
                    k, v = linha.strip().split("=", 1)
                    env[k] = v
        except OSError:
            return False
        log = open(os.path.join(config.DADOS, "base.log"), "a")
        subprocess.Popen([sys.executable, "-m", "ultron_base.servidor"], env=env, stdout=log, stderr=log,
                         stdin=subprocess.DEVNULL, start_new_session=True)
    fim = time.time() + esperar
    while time.time() < fim:
        if no_ar():
            return True
        time.sleep(0.5)
    return False


def abrir_terminal(argumentos):
    """Abre um terminal gráfico rodando o ultron (usado na primeira configuração)."""
    exe = os.path.expanduser("~/.local/bin/ultron")
    for term, pre in (("kgx", ["--"]), ("gnome-terminal", ["--"]), ("konsole", ["-e"]), ("xfce4-terminal", ["-x"]),
                      ("alacritty", ["-e"]), ("kitty", []), ("xterm", ["-e"])):
        if subprocess.run(["which", term], capture_output=True).returncode == 0:
            subprocess.Popen([term, *pre, exe, *argumentos], start_new_session=True)
            return True
    return False


ARQ_PID = os.path.join(config.DADOS, "gadget.pid")


def pid_gadget():
    try:
        pid = int(open(ARQ_PID).read())
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            if b"ultron_cliente" in f.read() and pid != os.getpid():
                return pid
    except (OSError, ValueError):
        pass
    return None


def abrir_gadget_destacado():
    """Fecha o gadget aberto (se houver) e abre um novo, independente do terminal."""
    pid = pid_gadget()
    if pid:
        os.kill(pid, 15)
        for _ in range(30):
            if not pid_gadget():
                break
            time.sleep(0.1)
    exe = os.path.expanduser("~/.local/bin/ultron")
    servico = subprocess.run(["systemctl", "--user", "is-enabled", "ultron.service"], capture_output=True, text=True)
    if servico.stdout.strip() == "enabled":
        subprocess.run(["systemctl", "--user", "restart", "ultron.service"], capture_output=True)
        return
    if subprocess.run(["systemd-run", "--user", "--collect", "-q", exe, "gadget"], capture_output=True).returncode != 0:
        subprocess.Popen([exe, "gadget"], start_new_session=True, stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def rodar_gadget():
    if pid_gadget():
        print("O gadget já está aberto.")
        return 0
    os.makedirs(config.DADOS, exist_ok=True)
    with open(ARQ_PID, "w") as f:
        f.write(str(os.getpid()))
    cfg = config.carregar()
    garantir_base(cfg, esperar=5)
    os.environ.setdefault("QT_QPA_PLATFORM", "xcb")   # no Wayland do GNOME, só o X11 deixa ficar sempre por cima
    from PySide6.QtCore import QTimer
    from PySide6.QtWidgets import QApplication

    from .gadget import Gadget

    app = QApplication(sys.argv)
    app.setApplicationName("ultron")
    app.setQuitOnLastWindowClosed(True)
    gadget = None

    def ao_estado(valor, detalhe):
        if gadget:
            gadget.ligada = cli.ligada
            gadget.definir_estado(valor, detalhe)

    cli = Cliente(cfg, ao_estado=ao_estado)

    def mudo():
        gadget.mudo = cli.alternar_mudo()

    def foco():
        gadget.foco = cli.alternar_foco()

    def base():
        gadget.ligada = cli.alternar_base()

    def reconfigurar():
        if abrir_terminal(["configurar"]):
            cli.fechar()
            app.quit()

    def mover(pos):
        cfg["posicao"] = list(pos)
        config.salvar(cfg)

    def volume(v):
        atual = config.carregar()
        atual["volume"] = cfg["volume"] = v
        config.salvar(atual)

    def tema(nome):
        atual = config.carregar()             # não sobrescreve o que o harness mudou
        atual["tema"] = cfg["tema"] = nome
        config.salvar(atual)

    acoes = {
        "clicar_esfera": cli.chamar_manual, "mudo": mudo, "base": base, "microfones": listar_microfones,
        "microfone_atual": lambda: cfg.get("microfone"), "trocar_microfone": cli.trocar_microfone,
        "reconfigurar": reconfigurar, "sair": app.quit, "mover": mover, "tema": tema, "volume": volume, "foco": foco,
        "raciocinio": cli.definir_raciocinio,
        "terminal": lambda: abrir_terminal([]),
    }
    gadget = Gadget(cli.reprodutor, acoes, cfg.get("posicao"), cfg.get("tema", "ultron"))
    gadget.mudo = bool(cfg.get("mudo"))
    gadget.foco = bool(cfg.get("foco"))
    cli.ao_raciocinio = gadget.definir_raciocinio_visual
    gadget.show()
    import signal

    signal.signal(signal.SIGTERM, lambda *_: app.quit())
    trava = QTimer()            # deixa o Python atender sinais com o Qt rodando
    trava.timeout.connect(lambda: None)
    trava.start(300)
    cli.iniciar()
    saida = app.exec()
    cli.fechar()
    try:
        os.remove(ARQ_PID)
    except OSError:
        pass
    return saida
