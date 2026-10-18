"""Microfone, detecção do nome (Vosk local) e reprodução da voz da base."""
import collections
import difflib
import json
import os
import re
import subprocess
import threading
import time
import unicodedata
import wave

import numpy as np

TAXA_MIC = 16000
BLOCO = 1600            # 100 ms
TAXA_VOZ = 24000


# ---------------------------------------------------------------- nome / fonética
NUMEROS = {"0": "zero", "1": "um", "2": "dois", "3": "tres", "4": "quatro", "5": "cinco", "6": "seis",
           "7": "sete", "8": "oito", "9": "nove"}


def normalizar(s):
    s = "".join(c for c in unicodedata.normalize("NFD", s.lower()) if unicodedata.category(c) != "Mn")
    s = re.sub(r"\d", lambda m: f" {NUMEROS[m.group()]} ", s)       # Ultron -> c tres po
    return re.sub(r"[^a-z ]", " ", s)


def fonetico(s):
    """Aproxima palavras que soam parecido em português (jarvis ~ jarbas ~ javis)."""
    s = normalizar(s).replace(" ", "")
    for a, b in (("ph", "f"), ("ch", "x"), ("sh", "x"), ("lh", "li"), ("nh", "ni"), ("qu", "k"), ("gu", "g"),
                 ("aw", "au"), ("ew", "eu"), ("ow", "ou"), ("w", "v"), ("y", "i"), ("z", "s"), ("ç", "s"), ("c", "k"), ("h", ""), ("v", "b"),
                 ("e", "i"), ("o", "u"), ("l", "u")):
        s = s.replace(a, b)
    return re.sub(r"(.)\1+", r"\1", s)


# palavras comuns que disputam com o nome na gramática do detector: sem elas, qualquer som
# parecido vira "nome"
DISTRATORES = """a o e é de da do que não sim um uma eu você ele ela isso aqui ali agora hoje então
mas por para com sem mais muito pouco bom boa bem tudo nada certo coisa casa carro caro cara
carinho carrinho carinha marina catarina karina carla carlos maria mário marcos jardim jarra
jornal janela jogo gente gato galo garrafa garagem quarto quarenta quando quanto qual quem
como onde aonde porque obrigado tchau olá oi ei ok vamos vai vou foi era tem ter fazer faz
liga ligar abre abrir fecha fechar toca tocar para parar pode põe olha escuta ouve fala diz
computador servidor pasta arquivo música vídeo luz som volume tela""".split()


def variantes_nome(nome):
    """Grafias próximas do nome; as que não existem no vocabulário o Vosk ignora."""
    base = normalizar(nome).strip()
    vs = {base, base.replace(" ", "")}
    for a, b in (("k", "c"), ("c", "k"), ("qu", "k"), ("i", "e"), ("e", "i"), ("y", "i"), ("v", "b"),
                 ("w", "v"), ("ph", "f"), ("s", "z"), ("z", "s"), ("ch", "x"), ("th", "t")):
        for v in list(vs):
            if a in v:
                vs.add(v.replace(a, b))
    for v in list(vs):
        if v and v[-1] in "aeiou":
            vs.add(v[:-1])
        else:
            vs.update({v + "a", v + "e"})
    return {v for v in vs if len(v) >= 3}


class DetectorNome:
    def __init__(self, nome, apelidos=(), sensibilidade=0.78):
        self.nome = nome
        self.apelidos = list(apelidos)
        self.alvos = {fonetico(n) for n in [nome, *apelidos] if fonetico(n)}
        self.palavras_nome = max(1, *(len(normalizar(n).split()) for n in [nome, *apelidos]))
        self.sens = sensibilidade

    def posicao(self, texto):
        """Índice (em palavras) logo depois do nome, ou None se o nome não aparece."""
        pal = normalizar(texto).split()
        for i in range(len(pal)):
            for k in range(1, self.palavras_nome + 2):
                if i + k > len(pal):
                    break
                cand = fonetico("".join(pal[i:i + k]))
                if len(cand) < 3:
                    continue
                for alvo in self.alvos:
                    if len(cand) < 0.75 * len(alvo):    # pedaço curto do nome não conta ("se três")
                        continue
                    lim = self.sens + (0.08 if len(alvo) <= 4 else 0)
                    if cand == alvo or difflib.SequenceMatcher(None, cand, alvo).ratio() >= lim:
                        return i + k
        return None

    def gramatica(self):
        """Lista para um reconhecedor Vosk restrito: o nome, grafias vizinhas e distratores."""
        nomes = set()
        for n in [self.nome, *self.apelidos]:
            nomes |= variantes_nome(n)
            nomes |= set(normalizar(n).split())
        self.palavras_gramatica = nomes
        return sorted(nomes | set(DISTRATORES)) + ["[unk]"]

    def na_gramatica(self, texto):
        """O reconhecedor restrito decodificou alguma grafia do nome?"""
        pal = normalizar(texto).split()
        frase = " ".join(pal)
        for n in [self.nome, *self.apelidos]:
            alvo = " ".join(normalizar(n).split())
            if len(alvo.split()) > 1 and alvo in frase:
                return True
        if len(normalizar(self.nome).split()) > 1:      # nome de várias palavras: só a sequência vale
            return self.posicao(frase) is not None
        return any(p in self.palavras_gramatica and fonetico(p) and
                   difflib.SequenceMatcher(None, fonetico(p), fonetico(self.nome)).ratio() >= 0.7 for p in pal)


# ---------------------------------------------------------------- fontes de áudio
class FonteMicrofone:
    """Lê o microfone pelo PipeWire/PulseAudio (parec), já em 16 kHz mono."""

    def __init__(self, dispositivo=None):
        self.dispositivo = dispositivo
        self.proc = None

    def abrir(self):
        cmd = ["parec", "--raw", "--format=s16le", f"--rate={TAXA_MIC}", "--channels=1",
               "--latency-msec=60", "--client-name=ultron", "--stream-name=escuta"]
        if self.dispositivo:
            cmd.append(f"--device={self.dispositivo}")
        self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

    def ler(self):
        if self.proc is None:
            self.abrir()
        dados = self.proc.stdout.read(BLOCO * 2)
        if not dados:
            self.fechar()
            time.sleep(0.5)
            return None
        return dados

    def fechar(self):
        if self.proc:
            self.proc.kill()
            self.proc.wait()
            self.proc = None


class FonteWav:
    """Para teste: toca um .wav 16 kHz como se fosse o microfone, em tempo real."""

    def __init__(self, caminho, silencio_final=4.0):
        with wave.open(caminho) as w:
            assert w.getframerate() == TAXA_MIC and w.getnchannels() == 1 and w.getsampwidth() == 2, "wav 16k mono s16"
            self.dados = w.readframes(w.getnframes()) + b"\0" * int(TAXA_MIC * 2 * silencio_final)
        self.pos = 0
        self.fim = threading.Event()

    def ler(self):
        if self.pos >= len(self.dados):
            self.fim.set()
            time.sleep(0.1)
            return b"\0" * BLOCO * 2
        b = self.dados[self.pos:self.pos + BLOCO * 2]
        self.pos += len(b)
        time.sleep(BLOCO / TAXA_MIC)
        return b.ljust(BLOCO * 2, b"\0")

    def fechar(self):
        pass


def listar_microfones():
    """[(nome_interno, descrição)] das entradas do PipeWire/PulseAudio, sem monitores."""
    try:
        saida = subprocess.run(["pactl", "-f", "json", "list", "sources"], capture_output=True, text=True, timeout=5).stdout
        fontes = json.loads(saida)
    except Exception:
        return []
    return [(f["name"], f.get("description") or f["name"]) for f in fontes
            if not f["name"].endswith(".monitor") and f.get("monitor_of_sink") in (None, "", "n/a")
            and not f["name"].startswith("ultron_")]


def palavras(texto):
    return [p for p in normalizar(texto).split() if len(p) >= 3]


def parecido_em_sequencia(trecho, texto):
    """Quanto `trecho` se parece com algum pedaço contínuo de `texto` (0..1). O eco repete as
    palavras dela na mesma ordem, mesmo mal reconhecidas ("deixado" no lugar de "fechado")."""
    a = " ".join(normalizar(trecho).split())
    pal = normalizar(texto).split()
    if not a or not pal:
        return 0.0
    n = len(a.split())
    melhor = 0.0
    for tam in (n - 1, n, n + 1):
        if tam < 1:
            continue
        for i in range(0, max(1, len(pal) - tam + 1)):
            melhor = max(melhor, difflib.SequenceMatcher(None, a, " ".join(pal[i:i + tam])).ratio())
    return melhor


class CancelaEco:
    """Cancelador de eco do PipeWire (WebRTC) entre o microfone e a saída de som.
    A voz dela toca em `ultron_saida` e o microfone é lido de `ultron_microfone`, que já chega
    sem a própria voz. É isso que deixa interromper falando, mesmo com caixa de som."""

    FONTE, SAIDA = "ultron_microfone", "ultron_saida"

    def __init__(self):
        self.modulo = None

    def _sobras(self):
        try:
            saida = subprocess.run(["pactl", "list", "modules", "short"], capture_output=True, text=True, timeout=5).stdout
        except Exception:
            return []
        return [l.split()[0] for l in saida.splitlines() if "module-echo-cancel" in l and f"source_name={self.FONTE}" in l]

    def ligar(self, microfone=None):
        self.desligar()
        for m in self._sobras():          # de uma execução que caiu sem limpar
            subprocess.run(["pactl", "unload-module", m], capture_output=True)
        cmd = ["pactl", "load-module", "module-echo-cancel", "aec_method=webrtc",
               f"source_name={self.FONTE}", f"sink_name={self.SAIDA}"]
        if microfone:
            cmd.append(f"source_master={microfone}")
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        if r.returncode == 0 and r.stdout.strip().isdigit():
            self.modulo = r.stdout.strip()
            return True
        return False

    def desligar(self):
        if self.modulo:
            subprocess.run(["pactl", "unload-module", self.modulo], capture_output=True)
            self.modulo = None


# ---------------------------------------------------------------- ouvinte
GRACA = 1.2          # s de silêncio depois do fim de uma frase antes de mandar (pausa curta não corta)


class Ouvinte(threading.Thread):
    """Escuta o tempo todo. Em espera só procura o nome. Depois do nome entra em modo conversa:
    cada frase vai para a base sem precisar repetir o nome, falar por cima interrompe a resposta,
    e a conversa fecha sozinha depois de `tempo_conversa` s de silêncio."""

    def __init__(self, modelo_vosk, detector, fonte, ao_acordar, ao_falar, ao_estado=None, ao_interromper=None,
                 tocando=None, eh_eco=None, ocupado=None, tempo_conversa=20, fala_clara=None,
                 eco_ref=None, abafar=None, log=None):
        super().__init__(daemon=True)
        from vosk import KaldiRecognizer, Model, SetLogLevel

        SetLogLevel(-1)
        self.modelo = Model(modelo_vosk)
        self.rec = KaldiRecognizer(self.modelo, TAXA_MIC)
        # reconhecedor só do nome: o modo livre do modelo pequeno descarta nomes como "Karin",
        # mas restrito a uma gramática ele acerta
        self.rec_nome = KaldiRecognizer(self.modelo, TAXA_MIC, json.dumps(detector.gramatica(), ensure_ascii=False))
        self.detector = detector
        self.fonte = fonte
        nada = lambda *_: None  # noqa: E731
        self.ao_acordar, self.ao_falar = ao_acordar, ao_falar
        self.ao_estado, self.ao_interromper = ao_estado or nada, ao_interromper or nada
        self.tocando = tocando or (lambda: False)
        self.eh_eco = eh_eco or (lambda t: False)
        self.fala_clara = fala_clara or (lambda t: False)
        self.eco_ref = eco_ref or (lambda t: 0.0)
        self.abafar = abafar or (lambda f: None)
        self.log = log or (lambda *_: None)
        self.ganhos = collections.deque(maxlen=80)     # quanto da voz dela volta pelo microfone
        self.excesso_seq = 0
        self.ultimo_excesso = 0.0
        self.abafado = False
        self.depois_do_corte = False
        self.foco = False               # botão de foco: escuta direto, sem nome e sem fechar a conversa
        self.interromper_por_voz = True  # desligue quando dois assistentes conversam na mesma sala
        self.ocupado = ocupado or (lambda: False)
        self.tempo_conversa = tempo_conversa
        self.pausado = False
        self.modo = "espera"            # espera | conversa
        self.conversa_ate = 0.0
        self.primeiro = False           # a próxima frase é a que trouxe o nome
        self.segmento = collections.deque(maxlen=int(30 * TAXA_MIC / BLOCO))   # áudio desde o último final
        self.pendente = None            # [áudio, texto, mandar_em]
        self.ultimo_parcial = ""
        self.cortou = False
        self.piso = 200.0               # nível de ruído de fundo (RMS), se adapta sozinho
        self.energia = collections.deque(maxlen=4)
        self.eco_nivel = collections.deque(maxlen=60)   # volume do microfone enquanto só ela fala
        self._trava = threading.Lock()
        self.vivo = True

    # ---------- chamados de outras threads
    def pausar(self, sim):
        with self._trava:
            self.pausado = sim
            self._encerrar(avisar=False)
            self.rec.Reset()
            self.segmento.clear()
            if not sim and self.foco:
                self.modo, self.primeiro, self.conversa_ate = "conversa", False, float("inf")

    def abrir_janela(self, segundos):
        """Entra (ou continua) em conversa sem precisar do nome: clique na esfera ou pedido da base."""
        with self._trava:
            if self.pausado:
                return
            if self.modo != "conversa":
                self.modo, self.primeiro = "conversa", False
                self.ao_estado("conversa")
            self.conversa_ate = max(self.conversa_ate, time.time() + segundos)

    def encerrar_conversa(self):
        with self._trava:
            if not self.foco:
                self._encerrar()

    def definir_foco(self, sim):
        with self._trava:
            self.foco = sim
            if sim and not self.pausado:
                if self.modo != "conversa":
                    self.modo, self.primeiro = "conversa", False
                self.conversa_ate = float("inf")
                self.ao_estado("conversa")
            elif not sim:
                self.conversa_ate = time.time() + self.tempo_conversa

    def _renovar(self, agora):
        self.conversa_ate = float("inf") if self.foco else agora + self.tempo_conversa

    def trocar_fonte(self, fonte):
        with self._trava:
            antiga, self.fonte = self.fonte, fonte
        antiga.fechar()

    # ---------- laço
    def run(self):
        while self.vivo:
            bloco = self.fonte.ler()
            if bloco is None:
                continue
            with self._trava:
                if not self.pausado:
                    self._processar(bloco)

    def _encerrar(self, avisar=True):
        self.modo, self.pendente, self.primeiro = "espera", None, False
        if avisar:
            self.ao_estado("fim_conversa")

    def _mandar(self, agora):
        audio, texto, _ = self.pendente
        self.pendente = None
        origem = "nome" if self.primeiro else ("interrupcao" if self.depois_do_corte else "conversa")
        self.depois_do_corte = False
        self.primeiro = False
        self._renovar(agora)
        self.ao_falar(bytes(audio), texto, origem)

    def _valido(self, texto):
        pal = texto.split()
        return len(pal) >= 2 or any(len(p) >= 3 for p in pal)

    def _fala_por_cima(self, agora, rms):
        """Detector de fala dupla: compara o microfone com o que ela está tocando agora.
        Sem cancelador de eco a voz dela volta alta no microfone; o que passa muito do eco
        previsto é o usuário falando junto."""
        ref = self.eco_ref(agora)
        if ref > 300 and self.excesso_seq == 0:
            self.ganhos.append(rms / ref)
        ganho = sorted(self.ganhos)[int(len(self.ganhos) * 0.35)] if len(self.ganhos) >= 10 else 0.6
        previsto = ganho * ref
        # margem folgada: outra voz ou barulho na sala não pode ficar abaixando a voz dela
        excesso = rms > max(2.6 * previsto + 3 * self.piso, 5 * self.piso, 350)
        self.excesso_seq = self.excesso_seq + 1 if excesso else 0
        if excesso:
            self.ultimo_excesso = agora
        if self.excesso_seq >= 3 and not self.abafado:
            self.abafado = True
            self.abafar(0.35)                     # baixa a voz para ouvir melhor o usuário
            self.log(f"[abafou: mic {rms:.0f} x eco previsto {previsto:.0f}]")
        elif self.abafado and not excesso and agora - self.ultimo_excesso > 1.5:
            self.abafado = False
            self.abafar(1.0)
        if self.excesso_seq >= 8:                 # 0,8 s falando junto: corta
            self.log(f"[corte por volume: mic {rms:.0f} x eco previsto {previsto:.0f}]")
            self._cortar()

    def _cortar(self):
        self.cortou = True
        self.depois_do_corte = True
        self.excesso_seq = 0
        ultimos = list(self.segmento)[-int(2.5 * TAXA_MIC / BLOCO):]
        self.segmento.clear()
        self.segmento.extend(ultimos)
        self.ao_interromper()

    def _mais_alto_que_eco(self):
        """A voz dela chega baixa no microfone; a do usuário, perto dele, chega bem mais alta."""
        if len(self.eco_nivel) < 5:
            return True
        ref = sorted(self.eco_nivel)[int(len(self.eco_nivel) * 0.8)]
        return max(self.energia) > max(1.8 * ref, 3 * self.piso)

    def _voz_agora(self):
        """O Vosk demora ~0,4 s para mostrar palavra quando a fala recomeça; a energia não."""
        return any(e > max(3 * self.piso, 350) for e in self.energia)

    def _processar(self, bloco):
        agora = time.time()
        a = np.frombuffer(bloco, dtype=np.int16).astype(np.float32)
        rms = float(np.sqrt(np.mean(a * a)))
        self.energia.append(rms)
        self.piso = min(rms, self.piso * 1.002) if rms < self.piso * 1.002 else self.piso * 1.002
        self.piso = max(self.piso, 30.0)
        self.segmento.append(bloco)
        if self.pendente:
            self.pendente[0].extend(bloco)
        final, parcial, mudou = None, "", False
        if self.rec.AcceptWaveform(bloco):
            final = json.loads(self.rec.Result()).get("text", "").strip()
            self.ultimo_parcial = ""
        else:
            parcial = json.loads(self.rec.PartialResult()).get("partial", "")
            mudou, self.ultimo_parcial = parcial != self.ultimo_parcial, parcial
        tocando = self.tocando()
        if tocando and not self.cortou and not self.ultimo_parcial:
            self.eco_nivel.append(rms)
        if tocando and self.modo == "conversa" and not self.cortou and self.interromper_por_voz:
            self._fala_por_cima(agora, rms)
        elif self.abafado:
            self.abafado = False
            self.abafar(1.0)

        if self.modo == "espera":
            if self.rec_nome.AcceptWaveform(bloco):
                ouvido_nome = json.loads(self.rec_nome.Result()).get("text", "")
            else:
                ouvido_nome = json.loads(self.rec_nome.PartialResult()).get("partial", "")
            achou = self.detector.na_gramatica(ouvido_nome) or (
                mudou and parcial and self.detector.posicao(parcial) is not None)
            if achou:
                self.rec_nome.Reset()
            if achou and not (tocando and self.eh_eco(parcial)):
                self.modo, self.primeiro = "conversa", True
                self._renovar(agora)
                self.ao_acordar()
            elif final is not None:
                self.segmento.clear()
                return

        if self.modo != "conversa":
            return

        if mudou and parcial:
            eco = tocando and self.eh_eco(parcial)
            # texto que claramente não é a fala dela corta na hora; no caso duvidoso o volume decide
            if (tocando and not eco and len(parcial.split()) >= 4 and not self.cortou and self.interromper_por_voz
                    and self.fala_clara(parcial)):
                # falou por cima: corta a resposta e guarda só o começo da fala nova
                self._cortar()
            if not eco:
                self._renovar(agora)
                self.ao_estado("ouvindo")

        if final is not None:
            audio = b"".join(self.segmento)
            self.segmento.clear()
            eco = tocando and not self.cortou and self.eh_eco(final)
            self.cortou = False
            if final and not eco and self._valido(final):
                if self.pendente:                      # continuação depois de uma pausa curta
                    self.pendente[1] += " " + final
                    self.pendente[2] = agora + GRACA
                else:
                    self.pendente = [bytearray(audio), final, agora + GRACA]
            elif not self.pendente:
                self.ao_estado("conversa")

        if self.pendente and agora >= self.pendente[2] and not self.ultimo_parcial and not self._voz_agora():
            self._mandar(agora)

        if tocando or self.ocupado() or self.pendente or self.ultimo_parcial:
            self.conversa_ate = max(self.conversa_ate, agora + self.tempo_conversa)
        elif agora > self.conversa_ate:
            self._encerrar()


# ---------------------------------------------------------------- reprodução
class Reprodutor:
    """Toca a voz pelo pacat (no dispositivo do cancelador de eco, quando existe), no ritmo do
    relógio: nunca mais que ~0,12 s adiantado, para que cortar a fala seja instantâneo."""

    ADIANTE = 0.12
    PEDACO = 1920          # 40 ms a 24 kHz s16

    def __init__(self, gravar_em=None, dispositivo=None, volume=1.0):
        self.volume = volume       # 0..1,5, botão de volume do gadget
        self.abafar = 1.0          # baixa a voz na hora em que o usuário começa a falar por cima
        self._abafar_atual = 1.0
        self.saida_hist = collections.deque(maxlen=300)   # (quando fica audível, rms que saiu)
        self.buf = bytearray()
        self.trava = threading.Lock()
        self.nivel = 0.0
        self.fim_previsto = 0.0
        self.dispositivo = dispositivo
        self.proc = None
        self.gravar = None
        if gravar_em:
            self.gravar = wave.open(gravar_em, "wb")
            self.gravar.setnchannels(1)
            self.gravar.setsampwidth(2)
            self.gravar.setframerate(TAXA_VOZ)
        threading.Thread(target=self._tocar, daemon=True).start()

    def _abrir(self):
        cmd = ["pacat", "--playback", "--raw", "--format=s16le", f"--rate={TAXA_VOZ}", "--channels=1",
               "--latency-msec=60", "--client-name=ultron", "--stream-name=voz"]
        if self.dispositivo:
            cmd.append(f"--device={self.dispositivo}")
        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)

    def _tocar(self):
        t0, enviado = time.time(), 0.0
        while True:
            agora = time.time()
            if enviado < agora - t0:           # ficou parado: recomeça o relógio
                t0, enviado = agora, 0.0
            if enviado - (agora - t0) > self.ADIANTE:
                time.sleep(0.01)
                continue
            with self.trava:
                dados = bytes(self.buf[:self.PEDACO])
                del self.buf[:self.PEDACO]
            if not dados:
                self.nivel *= 0.8
                time.sleep(0.02)
                continue
            a = np.frombuffer(dados, dtype=np.int16).astype(np.float32)
            rms = float(np.sqrt(np.mean(a * a)))
            self.nivel = min(1.0, rms / 32768.0 * 4.0)
            self._abafar_atual += (self.abafar - self._abafar_atual) * 0.25   # rampa, sem degrau
            fator = self.volume * self._abafar_atual
            if fator != 1.0:
                dados = np.clip(a * fator, -32768, 32767).astype(np.int16).tobytes()
            self.saida_hist.append((t0 + enviado + 0.06, rms * fator))
            enviado += len(dados) / (2 * TAXA_VOZ)
            self.fim_previsto = t0 + enviado + 0.06
            if self.gravar:
                self.gravar.writeframes(dados)
                continue
            try:
                if self.proc is None or self.proc.poll() is not None:
                    self._abrir()
                self.proc.stdin.write(dados)
                self.proc.stdin.flush()
            except (BrokenPipeError, OSError):
                self.proc = None

    def adicionar(self, pcm):
        with self.trava:
            self.buf.extend(pcm)

    def limpar(self):
        with self.trava:
            self.buf.clear()
        self.fim_previsto = 0.0
        self.abafar = 1.0

    def eco_ref(self, t, janela=0.5):
        """Maior volume que ela tocou no meio segundo antes de `t` (o eco chega com atraso)."""
        return max((r for ts, r in list(self.saida_hist) if t - janela - 0.15 <= ts <= t), default=0.0)

    def tocando(self):
        with self.trava:
            cheio = len(self.buf) > 0
        return cheio or time.time() < self.fim_previsto + 0.15

    def trocar_dispositivo(self, dispositivo):
        self.dispositivo = dispositivo
        if self.proc:
            self.proc.kill()
            self.proc = None

    def fechar(self):
        if self.proc:
            self.proc.kill()
        if self.gravar:
            time.sleep(0.3)
            self.gravar.close()
