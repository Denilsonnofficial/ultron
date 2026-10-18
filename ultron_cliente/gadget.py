"""Gadget flutuante: esfera com ondas sonoras e quatro botões (microfone, tema, volume e base)."""
import math
import random
import time

from PySide6.QtCore import QPointF, QRectF, Qt, QTimer, Signal
from PySide6.QtGui import (QAction, QBrush, QColor, QCursor, QPainter, QPainterPath, QPen, QRadialGradient,
                           QRegion)
from PySide6.QtGui import QFont
from PySide6.QtWidgets import QMenu, QWidget

L, A = 240, 262          # tamanho da janela
CX, CY, R = 120, 118, 50  # centro e raio da esfera
BOT_Y, BOT_R = 236, 15
BOT_MIC_X, BOT_FOCO_X, BOT_RAC_X, BOT_TEMA_X, BOT_VOL_X, BOT_BASE_X = 30, 66, 102, 138, 174, 210
BOTOES = (("mic", BOT_MIC_X), ("foco", BOT_FOCO_X), ("raciocinio", BOT_RAC_X), ("tema", BOT_TEMA_X),
          ("volume", BOT_VOL_X), ("base", BOT_BASE_X))
NIVEIS = (("padrao", "Padrão do modelo"), ("baixo", "Baixo (rápido)"), ("medio", "Médio"), ("alto", "Alto"),
          ("maximo", "Máximo (lento)"))

# cor principal e intensidade do brilho por estado (tema Azul; os outros trocam as cores ativas)
CORES = {
    "conectando": ("#e0a040", 0.35),
    "ocioso": ("#3d8bff", 0.45),
    "conversa": ("#38c8ff", 0.75),
    "ouvindo": ("#33e0ff", 1.00),
    "pensando": ("#8f6bff", 0.80),
    "agindo": ("#b26bff", 0.85),
    "falando": ("#2fd6ff", 0.90),
    "mudo": ("#7b8796", 0.30),
    "desligada": ("#4a4f57", 0.15),
}

_FIXAS = ("conectando", "mudo", "desligada")


def _paleta(ocioso, conversa, ouvindo, falando, pensando, agindo):
    return {"ocioso": ocioso, "conversa": conversa, "ouvindo": ouvindo, "falando": falando,
            "pensando": pensando, "agindo": agindo}


def _malha_plasma(n=46, semente=7):
    """Casca amassada de energia (pontos numa esfera deformados) ligada aos vizinhos mais próximos."""
    rnd = random.Random(semente)
    pts = []
    for i in range(n):
        y = 1 - 2 * (i + 0.5) / n
        r = math.sqrt(max(0.0, 1 - y * y))
        ang = i * math.pi * (3 - math.sqrt(5))
        v = (math.cos(ang) * r, y, math.sin(ang) * r)
        k = 0.72 + 0.5 * rnd.random()      # amassado: raios desiguais, como o plasma do filme
        pts.append((v[0] * k, v[1] * k, v[2] * k))
    arestas = set()
    for i, a in enumerate(pts):
        viz = sorted(range(n), key=lambda j: sum((a[c] - pts[j][c]) ** 2 for c in range(3)))[1:4]
        for j in viz:
            arestas.add((min(i, j), max(i, j)))
    fagulhas = [(rnd.random() * 2 * math.pi, rnd.random() * 2 - 1, 0.3 + 0.9 * rnd.random(), rnd.random())
                for _ in range(34)]
    return pts, sorted(arestas), fagulhas


_PLASMA = _malha_plasma()


# skins: estilo de desenho + cores dos estados ativos
TEMAS = {
    "ultron": {"nome": "Ultron (holograma)", "estilo": "ultron",
               "cores": _paleta("#3fa0ff", "#4fb4ff", "#6cc8ff", "#5cc0ff", "#ff4a4a", "#ff7a3a")},
    "c3po": {"nome": "C-3PO", "estilo": "c3po",
             "cores": _paleta("#e8b13c", "#f2c14e", "#ffd36b", "#ffcc4a", "#ff9f2e", "#ffb347")},
    "r2d2": {"nome": "R2-D2", "estilo": "r2d2",
             "cores": _paleta("#3a7bff", "#4f8dff", "#6aa3ff", "#4f8dff", "#ff4040", "#ff6a3a")},
    "sabre": {"nome": "Sabre de luz", "estilo": "sabre",
              "cores": _paleta("#3fa9ff", "#4fb8ff", "#66c8ff", "#7fd4ff", "#ff3b3b", "#4cff6a")},
    "rebelde": {"nome": "Holograma rebelde", "estilo": "rebelde",
                "cores": _paleta("#5fc8ff", "#72d2ff", "#8fdcff", "#7ad7ff", "#5fa8ff", "#9fe8ff")},
    "bb8": {"nome": "BB-8", "estilo": "bb8",
            "cores": _paleta("#ff8a2a", "#ff9a3c", "#ffad55", "#ff9a3c", "#ff7a1a", "#ffb060")},
    "estrela": {"nome": "Estrela da Morte", "estilo": "estrela",
                "cores": _paleta("#9aa3ad", "#a8b1bb", "#b8c0c9", "#5cff6a", "#7cff8a", "#5cff6a")},
    "holograma": {"nome": "Holograma dourado", "estilo": "holograma",
                  "cores": _paleta("#e9b04a", "#f4c463", "#ffd77a", "#ffcf5c", "#ff9d3c", "#ffb84d")},
    "azul": {"nome": "Azul", "estilo": "esfera",
             "cores": _paleta("#3d8bff", "#38c8ff", "#33e0ff", "#2fd6ff", "#8f6bff", "#b26bff")},
    "plasma": {"nome": "Ultron (plasma)", "estilo": "plasma",
               "cores": _paleta("#3aa8ff", "#52bcff", "#7ad0ff", "#62c6ff", "#ff5a4a", "#ff8a3a")},
    "reator": {"nome": "Reator", "estilo": "reator",
               "cores": _paleta("#5fd8ff", "#8ae8ff", "#b8f4ff", "#9eefff", "#5fb4ff", "#ffd36b")},
    "hal": {"nome": "HAL", "estilo": "olho",
            "cores": _paleta("#e0201c", "#ff3b30", "#ff5544", "#ff4433", "#ff7a2a", "#ffaa22")},
    "ambar": {"nome": "Âmbar", "estilo": "esfera",
              "cores": _paleta("#ff9a2a", "#ffb347", "#ffc861", "#ffb02e", "#ff6f3c", "#ff5a36")},
    "esmeralda": {"nome": "Esmeralda", "estilo": "anel",
                  "cores": _paleta("#2ee59d", "#46f0b0", "#7dffc9", "#3cf5a8", "#22c3a6", "#b8ff5a")},
    "neon": {"nome": "Neon", "estilo": "esfera",
             "cores": _paleta("#ff3df2", "#ff5cf4", "#ff8af7", "#ff4fd8", "#8a5cff", "#5cc8ff")},
    "retro": {"nome": "Retrô", "estilo": "pixel",
              "cores": _paleta("#3dff6e", "#66ff8c", "#a0ffb4", "#55ff7f", "#e6ff3d", "#ffd23d")},
    "aurora": {"nome": "Aurora", "estilo": "esfera", "aurora": True,
               "cores": _paleta("#3d8bff", "#38c8ff", "#33e0ff", "#2fd6ff", "#8f6bff", "#b26bff")},
    "grafite": {"nome": "Grafite", "estilo": "anel",
                "cores": _paleta("#c9d1db", "#e6ebf1", "#ffffff", "#f2f5f8", "#aab4c0", "#ffffff")},
}

DESCRICAO = {
    "conectando": "Procurando a base...",
    "ocioso": "Pronto. Diga o nome para chamar.",
    "conversa": "Em conversa: pode falar sem dizer o nome",
    "ouvindo": "Ouvindo",
    "pensando": "Pensando",
    "agindo": "Executando",
    "falando": "Falando",
    "mudo": "Microfone desligado",
    "desligada": "Base desligada",
}


ESTILO_MENU = """
QMenu { background: rgba(14, 19, 28, 215); color: #dfe7f1; border: 1px solid rgba(255,255,255,40);
        border-radius: 10px; padding: 6px; }
QMenu::item { padding: 6px 18px 6px 12px; border-radius: 6px; background: transparent; }
QMenu::item:selected { background: rgba(%s, 70); }
QMenu::separator { height: 1px; background: rgba(255,255,255,30); margin: 4px 8px; }
QMenu::indicator { width: 12px; height: 12px; }
"""


class PainelVolume(QWidget):
    """Balão translúcido com a barra de volume na cor do tema (some ao clicar fora)."""

    LARG, ALT = 220, 46

    def __init__(self, gadget):
        super().__init__(gadget, Qt.Popup | Qt.FramelessWindowHint | Qt.NoDropShadowWindowHint)
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.setAttribute(Qt.WA_DeleteOnClose)
        self.gadget = gadget
        self.resize(self.LARG, self.ALT)
        self.arrastando = False
        self.setMouseTracking(True)

    def _x_trilho(self):
        return 46, self.LARG - 54

    def paintEvent(self, _):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        cor = QColor(self.gadget.cor)
        p.setPen(QPen(QColor(255, 255, 255, 45), 1))
        p.setBrush(QColor(12, 17, 26, 190))
        p.drawRoundedRect(QRectF(0.5, 0.5, self.LARG - 1, self.ALT - 1), 16, 16)
        v = self.gadget.reprodutor.volume
        # ícone pequeno
        p.setPen(QPen(QColor("#dfe7f1"), 1.6, Qt.SolidLine, Qt.RoundCap, Qt.RoundJoin))
        cy = self.ALT / 2
        cone = QPainterPath()
        cone.moveTo(14, cy - 3)
        cone.lineTo(18, cy - 3)
        cone.lineTo(22, cy - 7)
        cone.lineTo(22, cy + 7)
        cone.lineTo(18, cy + 3)
        cone.lineTo(14, cy + 3)
        cone.closeSubpath()
        p.drawPath(cone)
        if v > 0:
            p.drawArc(QRectF(20, cy - 5, 10, 10), -50 * 16, 100 * 16)
        # trilho
        x0, x1 = self._x_trilho()
        trilho = QColor(255, 255, 255, 40)
        p.setPen(QPen(trilho, 4, Qt.SolidLine, Qt.RoundCap))
        p.drawLine(QPointF(x0, cy), QPointF(x1, cy))
        xv = x0 + (x1 - x0) * v / 1.5
        cheio = QColor(cor)
        cheio.setAlphaF(0.95)
        p.setPen(QPen(cheio, 4, Qt.SolidLine, Qt.RoundCap))
        p.drawLine(QPointF(x0, cy), QPointF(xv, cy))
        # marca do 100%
        x100 = x0 + (x1 - x0) / 1.5
        p.setPen(QPen(QColor(255, 255, 255, 70), 1))
        p.drawLine(QPointF(x100, cy - 6), QPointF(x100, cy + 6))
        # botão com brilho
        brilho = QColor(cor)
        brilho.setAlphaF(0.35)
        p.setPen(Qt.NoPen)
        p.setBrush(brilho)
        p.drawEllipse(QPointF(xv, cy), 10, 10)
        p.setBrush(QColor(cor).lighter(130))
        p.drawEllipse(QPointF(xv, cy), 6, 6)
        # percentual
        p.setPen(QColor("#dfe7f1"))
        fonte = QFont(self.font())
        fonte.setPointSizeF(9.5)
        p.setFont(fonte)
        p.drawText(QRectF(x1 + 8, 0, self.LARG - x1 - 12, self.ALT), Qt.AlignVCenter | Qt.AlignLeft, f"{round(v * 100)}%")
        p.end()

    def _aplicar(self, x):
        x0, x1 = self._x_trilho()
        v = max(0.0, min(1.5, (x - x0) / (x1 - x0) * 1.5))
        if abs(v - 1.0) < 0.04:            # gruda no 100%
            v = 1.0
        self.gadget.definir_volume(round(v * 20) / 20)
        self.update()
        self.gadget.update()

    def mousePressEvent(self, ev):
        if not self.rect().contains(ev.position().toPoint()):
            self.close()
            return
        self.arrastando = True
        self._aplicar(ev.position().x())

    def mouseMoveEvent(self, ev):
        if self.arrastando:
            self._aplicar(ev.position().x())

    def mouseReleaseEvent(self, _):
        self.arrastando = False

    def wheelEvent(self, ev):
        passo = 0.05 if ev.angleDelta().y() > 0 else -0.05
        self.gadget.definir_volume(self.gadget.reprodutor.volume + passo)
        self.update()


class Gadget(QWidget):
    sinal_estado = Signal(str, str)

    def __init__(self, reprodutor, acoes, posicao=None, tema="azul"):
        super().__init__(None, Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.Tool | Qt.WindowDoesNotAcceptFocus)
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.setWindowTitle("Ultron")
        self.resize(L, A)
        self.reprodutor = reprodutor
        self.acoes = acoes      # dict: clicar_esfera, mudo, base, microfones, trocar_microfone, reconfigurar, sair, mover
        self.tema = tema if tema in TEMAS else "ultron"
        self.estado = "conectando"
        self.detalhe = ""
        self.mudo = False
        self.foco = False
        self.raciocinio = "padrao"
        self.ligada = True
        self.nivel = 0.0
        self.cor = QColor(CORES["conectando"][0])
        self.brilho = 0.3
        self.t0 = time.time()
        self.ondas = []          # anéis que se expandem quando ela fala
        self.ultimo_anel = 0.0
        self.sobre = None
        self.dentro = False      # mouse em cima: os botões só aparecem assim
        self.opac_botoes = 0.0
        self.arraste = None
        self.sinal_estado.connect(self._estado)
        self.setMouseTracking(True)
        reg = QRegion(CX - 112, CY - 112, 224, 224, QRegion.Ellipse)
        for _, x in BOTOES:
            reg = reg.united(QRegion(x - BOT_R - 3, BOT_Y - BOT_R - 3, 2 * BOT_R + 6, 2 * BOT_R + 6, QRegion.Ellipse))
        self.setMask(reg)
        if posicao:
            self.move(*posicao)
        else:
            tela = self.screen().availableGeometry()
            self.move(tela.right() - L - 30, tela.bottom() - A - 30)
        self.timer = QTimer(self)
        self.timer.timeout.connect(self.update)
        self.timer.start(16)
        self._tooltip()

    # ------------------------------------------------------------ estado
    def definir_estado(self, valor, detalhe=""):
        self.sinal_estado.emit(valor, detalhe)

    def _estado(self, valor, detalhe):
        self.estado, self.detalhe = valor, detalhe
        self._tooltip()

    def _efetivo(self):
        if not self.ligada:
            return "desligada"
        if self.mudo and self.estado not in ("falando", "pensando", "agindo"):
            return "mudo"
        if self.reprodutor.tocando():
            return "falando"
        return self.estado

    def _tooltip(self):
        txt = DESCRICAO.get(self._efetivo(), "")
        if self.detalhe and self.estado == "agindo":
            txt += f": {self.detalhe[:80]}"
        self.setToolTip(txt)

    # ------------------------------------------------------------ desenho
    def paintEvent(self, _):
        est = self._efetivo()
        tema = TEMAS[self.tema]
        t = time.time() - self.t0
        alvo_cor, alvo_brilho = CORES.get(est, CORES["ocioso"])
        if est not in _FIXAS:
            alvo_cor = tema["cores"].get(est, alvo_cor)
        alvo = QColor(alvo_cor)
        if tema.get("aurora") and est not in _FIXAS:
            alvo = QColor.fromHsvF((t * 0.04 + (0.08 if est in ("pensando", "agindo") else 0)) % 1.0, 0.75, 1.0)
        k = 0.12
        self.cor = QColor(
            int(self.cor.red() + (alvo.red() - self.cor.red()) * k),
            int(self.cor.green() + (alvo.green() - self.cor.green()) * k),
            int(self.cor.blue() + (alvo.blue() - self.cor.blue()) * k),
        )
        self.brilho += (alvo_brilho - self.brilho) * k
        bruto = self.reprodutor.nivel if est == "falando" else 0.0
        self.nivel += (bruto - self.nivel) * (0.5 if bruto > self.nivel else 0.15)

        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        centro = QPointF(CX, CY)

        # halo
        respiro = 0.5 + 0.5 * math.sin(t * (1.2 if est == "ocioso" else 3.0))
        raio_halo = R + 22 + 8 * respiro * self.brilho + 40 * self.nivel
        g = QRadialGradient(centro, raio_halo)
        c1 = QColor(self.cor)
        c1.setAlphaF(min(1.0, 0.30 * self.brilho + 0.35 * self.nivel))
        c2 = QColor(self.cor)
        c2.setAlphaF(0.0)
        g.setColorAt(R / raio_halo, c1)
        g.setColorAt(1.0, c2)
        p.setPen(Qt.NoPen)
        p.setBrush(QBrush(g))
        p.drawEllipse(centro, raio_halo, raio_halo)

        if tema["estilo"] != "olho":
            self._aneis_de_som(p, est, t, centro)
        getattr(self, "_estilo_" + tema["estilo"])(p, est, t, centro)

        alvo_opac = 1.0 if self.dentro or self.arraste is not None else 0.0
        self.opac_botoes += (alvo_opac - self.opac_botoes) * (0.25 if alvo_opac else 0.12)
        if self.opac_botoes > 0.01:
            p.setOpacity(self.opac_botoes)
            self._botao(p, BOT_MIC_X, "mic", ativo=not self.mudo)
            self._botao(p, BOT_FOCO_X, "foco", ativo=self.foco)
            self._botao(p, BOT_RAC_X, "raciocinio", ativo=True)
            self._botao(p, BOT_TEMA_X, "tema", ativo=True)
            self._botao(p, BOT_VOL_X, "volume", ativo=self.reprodutor.volume > 0)
            self._botao(p, BOT_BASE_X, "base", ativo=self.ligada)
            p.setOpacity(1.0)
        p.end()

    # ------------------------------------------------------------ estilos
    def _aneis_de_som(self, p, est, t, centro):
        # anéis de som
        if est == "falando" and self.nivel > 0.18 and t - self.ultimo_anel > 0.22:
            self.ondas.append([t, 0.4 + self.nivel])
            self.ultimo_anel = t
        vivos = []
        for ini, forca in self.ondas:
            idade = t - ini
            if idade < 1.4:
                vivos.append([ini, forca])
                rr = R + 4 + idade * 45
                c = QColor(self.cor)
                c.setAlphaF(max(0.0, (1 - idade / 1.4)) * 0.55 * min(1.0, forca))
                p.setPen(QPen(c, 2.0))
                p.setBrush(Qt.NoBrush)
                p.drawEllipse(centro, rr, rr)
        self.ondas = vivos


    def _barras(self, p, est, t, raio, n=72, largura=2.2):
        for i in range(n):
            ang = i / n * 2 * math.pi
            if est == "falando":
                onda = 0.55 + 0.45 * math.sin(ang * 3 + t * 7) * math.sin(ang * 5 - t * 4)
                comp = 3 + self.nivel * 34 * abs(onda)
            elif est in ("ouvindo", "conversa"):
                comp = 3 + 5 * (0.5 + 0.5 * math.sin(ang * 6 - t * 6))
            else:
                comp = 2 + 1.5 * (0.5 + 0.5 * math.sin(ang * 4 + t * 1.5))
            c = QColor(self.cor)
            c.setAlphaF(0.25 + 0.6 * self.brilho * (0.6 + 0.4 * min(1, comp / 20)))
            p.setPen(QPen(c, largura, Qt.SolidLine, Qt.RoundCap))
            p.drawLine(QPointF(CX + math.cos(ang) * raio, CY + math.sin(ang) * raio),
                       QPointF(CX + math.cos(ang) * (raio + comp), CY + math.sin(ang) * (raio + comp)))

    def _arco_pensando(self, p, est, t, raio, largura=3):
        if est in ("pensando", "agindo"):
            c = QColor(self.cor).lighter(150)
            p.setPen(QPen(c, largura, Qt.SolidLine, Qt.RoundCap))
            caixa = QRectF(CX - raio, CY - raio, 2 * raio, 2 * raio)
            ini = int(-t * 360 * (1.4 if est == "agindo" else 0.9)) % 360
            p.drawArc(caixa, ini * 16, 80 * 16)
            p.drawArc(caixa, (ini + 180) * 16, 40 * 16)

    def _amp(self, est):
        return {"falando": 4 + 26 * self.nivel, "ouvindo": 8, "conversa": 4, "pensando": 3, "agindo": 3}.get(est, 1.5)

    def _estilo_esfera(self, p, est, t, centro):
        self._barras(p, est, t, R + 6)
        # esfera
        g = QRadialGradient(QPointF(CX - R * 0.35, CY - R * 0.4), R * 1.5)
        g.setColorAt(0.0, QColor(self.cor).lighter(165))
        g.setColorAt(0.45, QColor(self.cor).darker(160))
        g.setColorAt(1.0, QColor(self.cor).darker(420))
        p.setPen(QPen(QColor(255, 255, 255, int(40 + 60 * self.brilho)), 1.2))
        p.setBrush(QBrush(g))
        p.drawEllipse(centro, R, R)
        # ondas sonoras dentro da esfera
        p.save()
        recorte = QPainterPath()
        recorte.addEllipse(centro, R - 2, R - 2)
        p.setClipPath(recorte)
        amp_base = self._amp(est)
        for j, (fase, freq, alfa) in enumerate(((0.0, 1.6, 0.95), (2.1, 2.3, 0.55), (4.0, 1.1, 0.40))):
            cam = QPainterPath()
            for x in range(-R, R + 1, 2):
                env = math.cos(x / R * math.pi / 2) ** 2          # some nas bordas
                y = math.sin(x / R * math.pi * freq + t * (5 + j) + fase) * amp_base * env
                pt = QPointF(CX + x, CY + y)
                cam.moveTo(pt) if x == -R else cam.lineTo(pt)
            c = QColor(255, 255, 255)
            c.setAlphaF(alfa * (0.35 + 0.65 * self.brilho))
            p.setPen(QPen(c, 2.0 if j == 0 else 1.4))
            p.setBrush(Qt.NoBrush)
            p.drawPath(cam)
        p.restore()
        self._arco_pensando(p, est, t, R + 12)
        self._especular(p)

    def _especular(self, p, forca=90):
        g = QRadialGradient(QPointF(CX - R * 0.38, CY - R * 0.48), R * 0.5)
        g.setColorAt(0.0, QColor(255, 255, 255, forca))
        g.setColorAt(1.0, QColor(255, 255, 255, 0))
        p.setPen(Qt.NoPen)
        p.setBrush(QBrush(g))
        p.drawEllipse(QPointF(CX - R * 0.38, CY - R * 0.48), R * 0.5, R * 0.5)

    # esfera de malha: pontos distribuídos na superfície (espiral de Fibonacci)
    _PONTOS = [(math.cos(math.pi * (1 + 5 ** 0.5) * i) * math.sqrt(1 - (1 - 2 * (i + 0.5) / 260) ** 2),
                1 - 2 * (i + 0.5) / 260,
                math.sin(math.pi * (1 + 5 ** 0.5) * i) * math.sqrt(1 - (1 - 2 * (i + 0.5) / 260) ** 2))
               for i in range(260)]

    def _estilo_holograma(self, p, est, t, centro):
        """Globo holográfico dourado: malha girando em 3D, anéis de HUD e núcleo luminoso."""
        cor = QColor(self.cor)
        vel = {"ouvindo": 0.9, "conversa": 0.5, "pensando": 1.6, "agindo": 2.2, "falando": 0.7}.get(est, 0.25)
        self._giro = getattr(self, "_giro", 0.0) + vel * 0.016
        rot, incl = self._giro, 0.35
        raio = R * (0.92 + 0.10 * self.nivel + 0.015 * math.sin(t * 2))
        cr, sr, ci, si = math.cos(rot), math.sin(rot), math.cos(incl), math.sin(incl)

        def projetar(x, y, z):
            x, z = x * cr + z * sr, -x * sr + z * cr          # gira no eixo vertical
            y, z = y * ci - z * si, y * si + z * ci           # inclina
            return CX + x * raio, CY + y * raio, z

        # núcleo luminoso
        g = QRadialGradient(centro, raio * 0.75)
        c0 = QColor(255, 236, 190)
        c0.setAlphaF(min(1.0, 0.55 * self.brilho + 0.5 * self.nivel))
        c1 = QColor(cor)
        c1.setAlphaF(0.25 * self.brilho + 0.2 * self.nivel)
        c2 = QColor(cor)
        c2.setAlphaF(0.0)
        g.setColorAt(0.0, c0)
        g.setColorAt(0.35, c1)
        g.setColorAt(1.0, c2)
        p.setPen(Qt.NoPen)
        p.setBrush(QBrush(g))
        p.drawEllipse(centro, raio * 0.75, raio * 0.75)
        # paralelos e meridianos (traço fino, a parte da frente mais forte)
        p.setBrush(Qt.NoBrush)
        for lat in (-0.75, -0.4, 0.0, 0.4, 0.75):
            r_lat = math.sqrt(1 - lat * lat)
            ant = None
            for k in range(49):
                a = k / 48 * 2 * math.pi
                pt = projetar(math.cos(a) * r_lat, lat, math.sin(a) * r_lat)
                if ant:
                    c = QColor(cor)
                    c.setAlphaF((0.10 + 0.35 * (pt[2] + 1) / 2) * (0.5 + 0.5 * self.brilho))
                    p.setPen(QPen(c, 1.0))
                    p.drawLine(QPointF(ant[0], ant[1]), QPointF(pt[0], pt[1]))
                ant = pt
        for m in range(6):
            lon = m / 6 * math.pi
            ant = None
            for k in range(41):
                a = -math.pi / 2 + k / 40 * math.pi * 2
                pt = projetar(math.cos(a) * math.cos(lon), math.sin(a), math.cos(a) * math.sin(lon))
                if ant:
                    c = QColor(cor)
                    c.setAlphaF((0.08 + 0.30 * (pt[2] + 1) / 2) * (0.5 + 0.5 * self.brilho))
                    p.setPen(QPen(c, 0.9))
                    p.drawLine(QPointF(ant[0], ant[1]), QPointF(pt[0], pt[1]))
                ant = pt
        # pontos da malha: tremem com a voz
        p.setPen(Qt.NoPen)
        for i, (x, y, z) in enumerate(self._PONTOS):
            tremor = 1 + (0.08 * self.nivel * math.sin(i * 1.3 + t * 12) if est == "falando" else 0)
            px, py, pz = projetar(x * tremor, y * tremor, z * tremor)
            prof = (pz + 1) / 2
            c = QColor(255, 225, 150) if prof > 0.8 else QColor(cor)
            c.setAlphaF((0.15 + 0.85 * prof) * (0.45 + 0.55 * self.brilho))
            p.setBrush(c)
            tam = 0.7 + 1.5 * prof
            p.drawEllipse(QPointF(px, py), tam, tam)
        # anéis de HUD girando em sentidos opostos
        for k, (rr, vel_a, arcos) in enumerate(((R + 9, 25, 3), (R + 15, -15, 5))):
            c = QColor(cor)
            c.setAlphaF(0.25 + 0.45 * self.brilho)
            p.setPen(QPen(c, 1.6 if k == 0 else 1.0, Qt.SolidLine, Qt.FlatCap))
            caixa = QRectF(CX - rr, CY - rr, 2 * rr, 2 * rr)
            for j in range(arcos):
                ini = (j * 360 / arcos + t * vel_a * (1 + 2 * self.nivel)) % 360
                p.drawArc(caixa, int(ini * 16), int(360 / arcos * 0.55 * 16))
        # marcações ao redor, que crescem com a voz
        for i in range(60):
            ang = i / 60 * 2 * math.pi
            comp = 2 + (self.nivel * 14 * abs(math.sin(ang * 4 + t * 6)) if est == "falando" else 0)
            if i % 5 == 0:
                comp += 2
            c = QColor(cor)
            c.setAlphaF(0.2 + 0.5 * self.brilho)
            p.setPen(QPen(c, 1.2))
            r1 = R + 19
            p.drawLine(QPointF(CX + math.cos(ang) * r1, CY + math.sin(ang) * r1),
                       QPointF(CX + math.cos(ang) * (r1 + comp), CY + math.sin(ang) * (r1 + comp)))
        self._arco_pensando(p, est, t, R + 4, 2)

    # ---------------- Ultron ----------------
    # rosto angular em baixo polígono (x, y em unidades de R); o espelho é gerado
    _ROSTO = [(0, -1.0), (0.5, -0.86), (0.78, -0.4), (0.74, 0.18), (0.48, 0.72), (0, 0.98)]
    _MALHA = [(0, -0.62), (0.3, -0.5), (0.58, -0.12), (0.36, -0.12), (0.16, 0.06), (0, 0.18),
              (0.3, 0.3), (0.18, 0.5), (0, 0.6), (0.46, 0.38)]

    def _estilo_ultron(self, p, est, t, centro):
        """Holograma azul de uma cabeça angular: malha, olhos em fenda, boca que abre com a voz,
        linhas de varredura, cintilação e partículas."""
        import random

        cor = QColor(self.cor)
        rnd = random.Random(int(t * 15))
        cintila = 0.85 + 0.15 * rnd.random()
        giro = math.cos(t * 0.6) * 0.12                # leve giro 3D
        esc = R * 1.02

        def pt(x, y):
            return QPointF(CX + x * esc * (1 - abs(giro) * 0.5) + giro * esc * (0.25 - y * 0.1), CY + y * esc)

        pontos = self._ROSTO + [(-x, y) for x, y in reversed(self._ROSTO[1:-1])]
        contorno = QPainterPath()
        for i, (x, y) in enumerate(pontos):
            contorno.moveTo(pt(x, y)) if i == 0 else contorno.lineTo(pt(x, y))
        contorno.closeSubpath()
        g = QRadialGradient(centro, esc)
        c0 = QColor(cor)
        c0.setAlphaF((0.22 + 0.25 * self.nivel) * cintila)
        c1 = QColor(cor)
        c1.setAlphaF(0.03)
        g.setColorAt(0, c0)
        g.setColorAt(1, c1)
        p.setPen(Qt.NoPen)
        p.setBrush(QBrush(g))
        p.drawPath(contorno)
        vert = pontos + self._MALHA + [(-x, y) for x, y in self._MALHA if x]
        p.save()
        p.setClipPath(contorno)
        for i, (x1, y1) in enumerate(vert):
            for x2, y2 in vert[i + 1:]:
                d = math.hypot(x1 - x2, y1 - y2)
                if d < 0.42:
                    c = QColor(cor)
                    c.setAlphaF((0.16 + 0.25 * (1 - d / 0.42)) * cintila * (0.6 + 0.5 * self.brilho))
                    p.setPen(QPen(c, 0.9))
                    p.drawLine(pt(x1, y1), pt(x2, y2))
        falha = rnd.random() < 0.08 + 0.3 * self.nivel
        for y in range(int(CY - esc), int(CY + esc), 3):
            c = QColor(cor)
            c.setAlphaF(0.07 + 0.06 * (math.sin(y * 0.6 + t * 18) * 0.5 + 0.5))
            dx = (rnd.random() - 0.5) * 10 if falha and rnd.random() < 0.12 else 0
            p.fillRect(QRectF(CX - esc + dx, y, 2 * esc, 1), c)
        p.restore()
        c = QColor(cor).lighter(130)
        c.setAlphaF(0.85 * cintila)
        p.setBrush(Qt.NoBrush)
        p.setPen(QPen(c, 1.8))
        p.drawPath(contorno)
        forca = 0.55 + 0.45 * self.brilho + 0.7 * self.nivel
        if est in ("pensando", "agindo"):
            forca *= 0.7 + 0.3 * math.sin(t * 8)
        olho_cor = QColor(220, 240, 255) if est not in ("pensando", "agindo") else QColor(cor).lighter(150)
        for lado in (-1, 1):
            olho = QPainterPath()
            for i, (x, y) in enumerate(((0.12, -0.22), (0.48, -0.3), (0.52, -0.2), (0.16, -0.1))):
                q = pt(lado * x, y)
                olho.moveTo(q) if i == 0 else olho.lineTo(q)
            olho.closeSubpath()
            centro_olho = pt(lado * 0.33, -0.2)
            self._brilho_olho(p, centro_olho.x(), centro_olho.y(), R * 0.12, cor, forca)
            p.setPen(Qt.NoPen)
            oc = QColor(olho_cor)
            oc.setAlphaF(min(1.0, 0.6 + 0.4 * forca))
            p.setBrush(oc)
            p.drawPath(olho)
        abre = 0.02 + 0.12 * self.nivel
        boca = QPainterPath()
        for i, (x, y) in enumerate(((-0.3, 0.46), (0, 0.44 - abre / 2), (0.3, 0.46), (0, 0.48 + abre))):
            q = pt(x, y)
            boca.moveTo(q) if i == 0 else boca.lineTo(q)
        boca.closeSubpath()
        bc = QColor(cor).lighter(160)
        bc.setAlphaF(0.5 + 0.5 * min(1, self.nivel * 2))
        p.setBrush(bc)
        p.setPen(QPen(QColor(cor).lighter(140), 1.2))
        p.drawPath(boca)
        prnd = random.Random(3)
        for k in range(18):
            fase = (t * (0.15 + prnd.random() * 0.2) + prnd.random()) % 1
            x = CX + (prnd.random() - 0.5) * 2 * (R + 18)
            y = CY + R + 20 - fase * (2 * R + 40)
            c = QColor(cor)
            c.setAlphaF(0.5 * (1 - fase) * cintila)
            p.setPen(Qt.NoPen)
            p.setBrush(c)
            p.drawEllipse(QPointF(x, y), 1.3, 1.3)
        self._arco_pensando(p, est, t, R + 12, 2)

    # ---------------- Star Wars ----------------
    def _brilho_olho(self, p, x, y, raio, cor, forca):
        g = QRadialGradient(QPointF(x, y), raio * 2.4)
        c0 = QColor(cor).lighter(160)
        c0.setAlphaF(min(1.0, 0.55 * forca))
        c1 = QColor(cor)
        c1.setAlphaF(0.0)
        g.setColorAt(0.0, c0)
        g.setColorAt(1.0, c1)
        p.setPen(Qt.NoPen)
        p.setBrush(QBrush(g))
        p.drawEllipse(QPointF(x, y), raio * 2.4, raio * 2.4)

    def _estilo_c3po(self, p, est, t, centro):
        """Rosto dourado de droide de protocolo: olhos acesos, boca de grade, discos laterais."""
        from PySide6.QtGui import QLinearGradient

        ouro_esc, ouro, ouro_cl = QColor(92, 62, 14), QColor(196, 146, 46), QColor(255, 226, 140)
        # discos das "orelhas"
        for lado in (-1, 1):
            ox = CX + lado * R * 0.86
            g = QRadialGradient(QPointF(ox - 3, CY - 2), R * 0.24)
            g.setColorAt(0, ouro_cl)
            g.setColorAt(0.6, ouro)
            g.setColorAt(1, ouro_esc)
            p.setPen(QPen(QColor(60, 40, 8), 1.2))
            p.setBrush(QBrush(g))
            p.drawEllipse(QPointF(ox, CY + R * 0.08), R * 0.2, R * 0.2)
            p.setBrush(Qt.NoBrush)
            p.drawEllipse(QPointF(ox, CY + R * 0.08), R * 0.1, R * 0.1)
        # cabeça
        cab = QPainterPath()
        cab.addRoundedRect(QRectF(CX - R * 0.78, CY - R * 0.98, R * 1.56, R * 1.9), R * 0.72, R * 0.8)
        g = QLinearGradient(QPointF(CX - R, CY), QPointF(CX + R, CY))
        g.setColorAt(0.0, ouro_esc)
        g.setColorAt(0.28, ouro)
        g.setColorAt(0.45, ouro_cl)
        g.setColorAt(0.62, ouro)
        g.setColorAt(1.0, ouro_esc)
        p.setPen(QPen(QColor(70, 46, 10), 1.6))
        p.setBrush(QBrush(g))
        p.drawPath(cab)
        # testa e linhas do rosto
        p.setPen(QPen(QColor(110, 74, 16, 200), 1.4))
        p.drawArc(QRectF(CX - R * 0.62, CY - R * 0.5, R * 1.24, R * 0.5), 20 * 16, 140 * 16)
        p.drawLine(QPointF(CX, CY - R * 0.1), QPointF(CX, CY + R * 0.3))
        p.drawLine(QPointF(CX - R * 0.5, CY + R * 0.32), QPointF(CX - R * 0.2, CY + R * 0.62))
        p.drawLine(QPointF(CX + R * 0.5, CY + R * 0.32), QPointF(CX + R * 0.2, CY + R * 0.62))
        # olhos (piscam de vez em quando; brilham com a voz)
        ciclo = t % 5.2
        aberto = 1.0 if ciclo > 0.14 else abs(ciclo - 0.07) / 0.07
        forca = 0.45 + 0.55 * self.brilho + 0.6 * self.nivel
        if est in ("pensando", "agindo"):
            forca *= 0.75 + 0.25 * math.sin(t * 7)
        cor = QColor(self.cor)
        for lado in (-1, 1):
            ex, ey = CX + lado * R * 0.34, CY - R * 0.06
            p.setPen(Qt.NoPen)
            p.setBrush(QColor(48, 32, 6))
            p.drawEllipse(QPointF(ex, ey), R * 0.21, R * 0.21)
            self._brilho_olho(p, ex, ey, R * 0.15, cor, forca)
            g = QRadialGradient(QPointF(ex, ey), R * 0.15)
            g.setColorAt(0.0, QColor(255, 250, 220))
            g.setColorAt(0.35, cor.lighter(130))
            g.setColorAt(1.0, cor.darker(170))
            p.setBrush(QBrush(g))
            p.drawEllipse(QPointF(ex, ey), R * 0.15, R * 0.15 * aberto)
        # boca de grade: acende quando fala
        boca = QRectF(CX - R * 0.2, CY + R * 0.46, R * 0.4, R * 0.12)
        p.setPen(QPen(QColor(60, 40, 8), 1.2))
        p.setBrush(QColor(40, 26, 4))
        p.drawRoundedRect(boca, 3, 3)
        if self.nivel > 0.02:
            c = QColor(cor).lighter(130)
            c.setAlphaF(min(1.0, 0.25 + self.nivel * 1.4))
            p.setBrush(c)
            p.setPen(Qt.NoPen)
            p.drawRoundedRect(boca.adjusted(1.5, 1.5, -1.5, -1.5), 2, 2)
        p.setPen(QPen(QColor(60, 40, 8), 1))
        for k in range(1, 6):
            x = boca.left() + boca.width() * k / 6
            p.drawLine(QPointF(x, boca.top() + 1), QPointF(x, boca.bottom() - 1))
        # reflexo metálico
        g = QRadialGradient(QPointF(CX - R * 0.32, CY - R * 0.62), R * 0.42)
        g.setColorAt(0.0, QColor(255, 255, 255, 110))
        g.setColorAt(1.0, QColor(255, 255, 255, 0))
        p.setPen(Qt.NoPen)
        p.setBrush(QBrush(g))
        p.drawEllipse(QPointF(CX - R * 0.32, CY - R * 0.62), R * 0.42, R * 0.32)
        if est in ("ouvindo", "conversa"):
            c = QColor(self.cor)
            c.setAlphaF(0.25 + 0.2 * math.sin(t * 5))
            p.setPen(QPen(c, 2))
            p.setBrush(Qt.NoBrush)
            p.drawEllipse(centro, R + 8, R + 8)
        self._arco_pensando(p, est, t, R + 12, 2)

    def _estilo_r2d2(self, p, est, t, centro):
        """Domo prateado com painéis azuis, lente e luzes."""
        g = QRadialGradient(QPointF(CX - R * 0.3, CY - R * 0.45), R * 1.5)
        g.setColorAt(0.0, QColor(255, 255, 255))
        g.setColorAt(0.55, QColor(200, 206, 214))
        g.setColorAt(1.0, QColor(110, 118, 128))
        p.setPen(QPen(QColor(70, 76, 86), 1.5))
        p.setBrush(QBrush(g))
        p.drawEllipse(centro, R, R)
        azul = QColor(40, 90, 200)
        p.save()
        corte = QPainterPath()
        corte.addEllipse(centro, R - 1, R - 1)
        p.setClipPath(corte)
        # faixa e painéis
        p.fillRect(QRectF(CX - R, CY + R * 0.12, 2 * R, R * 0.16), azul)
        p.fillRect(QRectF(CX - R, CY + R * 0.36, 2 * R, R * 0.07), QColor(150, 158, 168))
        for x0, w in ((-0.95, 0.32), (-0.52, 0.22), (0.3, 0.22), (0.62, 0.32)):
            p.fillRect(QRectF(CX + R * x0, CY - R * 0.32, R * w, R * 0.34), azul)
        p.fillRect(QRectF(CX - R * 0.62, CY + R * 0.5, R * 0.36, R * 0.22), azul)
        p.fillRect(QRectF(CX + R * 0.12, CY + R * 0.5, R * 0.5, R * 0.14), azul)
        p.restore()
        # lente principal
        p.setBrush(QColor(15, 15, 20))
        p.setPen(QPen(QColor(60, 64, 70), 2))
        p.drawEllipse(QPointF(CX, CY - R * 0.48), R * 0.2, R * 0.2)
        forca = 0.4 + 0.5 * self.brilho + 0.8 * self.nivel
        cor = QColor(self.cor)
        self._brilho_olho(p, CX, CY - R * 0.48, R * 0.08, cor, forca)
        p.setBrush(cor.lighter(140))
        p.setPen(Qt.NoPen)
        p.drawEllipse(QPointF(CX, CY - R * 0.48), R * 0.07, R * 0.07)
        # luzes lógicas piscando
        vel = 9 if est in ("pensando", "agindo") else 3
        for k, (dx, base) in enumerate(((-0.12, QColor(255, 60, 60)), (0.12, QColor(80, 160, 255)))):
            ligada = (int(t * vel) + k) % 2 == 0
            c = QColor(base) if ligada else QColor(base).darker(300)
            p.setBrush(c)
            p.drawEllipse(QPointF(CX + R * dx, CY + R * 0.2 - 6), 3.2, 3.2)
        self._arco_pensando(p, est, t, R + 12, 2)

    def _estilo_sabre(self, p, est, t, centro):
        """Anel de energia de sabre de luz: núcleo branco, brilho colorido que vibra."""
        cor = QColor(self.cor)
        cam = QPainterPath()
        vibra = 0.6 * math.sin(t * 47) + 0.4 * math.sin(t * 83)
        for i in range(181):
            ang = i / 180 * 2 * math.pi
            r = R + self.nivel * 7 * math.sin(ang * 5 + t * 9) + 0.7 * vibra
            pt = QPointF(CX + math.cos(ang) * r, CY + math.sin(ang) * r)
            cam.moveTo(pt) if i == 0 else cam.lineTo(pt)
        p.setBrush(Qt.NoBrush)
        for largura, alfa in ((22, 0.08), (14, 0.16), (8, 0.35), (5, 0.7)):
            c = QColor(cor)
            c.setAlphaF(min(1.0, alfa * (0.6 + 0.6 * self.brilho + 0.5 * self.nivel) * (0.92 + 0.08 * vibra)))
            p.setPen(QPen(c, largura + self.nivel * 6, Qt.SolidLine, Qt.RoundCap))
            p.drawPath(cam)
        p.setPen(QPen(QColor(255, 255, 255, 235), 2.4))
        p.drawPath(cam)
        if est in ("pensando", "agindo"):
            self._arco_pensando(p, est, t, R + 14, 2)

    def _estilo_rebelde(self, p, est, t, centro):
        """Transmissão holográfica azul: linhas de varredura, cintilação e falhas."""
        import random

        cor = QColor(self.cor)
        rnd = random.Random(int(t * 12))
        cintila = 0.82 + 0.18 * rnd.random()
        # cone do projetor
        cone = QPainterPath()
        cone.moveTo(CX, CY + R + 26)
        cone.lineTo(CX - R * 0.95, CY + R * 0.2)
        cone.lineTo(CX + R * 0.95, CY + R * 0.2)
        cone.closeSubpath()
        c = QColor(cor)
        c.setAlphaF(0.07 * cintila)
        p.setPen(Qt.NoPen)
        p.setBrush(c)
        p.drawPath(cone)
        p.save()
        corte = QPainterPath()
        corte.addEllipse(centro, R, R)
        p.setClipPath(corte)
        fundo = QColor(cor)
        fundo.setAlphaF(0.12 * cintila + 0.1 * self.nivel)
        p.fillRect(QRectF(CX - R, CY - R, 2 * R, 2 * R), fundo)
        falha = rnd.random() < (0.12 + 0.4 * self.nivel)
        for y in range(int(CY - R), int(CY + R), 3):
            c = QColor(cor)
            c.setAlphaF((0.18 + 0.25 * (math.sin(y * 0.5 + t * 20) * 0.5 + 0.5)) * cintila * (0.6 + 0.5 * self.brilho))
            dx = (rnd.random() - 0.5) * 14 if falha and rnd.random() < 0.15 else 0
            p.fillRect(QRectF(CX - R + dx, y, 2 * R, 1.2), c)
        # silhueta simples (busto) para parecer uma transmissão
        c = QColor(cor).lighter(140)
        c.setAlphaF(0.35 * cintila + 0.3 * self.nivel)
        p.setBrush(c)
        p.drawEllipse(QPointF(CX, CY - R * 0.22), R * 0.24, R * 0.28)
        p.drawRoundedRect(QRectF(CX - R * 0.48, CY + R * 0.14, R * 0.96, R * 0.9), R * 0.3, R * 0.3)
        p.restore()
        c = QColor(cor)
        c.setAlphaF(0.6 * cintila)
        p.setPen(QPen(c, 1.6))
        p.setBrush(Qt.NoBrush)
        p.drawEllipse(centro, R, R)
        self._arco_pensando(p, est, t, R + 10, 2)

    def _estilo_bb8(self, p, est, t, centro):
        """Bola laranja e branca que rola, com a cabecinha em cima."""
        laranja = QColor(self.cor)
        corpo_c = QPointF(CX, CY + R * 0.18)
        rc = R * 0.82
        g = QRadialGradient(QPointF(CX - rc * 0.35, CY - rc * 0.1), rc * 1.6)
        g.setColorAt(0, QColor(255, 255, 255))
        g.setColorAt(0.6, QColor(222, 222, 216))
        g.setColorAt(1, QColor(150, 150, 146))
        p.setPen(QPen(QColor(90, 90, 86), 1.4))
        p.setBrush(QBrush(g))
        p.drawEllipse(corpo_c, rc, rc)
        p.save()
        corte = QPainterPath()
        corte.addEllipse(corpo_c, rc - 1, rc - 1)
        p.setClipPath(corte)
        giro = (t * (1.6 if est in ("pensando", "agindo") else 0.5)) % 2
        for k in range(3):
            fase = (giro + k * 2 / 3) % 2 - 1                # -1..1 atravessando a bola
            x = CX + fase * rc * 1.1
            esc = max(0.2, math.cos(fase * math.pi / 2))
            p.setPen(QPen(laranja, 4))
            p.setBrush(Qt.NoBrush)
            p.drawEllipse(QPointF(x, corpo_c.y() + (k - 1) * rc * 0.35), rc * 0.36 * esc, rc * 0.36)
            p.setBrush(QColor(170, 172, 176))
            p.setPen(Qt.NoPen)
            p.drawEllipse(QPointF(x, corpo_c.y() + (k - 1) * rc * 0.35), rc * 0.17 * esc, rc * 0.17)
        p.restore()
        # cabeça (inclina um pouco com a voz)
        inclina = 6 * self.nivel * math.sin(t * 6)
        p.save()
        p.translate(CX, CY - R * 0.62)
        p.rotate(inclina)
        cab = QPainterPath()
        cab.moveTo(-R * 0.42, R * 0.02)
        cab.cubicTo(-R * 0.42, -R * 0.42, R * 0.42, -R * 0.42, R * 0.42, R * 0.02)
        cab.closeSubpath()
        p.setPen(QPen(QColor(90, 90, 86), 1.2))
        p.setBrush(QColor(236, 236, 230))
        p.drawPath(cab)
        p.fillRect(QRectF(-R * 0.4, -R * 0.06, R * 0.8, R * 0.07), laranja)
        p.setBrush(QColor(12, 12, 14))
        p.drawEllipse(QPointF(0, -R * 0.2), R * 0.1, R * 0.1)
        self._brilho_olho(p, R * 0.2, -R * 0.15, 2.5, QColor(255, 60, 40), 0.5 + self.nivel)
        p.restore()
        self._arco_pensando(p, est, t, R + 12, 2)

    def _estilo_estrela(self, p, est, t, centro):
        """Estação esférica cinza com trincheira e o prato do superlaser."""
        import random

        g = QRadialGradient(QPointF(CX - R * 0.35, CY - R * 0.4), R * 1.6)
        g.setColorAt(0, QColor(200, 206, 212))
        g.setColorAt(0.6, QColor(120, 126, 134))
        g.setColorAt(1, QColor(46, 50, 56))
        p.setPen(QPen(QColor(30, 32, 36), 1.4))
        p.setBrush(QBrush(g))
        p.drawEllipse(centro, R, R)
        p.save()
        corte = QPainterPath()
        corte.addEllipse(centro, R - 1, R - 1)
        p.setClipPath(corte)
        rnd = random.Random(7)
        p.setPen(QPen(QColor(70, 74, 80, 120), 1))
        for _ in range(26):                                   # painéis da superfície
            x, y = CX + rnd.uniform(-R, R), CY + rnd.uniform(-R, R)
            p.drawRect(QRectF(x, y, rnd.uniform(3, 10), rnd.uniform(2, 5)))
        p.setPen(QPen(QColor(40, 42, 48), 2.4))               # trincheira
        p.drawLine(QPointF(CX - R, CY + 2), QPointF(CX + R, CY + 2))
        p.restore()
        # prato do superlaser
        px, py, pr = CX - R * 0.36, CY - R * 0.38, R * 0.27
        g = QRadialGradient(QPointF(px + pr * 0.3, py + pr * 0.3), pr * 1.4)
        g.setColorAt(0, QColor(170, 176, 182))
        g.setColorAt(1, QColor(60, 64, 70))
        p.setBrush(QBrush(g))
        p.setPen(QPen(QColor(40, 42, 46), 1.2))
        p.drawEllipse(QPointF(px, py), pr, pr)
        ativo = est in ("falando", "pensando", "agindo")
        forca = (0.3 + 1.2 * self.nivel) if est == "falando" else (0.4 + 0.3 * math.sin(t * 6) if ativo else 0.0)
        if forca > 0:
            verde = QColor(self.cor) if ativo else QColor(92, 255, 106)
            self._brilho_olho(p, px, py, pr * 0.3, verde, forca)
            p.setBrush(verde.lighter(130))
            p.setPen(Qt.NoPen)
            p.drawEllipse(QPointF(px, py), pr * 0.18, pr * 0.18)
        self._arco_pensando(p, est, t, R + 12, 2)

    def _estilo_plasma(self, p, est, t, centro):
        """Ultron nascendo: esfera de plasma azul com a casca de energia amassada, filamentos e fagulhas."""
        pts, arestas, fagulhas = _PLASMA
        vel = {"ouvindo": 0.9, "conversa": 0.6, "pensando": 1.8, "agindo": 2.6}.get(est, 0.35)
        giro = t * vel
        cg, sg = math.cos(giro), math.sin(giro)
        incl = 0.42 + 0.12 * math.sin(t * 0.3)
        ci, si = math.cos(incl), math.sin(incl)
        pulso = 1 + 0.05 * math.sin(t * 2.2) + 0.28 * self.nivel
        escala = R * 0.98 * pulso
        # corpo translúcido
        g = QRadialGradient(centro, escala * 1.15)
        c0 = QColor(self.cor).darker(320)
        c0.setAlphaF(0.78)
        g.setColorAt(0.0, c0)
        c1 = QColor(self.cor).darker(200)
        c1.setAlphaF(0.30)
        g.setColorAt(0.8, c1)
        c2 = QColor(self.cor)
        c2.setAlphaF(0.0)
        g.setColorAt(1.0, c2)
        p.setPen(Qt.NoPen)
        p.setBrush(QBrush(g))
        p.drawEllipse(centro, escala * 1.15, escala * 1.15)
        # vértices girados e projetados; a casca "respira" e treme quando fala
        proj = []
        for i, (x, y, z) in enumerate(pts):
            tremor = 1 + (0.06 + 0.22 * self.nivel) * math.sin(t * 3.1 + i * 1.9)
            x, y, z = x * tremor, y * tremor, z * tremor
            x, z = x * cg + z * sg, -x * sg + z * cg
            y, z = y * ci - z * si, y * si + z * ci
            proj.append((CX + x * escala, CY + y * escala, z))
        # filamentos da casca (mais claros na frente) e centelha nos nós
        for a, b in arestas:
            xa, ya, za = proj[a]
            xb, yb, zb = proj[b]
            prof = 0.5 + 0.5 * (za + zb) / 2
            c = QColor(self.cor).lighter(110 + int(70 * prof))
            c.setAlphaF(min(1.0, (0.18 + 0.55 * prof) * (0.5 + self.brilho)))
            p.setPen(QPen(c, 0.8 + 1.1 * prof))
            p.drawLine(QPointF(xa, ya), QPointF(xb, yb))
        for x, y, z in proj:
            prof = 0.5 + 0.5 * z
            c = QColor(self.cor).lighter(170)
            c.setAlphaF(0.25 + 0.6 * prof)
            p.setPen(Qt.NoPen)
            p.setBrush(c)
            p.drawEllipse(QPointF(x, y), 1.0 + 1.3 * prof, 1.0 + 1.3 * prof)
        # raios internos ligando o núcleo a alguns nós (a rede neural acendendo)
        ativos = 5 if est in ("pensando", "agindo") else 3
        for k in range(ativos):
            x, y, z = proj[int(t * (3 if est in ("pensando", "agindo") else 1.2) + k * 9) % len(proj)]
            c = QColor(self.cor).lighter(190)
            c.setAlphaF(0.35 + 0.4 * self.brilho)
            p.setPen(QPen(c, 1.0))
            meio = QPointF((CX + x) / 2 + 5 * math.sin(t * 9 + k), (CY + y) / 2 + 5 * math.cos(t * 8 + k))
            caminho = QPainterPath(QPointF(CX, CY))
            caminho.quadTo(meio, QPointF(x, y))
            p.setBrush(Qt.NoBrush)
            p.drawPath(caminho)
        # fagulhas que escapam da casca
        for ang0, alt, vida, fase in fagulhas:
            ciclo = ((t * 0.25 * vida + fase) % 1.0)
            ang = ang0 + t * 0.2
            rr = escala * (0.7 + 0.55 * ciclo) * math.sqrt(max(0.0, 1 - alt * alt * 0.5))
            c = QColor(self.cor).lighter(200)
            c.setAlphaF((1 - ciclo) * 0.8 * min(1.0, 0.4 + self.brilho))
            p.setPen(Qt.NoPen)
            p.setBrush(c)
            p.drawEllipse(QPointF(CX + math.cos(ang) * rr, CY + alt * escala * 0.8 + math.sin(ang) * rr * 0.15),
                          1.0 + 0.8 * (1 - ciclo), 1.0 + 0.8 * (1 - ciclo))
        # núcleo branco-azulado que pulsa com a voz
        nucleo = R * (0.17 + 0.16 * self.nivel) + 1.5 * math.sin(t * 3) * self.brilho
        g = QRadialGradient(centro, nucleo * 2.6)
        g.setColorAt(0.0, QColor(255, 255, 255, 255))
        c3 = QColor(self.cor).lighter(160)
        c3.setAlphaF(0.85)
        g.setColorAt(0.35, c3)
        c4 = QColor(self.cor)
        c4.setAlphaF(0.0)
        g.setColorAt(1.0, c4)
        p.setPen(Qt.NoPen)
        p.setBrush(QBrush(g))
        p.drawEllipse(centro, nucleo * 2.6, nucleo * 2.6)
        self._arco_pensando(p, est, t, R + 12, 2)

    def _estilo_reator(self, p, est, t, centro):
        # fundo escuro do reator
        g = QRadialGradient(centro, R + 4)
        g.setColorAt(0.0, QColor(10, 22, 34))
        g.setColorAt(1.0, QColor(4, 8, 14))
        p.setPen(QPen(QColor(90, 110, 130, 160), 1.5))
        p.setBrush(QBrush(g))
        p.drawEllipse(centro, R + 4, R + 4)
        # anel segmentado externo (gira; estica quando ela fala)
        vel = {"ouvindo": 60, "conversa": 30, "pensando": 120, "agindo": 200}.get(est, 12)
        segs = 12
        for i in range(segs):
            ini = (i * 360 / segs + t * vel) % 360
            grosso = 5 + 6 * self.nivel * abs(math.sin(i * 1.7 + t * 6))
            c = QColor(self.cor)
            c.setAlphaF(0.35 + 0.65 * self.brilho)
            p.setPen(QPen(c, grosso, Qt.SolidLine, Qt.FlatCap))
            raio = R - 4
            p.drawArc(QRectF(CX - raio, CY - raio, 2 * raio, 2 * raio), int(ini * 16), int(360 / segs * 0.62 * 16))
        # anel interno fino e bobinas
        c = QColor(self.cor)
        c.setAlphaF(0.5 + 0.4 * self.brilho)
        p.setPen(QPen(c, 1.4))
        p.setBrush(Qt.NoBrush)
        p.drawEllipse(centro, R * 0.66, R * 0.66)
        for i in range(10):
            ang = i / 10 * 2 * math.pi - t * 0.3
            a = QPointF(CX + math.cos(ang) * R * 0.48, CY + math.sin(ang) * R * 0.48)
            b = QPointF(CX + math.cos(ang) * R * 0.64, CY + math.sin(ang) * R * 0.64)
            p.setPen(QPen(c, 3, Qt.SolidLine, Qt.RoundCap))
            p.drawLine(a, b)
        # triângulo
        tri = QPainterPath()
        for k in range(3):
            ang = -math.pi / 2 + k * 2 * math.pi / 3 + math.pi
            pt = QPointF(CX + math.cos(ang) * R * 0.42, CY + math.sin(ang) * R * 0.42)
            tri.moveTo(pt) if k == 0 else tri.lineTo(pt)
        tri.closeSubpath()
        p.setPen(QPen(QColor(self.cor).lighter(130), 2))
        p.drawPath(tri)
        # núcleo que pulsa com a voz
        nucleo = R * (0.26 + 0.12 * self.nivel) + 2 * math.sin(t * 3) * self.brilho
        g = QRadialGradient(centro, nucleo * 1.8)
        g.setColorAt(0.0, QColor(255, 255, 255, 255))
        c2 = QColor(self.cor)
        c2.setAlphaF(0.9)
        g.setColorAt(0.45, c2)
        c3 = QColor(self.cor)
        c3.setAlphaF(0.0)
        g.setColorAt(1.0, c3)
        p.setPen(Qt.NoPen)
        p.setBrush(QBrush(g))
        p.drawEllipse(centro, nucleo * 1.8, nucleo * 1.8)
        self._arco_pensando(p, est, t, R + 12, 2)

    def _estilo_olho(self, p, est, t, centro):
        # aro metálico
        g = QRadialGradient(QPointF(CX - R * 0.4, CY - R * 0.5), R * 2.2)
        g.setColorAt(0.0, QColor(200, 205, 212))
        g.setColorAt(0.5, QColor(90, 95, 104))
        g.setColorAt(1.0, QColor(30, 32, 36))
        p.setPen(QPen(QColor(15, 15, 18), 1.5))
        p.setBrush(QBrush(g))
        p.drawEllipse(centro, R + 7, R + 7)
        # lente preta
        p.setBrush(QColor(6, 6, 8))
        p.setPen(QPen(QColor(0, 0, 0), 2))
        p.drawEllipse(centro, R, R)
        # íris vermelha
        pulso = 0.5 + 0.5 * math.sin(t * (4 if est in ("pensando", "agindo") else 1.3))
        raio = R * (0.55 + 0.25 * self.brilho + 0.25 * self.nivel + 0.04 * pulso)
        g = QRadialGradient(centro, raio)
        g.setColorAt(0.0, QColor(255, 245, 200))
        g.setColorAt(0.12, QColor(255, 210, 90))
        c = QColor(self.cor)
        g.setColorAt(0.32, c)
        c2 = QColor(self.cor).darker(250)
        c2.setAlphaF(0.85)
        g.setColorAt(0.7, c2)
        c3 = QColor(self.cor)
        c3.setAlphaF(0.0)
        g.setColorAt(1.0, c3)
        p.setPen(Qt.NoPen)
        p.setBrush(QBrush(g))
        p.drawEllipse(centro, raio, raio)
        # reflexos na lente
        p.setPen(QPen(QColor(255, 255, 255, 70), 2.5, Qt.SolidLine, Qt.RoundCap))
        p.drawArc(QRectF(CX - R * 0.78, CY - R * 0.78, R * 1.56, R * 1.56), 110 * 16, 45 * 16)
        p.setBrush(QColor(255, 255, 255, 60))
        p.setPen(Qt.NoPen)
        p.drawEllipse(QPointF(CX + R * 0.42, CY + R * 0.45), 3, 3)

    def _estilo_anel(self, p, est, t, centro):
        # anel que ondula com a voz
        c = QColor(self.cor)
        c.setAlphaF(0.55 + 0.45 * self.brilho)
        cam = QPainterPath()
        for i in range(181):
            ang = i / 180 * 2 * math.pi
            r = R + self.nivel * 9 * math.sin(ang * 6 + t * 8) + (1.5 * math.sin(ang * 3 - t * 2) if est in ("ouvindo", "conversa") else 0)
            pt = QPointF(CX + math.cos(ang) * r, CY + math.sin(ang) * r)
            cam.moveTo(pt) if i == 0 else cam.lineTo(pt)
        brilho = QColor(self.cor)
        brilho.setAlphaF(0.18 * self.brilho + 0.2 * self.nivel)
        p.setBrush(Qt.NoBrush)
        p.setPen(QPen(brilho, 9))
        p.drawPath(cam)
        p.setPen(QPen(c, 2.6))
        p.drawPath(cam)
        # osciloscópio no meio
        amp = self._amp(est) * 0.9
        osc = QPainterPath()
        for x in range(-R + 10, R - 9, 2):
            env = math.cos(x / (R - 10) * math.pi / 2) ** 2
            y = (math.sin(x * 0.16 + t * 9) * 0.6 + math.sin(x * 0.07 - t * 5) * 0.4) * amp * env
            pt = QPointF(CX + x, CY + y)
            osc.moveTo(pt) if x == -R + 10 else osc.lineTo(pt)
        p.setPen(QPen(QColor(self.cor).lighter(120), 2))
        p.drawPath(osc)
        # pontos em órbita enquanto pensa/age
        if est in ("pensando", "agindo"):
            for k in range(3):
                ang = t * (2.6 if est == "agindo" else 1.6) + k * 2 * math.pi / 3
                p.setBrush(QColor(self.cor).lighter(140))
                p.setPen(Qt.NoPen)
                p.drawEllipse(QPointF(CX + math.cos(ang) * (R + 11), CY + math.sin(ang) * (R + 11)), 3.2, 3.2)

    def _estilo_pixel(self, p, est, t, centro):
        px = 6
        n = int(2 * R / px)
        base = QColor(self.cor)
        for gy in range(n):
            for gx in range(n):
                x = gx * px - R + px / 2
                y = gy * px - R + px / 2
                d = math.hypot(x, y) / R
                if d > 1.0:
                    continue
                luz = max(0.0, 1 - math.hypot(x + R * 0.4, y + R * 0.45) / (R * 1.6))
                nivel = min(3, int(luz * 4))                      # 4 tons, estilo 8-bit
                c = base.darker([380, 240, 150, 100][nivel])
                if d > 0.9:
                    c = base.darker(300)
                p.fillRect(QRectF(CX + x - px / 2, CY + y - px / 2, px - 1, px - 1), c)
        # onda em pixels brancos
        amp = self._amp(est) * 0.8
        for gx in range(2, n - 2):
            x = gx * px - R + px / 2
            env = math.cos(x / R * math.pi / 2) ** 2
            y = math.sin(x / R * math.pi * 1.6 + t * 6) * amp * env
            gy = round((y + R - px / 2) / px)
            p.fillRect(QRectF(CX + x - px / 2, CY + gy * px - R, px - 1, px - 1), QColor(240, 255, 240))
        # barras em blocos ao redor quando fala/ouve
        if est in ("falando", "ouvindo", "conversa"):
            for i in range(24):
                ang = i / 24 * 2 * math.pi
                alt = 1 + int((self.nivel * 4 if est == "falando" else 1) * abs(math.sin(ang * 3 + t * 6)))
                for k in range(alt):
                    r = R + 6 + k * (px + 1)
                    p.fillRect(QRectF(CX + math.cos(ang) * r - 2.5, CY + math.sin(ang) * r - 2.5, 5, 5), base)
        if est in ("pensando", "agindo"):
            ang = (t * 3) % (2 * math.pi)
            for k in range(6):
                a = ang - k * 0.18
                c = QColor(base)
                c.setAlphaF(1 - k / 6)
                p.fillRect(QRectF(CX + math.cos(a) * (R + 10) - 3, CY + math.sin(a) * (R + 10) - 3, 6, 6), c)

    def _botao(self, p, x, tipo, ativo):
        sobre = self.sobre == tipo
        fundo = QColor(18, 24, 34, 235 if sobre else 200)
        p.setPen(QPen(QColor(255, 255, 255, 70 if sobre else 40), 1))
        p.setBrush(fundo)
        p.drawEllipse(QPointF(x, BOT_Y), BOT_R, BOT_R)
        if ativo:
            cor = QColor("#e8eef6")
        else:
            cor = QColor("#ff5d5d") if tipo == "mic" else QColor("#8a93a0")
        caneta = QPen(cor, 1.8, Qt.SolidLine, Qt.RoundCap, Qt.RoundJoin)
        p.setPen(caneta)
        p.setBrush(Qt.NoBrush)
        if tipo == "mic":
            # cápsula + suporte (traçado no estilo Material)
            p.drawRoundedRect(QRectF(x - 3.6, BOT_Y - 8.5, 7.2, 11.5), 3.6, 3.6)
            arco = QPainterPath()
            arco.moveTo(x - 6.5, BOT_Y - 1.5)
            arco.cubicTo(x - 6.5, BOT_Y + 6.5, x + 6.5, BOT_Y + 6.5, x + 6.5, BOT_Y - 1.5)
            p.drawPath(arco)
            p.drawLine(QPointF(x, BOT_Y + 4.5), QPointF(x, BOT_Y + 8.5))
            if not ativo:
                p.drawLine(QPointF(x - 8, BOT_Y - 8), QPointF(x + 8, BOT_Y + 8))
        elif tipo == "foco":
            # alvo: aceso na cor do tema quando o foco está ligado
            if ativo:
                c = QColor(self.cor)
                c.setAlphaF(0.35)
                p.setBrush(c)
                p.setPen(Qt.NoPen)
                p.drawEllipse(QPointF(x, BOT_Y), BOT_R - 2, BOT_R - 2)
                caneta.setColor(QColor(self.cor).lighter(140))
            else:
                caneta.setColor(QColor("#8a93a0"))
            p.setPen(caneta)
            p.setBrush(Qt.NoBrush)
            p.drawEllipse(QPointF(x, BOT_Y), 8, 8)
            p.drawEllipse(QPointF(x, BOT_Y), 4, 4)
            p.setBrush(caneta.color())
            p.drawEllipse(QPointF(x, BOT_Y), 1.4, 1.4)
        elif tipo == "raciocinio":
            # medidor: o ponteiro aponta para o nível (padrão fica no meio, tracejado)
            p.drawArc(QRectF(x - 9, BOT_Y - 6, 18, 18), 0, 180 * 16)
            for k in range(5):
                a = math.radians(180 - k * 45)
                p.drawLine(QPointF(x + math.cos(a) * 7.5, BOT_Y + 3 - math.sin(a) * 7.5),
                           QPointF(x + math.cos(a) * 9, BOT_Y + 3 - math.sin(a) * 9))
            idx = {"baixo": 0, "medio": 1, "padrao": 2, "alto": 3, "maximo": 4}.get(self.raciocinio, 2)
            a = math.radians(180 - idx * 45)
            ponteiro = QPen(QColor(self.cor).lighter(130) if self.raciocinio != "padrao" else cor, 2,
                            Qt.DotLine if self.raciocinio == "padrao" else Qt.SolidLine, Qt.RoundCap)
            p.setPen(ponteiro)
            p.drawLine(QPointF(x, BOT_Y + 3), QPointF(x + math.cos(a) * 6.5, BOT_Y + 3 - math.sin(a) * 6.5))
            p.setBrush(cor)
            p.setPen(Qt.NoPen)
            p.drawEllipse(QPointF(x, BOT_Y + 3), 1.8, 1.8)
        elif tipo == "volume":
            # alto-falante + ondas conforme o volume (Material "volume_up")
            cone = QPainterPath()
            cone.moveTo(x - 8, BOT_Y - 2.5)
            cone.lineTo(x - 4.5, BOT_Y - 2.5)
            cone.lineTo(x - 0.5, BOT_Y - 6.5)
            cone.lineTo(x - 0.5, BOT_Y + 6.5)
            cone.lineTo(x - 4.5, BOT_Y + 2.5)
            cone.lineTo(x - 8, BOT_Y + 2.5)
            cone.closeSubpath()
            p.drawPath(cone)
            v = self.reprodutor.volume
            if v <= 0:
                p.drawLine(QPointF(x + 2.5, BOT_Y - 3.5), QPointF(x + 8.5, BOT_Y + 3.5))
                p.drawLine(QPointF(x + 8.5, BOT_Y - 3.5), QPointF(x + 2.5, BOT_Y + 3.5))
            else:
                for k, limite in enumerate((0.0, 0.5, 1.05)):
                    if v > limite:
                        raio = 3.5 + k * 3
                        p.drawArc(QRectF(x - 1 - raio, BOT_Y - raio, 2 * raio, 2 * raio), -50 * 16, 100 * 16)
        elif tipo == "tema":
            # paleta de pintor com três tintas na cor do tema atual
            pal = QPainterPath()
            pal.addEllipse(QPointF(x, BOT_Y), 8.5, 7.5)
            furo = QPainterPath()
            furo.addEllipse(QPointF(x + 3.6, BOT_Y + 3.2), 2.2, 2.2)
            p.drawPath(pal.subtracted(furo))
            cores = list(TEMAS[self.tema]["cores"].values())
            p.setPen(Qt.NoPen)
            for (dx, dy), cor_tinta in zip(((-4.2, -1.0), (-0.6, -4.2), (3.6, -2.4)), (cores[0], cores[2], cores[4])):
                p.setBrush(QColor(cor_tinta))
                p.drawEllipse(QPointF(x + dx, BOT_Y + dy), 1.9, 1.9)
        else:
            # símbolo de liga/desliga
            caixa = QRectF(x - 7.5, BOT_Y - 6.5, 15, 15)
            p.drawArc(caixa, 125 * 16, 290 * 16)
            p.drawLine(QPointF(x, BOT_Y - 9), QPointF(x, BOT_Y - 1))

    # ------------------------------------------------------------ mouse
    def _alvo(self, pos):
        for nome, x in BOTOES:
            if (pos.x() - x) ** 2 + (pos.y() - BOT_Y) ** 2 <= (BOT_R + 2) ** 2:
                return nome
        if (pos.x() - CX) ** 2 + (pos.y() - CY) ** 2 <= (R + 30) ** 2:
            return "esfera"
        return None

    def mouseMoveEvent(self, ev):
        if self.arraste is not None and ev.buttons() & Qt.LeftButton:
            atual = ev.globalPosition().toPoint()
            if (atual - self.arraste[0]).manhattanLength() > 4:
                self.arraste[2] = True
            if self.arraste[2]:
                self.move(atual - self.arraste[1])
            return
        alvo = self._alvo(ev.position())
        if alvo != self.sobre:
            self.sobre = alvo
            self.setCursor(Qt.PointingHandCursor if alvo in dict(BOTOES) else Qt.ArrowCursor)
            if alvo == "mic":
                self.setToolTip("Microfone: clique liga/desliga, botão direito troca o dispositivo")
            elif alvo == "tema":
                self.setToolTip(f"Tema: {TEMAS[self.tema]['nome']}. Clique troca, botão direito escolhe")
            elif alvo == "foco":
                self.setToolTip("Foco " + ("ligado: escutando direto, sem precisar do nome" if self.foco
                                           else "desligado: clique para ele escutar direto, sem precisar do nome"))
            elif alvo == "raciocinio":
                self.setToolTip(f"Raciocínio: {dict(NIVEIS)[self.raciocinio]}. Clique troca, botão direito escolhe")
            elif alvo == "volume":
                self.setToolTip(f"Volume da voz: {round(self.reprodutor.volume * 100)}%. Clique ajusta, rolagem do mouse também")
            elif alvo == "base":
                self.setToolTip("Base: clique liga/desliga, botão direito abre opções")
            else:
                self._tooltip()

    def enterEvent(self, _):
        self.dentro = True

    def leaveEvent(self, _):
        self.sobre = None
        self.dentro = False

    def mousePressEvent(self, ev):
        alvo = self._alvo(ev.position())
        if ev.button() == Qt.LeftButton and alvo == "esfera":
            g = ev.globalPosition().toPoint()
            self.arraste = [g, g - self.frameGeometry().topLeft(), False]
        elif ev.button() == Qt.RightButton:
            if alvo == "mic":
                self._menu_mic()
            elif alvo == "tema":
                self._menu_tema()
            elif alvo == "volume":
                self._menu_volume()
            elif alvo == "raciocinio":
                self._menu_raciocinio()
            elif alvo in ("base", "esfera"):
                self._menu_base()

    def mouseReleaseEvent(self, ev):
        alvo = self._alvo(ev.position())
        if ev.button() != Qt.LeftButton:
            return
        if self.arraste is not None:
            arrastou = self.arraste[2]
            self.arraste = None
            if arrastou:
                self.acoes["mover"]((self.x(), self.y()))
            elif alvo == "esfera":
                self.acoes["clicar_esfera"]()
            return
        if alvo == "mic":
            self.acoes["mudo"]()
        elif alvo == "foco":
            self.acoes["foco"]()
        elif alvo == "raciocinio":
            chaves = [n for n, _ in NIVEIS]
            self.acoes["raciocinio"](chaves[(chaves.index(self.raciocinio) + 1) % len(chaves)])
        elif alvo == "volume":
            self._menu_volume()
        elif alvo == "tema":
            nomes = list(TEMAS)
            self.definir_tema(nomes[(nomes.index(self.tema) + 1) % len(nomes)])
        elif alvo == "base":
            self.acoes["base"]()

    def _menu_mic(self):
        m = self._menu()
        atual = self.acoes["microfone_atual"]()
        padrao = QAction("Padrão do sistema", m, checkable=True, checked=atual is None)
        padrao.triggered.connect(lambda: self.acoes["trocar_microfone"](None))
        m.addAction(padrao)
        m.addSeparator()
        for nome, desc in self.acoes["microfones"]():
            a = QAction(desc, m, checkable=True, checked=nome == atual)
            a.triggered.connect(lambda _=False, n=nome: self.acoes["trocar_microfone"](n))
            m.addAction(a)
        m.exec(QCursor.pos())

    def definir_raciocinio_visual(self, nivel):
        self.raciocinio = nivel if nivel in dict(NIVEIS) else "padrao"
        self.setToolTip(f"Raciocínio: {dict(NIVEIS)[self.raciocinio]}")

    def _menu_raciocinio(self):
        m = self._menu()
        for chave, nome in NIVEIS:
            a = QAction(nome, m, checkable=True, checked=chave == self.raciocinio)
            a.triggered.connect(lambda _=False, c=chave: self.acoes["raciocinio"](c))
            m.addAction(a)
        m.exec(QCursor.pos())

    def definir_volume(self, v):
        v = max(0.0, min(1.5, round(v, 2)))
        self.reprodutor.volume = v
        self.setToolTip(f"Volume da voz: {round(v * 100)}%")
        self.acoes["volume"](v)

    def wheelEvent(self, ev):
        if self._alvo(ev.position()) == "volume":
            passo = 0.1 if ev.angleDelta().y() > 0 else -0.1
            self.definir_volume(self.reprodutor.volume + passo)

    def _menu_volume(self):
        painel = PainelVolume(self)
        alvo = self.mapToGlobal(QPointF(BOT_VOL_X, BOT_Y - BOT_R - 8).toPoint())
        painel.move(alvo.x() - PainelVolume.LARG // 2, alvo.y() - PainelVolume.ALT)
        painel.show()

    def _menu(self):
        """QMenu translúcido no estilo do gadget, com o destaque na cor do tema."""
        m = QMenu(self)
        m.setAttribute(Qt.WA_TranslucentBackground)
        m.setWindowFlags(m.windowFlags() | Qt.FramelessWindowHint | Qt.NoDropShadowWindowHint)
        c = QColor(TEMAS[self.tema]["cores"]["ocioso"])
        m.setStyleSheet(ESTILO_MENU % f"{c.red()}, {c.green()}, {c.blue()}")
        return m

    def definir_tema(self, nome):
        self.tema = nome
        self.setToolTip(f"Tema: {TEMAS[nome]['nome']}")
        self.acoes["tema"](nome)

    def _menu_tema(self):
        m = self._menu()
        for chave, tema in TEMAS.items():
            a = QAction(tema["nome"], m, checkable=True, checked=chave == self.tema)
            a.triggered.connect(lambda _=False, c=chave: self.definir_tema(c))
            m.addAction(a)
        m.exec(QCursor.pos())

    def _menu_base(self):
        m = self._menu()
        a = QAction("Desligar a base" if self.ligada else "Ligar a base", m)
        a.triggered.connect(self.acoes["base"])
        m.addAction(a)
        a = QAction("Abrir o terminal do Ultron", m)
        a.triggered.connect(self.acoes["terminal"])
        m.addAction(a)
        a = QAction("Reconfigurar", m)
        a.triggered.connect(self.acoes["reconfigurar"])
        m.addAction(a)
        m.addSeparator()
        a = QAction("Fechar o gadget", m)
        a.triggered.connect(self.acoes["sair"])
        m.addAction(a)
        m.exec(QCursor.pos())
