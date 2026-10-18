"""Voz 100% local: fala -> texto com faster-whisper na GPU (large-v3-turbo) e texto -> fala com
Kokoro (onnx, CPU). Toda a saída é PCM s16le, 24 kHz, mono.

Medido numa RTX 3060: 6 s de fala transcritos em 0,33 s (~0,8 GB de VRAM); Kokoro gera ~4x mais
rápido que o tempo real numa CPU Xeon E5-2680 v3.
"""
import asyncio
import glob
import logging
import os
import re
import time

import numpy as np

log = logging.getLogger("voz")
TAXA_SAIDA = 24000
DADOS = os.environ.get("ULTRON_DADOS", os.path.expanduser("~/.local/share/ultron/dados"))
MODELOS = os.environ.get("ULTRON_MODELOS", os.path.join(DADOS, "modelos"))

VOZES = {"masculino": "pm_alex", "feminino": "pf_dora"}
# grafias que o Kokoro pronuncia melhor
PRONUNCIA = {r"\bUltron\b": "Últron", r"\bultron\b": "últron", r"\bIA\b": "I A", r"\bGPU\b": "gê pê u"}


def carregar_cuda():
    """O faster-whisper (CTranslate2) usa as bibliotecas CUDA 12 que vêm do pip (nvidia-cublas/cudnn)."""
    import ctypes
    import site

    for base in site.getsitepackages():
        for rel in ("nvidia/cublas/lib/libcublas.so.12", "nvidia/cublas/lib/libcublasLt.so.12",
                    "nvidia/cudnn/lib/libcudnn.so.9"):
            for arq in glob.glob(os.path.join(base, rel)):
                try:
                    ctypes.CDLL(arq, mode=ctypes.RTLD_GLOBAL)
                except OSError:
                    pass


class Ouvido:
    def __init__(self, tamanho="large-v3-turbo", threads=None):
        carregar_cuda()
        from faster_whisper import WhisperModel

        t0 = time.time()
        pasta = os.path.join(MODELOS, "whisper")
        try:
            self.modelo = WhisperModel(tamanho, device="cuda", compute_type="int8_float16", download_root=pasta)
            self.dispositivo = "GPU"
        except Exception as e:                       # sem GPU/CUDA: CPU (bem mais lento)
            log.warning("whisper na GPU falhou (%s); usando CPU com o modelo small", e)
            self.modelo = WhisperModel("small", device="cpu", compute_type="int8",
                                       cpu_threads=threads or os.cpu_count() or 4, download_root=pasta)
            self.dispositivo = "CPU"
        log.info("whisper %s na %s em %.1fs", tamanho, self.dispositivo, time.time() - t0)

    def transcrever(self, pcm16k: bytes, nome=""):
        audio = np.frombuffer(pcm16k, dtype=np.int16).astype(np.float32) / 32768.0
        if audio.size < 16000 * 0.3:
            return ""
        segs, _ = self.modelo.transcribe(
            audio, language="pt", beam_size=1, temperature=0.0, condition_on_previous_text=False,
            vad_filter=True, vad_parameters={"min_silence_duration_ms": 500, "threshold": 0.35, "speech_pad_ms": 400},
            initial_prompt=f"{nome}," if nome else None, without_timestamps=True,
        )
        return " ".join(s.text.strip() for s in segs).strip()


def limpar_para_fala(texto):
    texto = re.sub(r"```.*?```", " ", texto, flags=re.S)
    texto = re.sub(r"`([^`]*)`", r"\1", texto)
    texto = re.sub(r"https?://\S+", "o link", texto)
    texto = re.sub(r"^\s*[-*•]\s+", "", texto, flags=re.M)
    texto = re.sub(r"^\s*#+\s*", "", texto, flags=re.M)
    texto = re.sub(r"[*_~|>#]", "", texto)
    for padrao, troca in PRONUNCIA.items():
        texto = re.sub(padrao, troca, texto)
    return re.sub(r"\s+", " ", texto).strip()


class Boca:
    """Kokoro-82M (onnx) com as vozes brasileiras: pm_alex, pm_santa (masculinas) e pf_dora."""

    def __init__(self, genero="masculino"):
        self.voz = VOZES.get(genero, VOZES["masculino"])
        self._kokoro = None

    def definir_genero(self, genero):
        self.voz = VOZES.get(genero, VOZES["masculino"])

    def _modelo(self):
        if self._kokoro is None:
            from kokoro_onnx import Kokoro

            pasta = os.path.join(MODELOS, "kokoro")
            self._kokoro = Kokoro(os.path.join(pasta, "kokoro-v1.0.onnx"), os.path.join(pasta, "voices-v1.0.bin"))
        return self._kokoro

    def _gerar(self, texto):
        audio, taxa = self._modelo().create(texto, voice=self.voz, speed=1.05, lang="pt-br")
        if taxa != TAXA_SAIDA:                      # o Kokoro já gera 24 kHz; só por garantia
            audio = np.interp(np.arange(0, len(audio), taxa / TAXA_SAIDA), np.arange(len(audio)), audio)
        return (np.clip(audio, -1, 1) * 32767).astype(np.int16).tobytes()

    async def falar(self, texto):
        texto = limpar_para_fala(texto)
        if not re.search(r"\w", texto):
            return
        loop = asyncio.get_running_loop()
        pcm = await loop.run_in_executor(None, self._gerar, texto)
        for i in range(0, len(pcm), 9600):
            yield pcm[i:i + 9600]


class Fatiador:
    """Corta o texto que chega em streaming em frases para falar uma por vez."""

    FIM = re.compile(r"([.!?…:;]+[\"')\]]*\s+|\n+)")

    def __init__(self):
        self.buf = ""
        self.primeira = True

    def alimentar(self, delta):
        self.buf += delta
        frases = []
        while True:
            minimo = 12 if self.primeira else 40
            corte = None
            for m in self.FIM.finditer(self.buf):
                if m.end() >= minimo:
                    corte = m.end()
                    break
            if corte is None:
                break
            frases.append(self.buf[:corte].strip())
            self.buf = self.buf[corte:]
            self.primeira = False
        return [f for f in frases if f]

    def resto(self):
        f, self.buf = self.buf.strip(), ""
        return [f] if f else []
