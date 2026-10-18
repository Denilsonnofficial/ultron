"""Cérebro do Ultron: cliente do `snake serve` (harness de agente) falando com o Ollama local.

O snake monta o prompt de sistema a partir dos arquivos de instrução da pasta de trabalho
(AGENTS.md) e os recarrega quando mudam: é ali que vão identidade, regras de voz, persona e
memória. As skills ficam em <trabalho>/.snake/skills.
"""
import asyncio
import json
import logging
import os
import secrets
import shutil
import time

import aiohttp

log = logging.getLogger("cerebro")
OLLAMA = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
if not OLLAMA.startswith("http"):
    OLLAMA = "http://" + OLLAMA


def porta_livre():
    import socket

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Cerebro:
    def __init__(self, modelo, porta=None, pasta_trabalho=None):
        from .memoria import DADOS

        self.definir_modelo(modelo)
        self.porta = porta or porta_livre()
        self.url = f"http://127.0.0.1:{self.porta}"
        self.pasta = pasta_trabalho or os.path.join(DADOS, "trabalho")
        app = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        self.snake = os.environ.get("ULTRON_SNAKE") or os.path.join(app, "snake", "bin", "snake.js")
        self.node = os.environ.get("ULTRON_NODE") or shutil.which("node") or "node"
        self.home_snake = os.path.join(DADOS, "snake")
        self.token = secrets.token_urlsafe(24)
        self.proc = None
        self.http = None
        self.filas = {}               # sessionId -> fila de eventos
        self._tarefa_eventos = None
        self._system = None
        self.esforco = "none"         # sem "pensar" antes de falar: é o que deixa a voz rápida

    # ---------- modelo ----------
    def definir_modelo(self, modelo):
        self.nome_modelo = modelo if "/" in modelo else f"ollama/{modelo}"

    async def listar_modelos(self):
        """Modelos do Ollama local, como referências do snake (ollama/<nome>)."""
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=5)) as h:
                async with h.get(OLLAMA + "/api/tags") as r:
                    dados = await r.json()
            nomes = (m["name"].removesuffix(":latest") for m in dados.get("models", []))
            return sorted(f"ollama/{n}" for n in nomes)
        except Exception as e:
            log.warning("Ollama não respondeu: %s", e)
            return []

    async def variantes(self, modelo):
        return []                     # o nível de raciocínio vai como instrução e como `think`

    # ---------- processo ----------
    def _ambiente(self):
        env = dict(os.environ)
        env["SNAKE_HOME"] = self.home_snake
        env["SNAKE_SERVER_TOKEN"] = self.token
        env["NO_COLOR"] = "1"
        return env

    def _config_snake(self):
        os.makedirs(self.home_snake, exist_ok=True)
        cfg = os.path.join(self.home_snake, "config.json")
        dados = {}
        try:
            dados = json.load(open(cfg))
        except (OSError, ValueError):
            pass
        dados.update({
            "permissionMode": "yolo",
            "outputStyle": "texto corrido para ser falado em voz alta: sem markdown, sem listas, sem código, frases curtas",
            "model": self.nome_modelo,
            "maxOutputTokens": 2048,
            "effort": self.esforco,
        })
        json.dump(dados, open(cfg, "w"), indent=2, ensure_ascii=False)

    async def iniciar(self):
        os.makedirs(self.pasta, exist_ok=True)
        self._config_snake()
        self.proc = await asyncio.create_subprocess_exec(
            self.node, self.snake, "serve", "--port", str(self.porta), cwd=self.pasta, env=self._ambiente(),
        )
        self.http = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None, sock_connect=10),
                                          headers={"Authorization": f"Bearer {self.token}"})
        for _ in range(120):
            try:
                async with self.http.get(self.url + "/sessions", timeout=aiohttp.ClientTimeout(total=3)) as r:
                    if r.status == 200:
                        break
            except (aiohttp.ClientError, asyncio.TimeoutError):
                pass
            await asyncio.sleep(0.5)
        else:
            raise RuntimeError("snake serve não subiu")
        self._tarefa_eventos = asyncio.create_task(self._ouvir_eventos())
        log.info("snake pronto em %s (modelo %s)", self.url, self.nome_modelo)

    async def definir_esforco(self, esforco):
        """Esforço de raciocínio do snake (none/low/medium/high): reinicia o servidor dele (~2 s)."""
        if esforco == self.esforco:
            return
        self.esforco = esforco
        if self.proc:
            await self.parar()
            await self.iniciar()

    async def parar(self):
        if self._tarefa_eventos:
            self._tarefa_eventos.cancel()
            self._tarefa_eventos = None
        if self.http:
            await self.http.close()
            self.http = None
        if self.proc and self.proc.returncode is None:
            self.proc.terminate()
            await self.proc.wait()

    async def _post(self, caminho, corpo):
        async with self.http.post(self.url + caminho, json=corpo) as r:
            txt = await r.text()
            if r.status >= 400:
                raise RuntimeError(f"{caminho}: HTTP {r.status} {txt[:300]}")
            return json.loads(txt) if txt else None

    async def _ouvir_eventos(self):
        while True:
            try:
                async with self.http.get(self.url + "/events") as r:
                    async for linha in r.content:
                        linha = linha.decode(errors="replace").strip()
                        if linha.startswith("data:"):
                            try:
                                ev = json.loads(linha[5:])
                            except ValueError:
                                continue
                            fila = self.filas.get(ev.get("sessionId"))
                            if fila is not None:
                                fila.put_nowait(ev)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log.warning("fluxo de eventos do snake caiu (%s), reconectando", e)
                await asyncio.sleep(1)

    # ---------- sessões ----------
    def escrever_instrucoes(self, texto):
        """AGENTS.md da pasta de trabalho = identidade + memória (o snake recarrega quando muda)."""
        if texto and texto != self._system:
            caminho = os.path.join(self.pasta, "AGENTS.md")
            tmp = caminho + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                f.write(texto)
            os.replace(tmp, caminho)
            self._system = texto

    async def nova_sessao(self, titulo):
        r = await self._post("/sessions", {"cwd": self.pasta, "model": self.nome_modelo})
        return r["sessionId"]

    async def abortar(self, sid):
        try:
            await self._post(f"/sessions/{sid}/cancel", {})
        except Exception as e:
            log.warning("cancelar: %s", e)

    async def responder_permissao(self, pid, aprovar):
        await self._post(f"/answers/{pid}", {"answer": "allow" if aprovar else "deny"})

    async def perguntar(self, sid, texto, system=None, variante=None, tempo_max=600, **_):
        """Mesmos eventos do Jarvis: ("texto", delta) | ("ferramenta", nome, status, titulo) |
        ("permissao", props) | ("erro", msg) | ("fim",)"""
        if system:
            self.escrever_instrucoes(system)
        fila = asyncio.Queue()
        self.filas[sid] = fila
        inicio = time.time()
        try:
            await self._post(f"/sessions/{sid}/messages", {"content": texto})
            while True:
                restante = tempo_max - (time.time() - inicio)
                if restante <= 0:
                    yield ("erro", "tempo esgotado")
                    await self.abortar(sid)
                    return
                try:
                    ev = await asyncio.wait_for(fila.get(), timeout=restante)
                except asyncio.TimeoutError:
                    continue
                tipo, dados = ev.get("type"), ev.get("data") or {}
                if tipo == "stream":
                    if dados.get("type") == "text" and dados.get("delta"):
                        yield ("texto", dados["delta"])
                elif tipo == "tool-start":
                    nome = (dados.get("tool") or {}).get("name") if isinstance(dados.get("tool"), dict) else dados.get("tool")
                    yield ("ferramenta", nome or "ferramenta", "running", dados.get("summary") or "")
                elif tipo == "tool-end":
                    yield ("ferramenta", "ferramenta", "completed", "")
                elif tipo == "assistant" and dados.get("step", 1) > 1:
                    yield ("texto", "\n")     # passo novo depois de ferramenta: separa as frases
                elif tipo == "permission":
                    yield ("permissao", {"id": dados.get("id"), "permission": "bash" if dados.get("tool") == "bash" else dados.get("tool"),
                                         "metadata": {"command": (dados.get("args") or {}).get("command", ""),
                                                      "description": dados.get("summary", "")}})
                elif tipo == "error":
                    yield ("erro", dados.get("message") or "erro do modelo")
                    yield ("fim",)
                    return
                elif tipo == "completed":
                    yield ("fim",)
                    return
        finally:
            self.filas.pop(sid, None)

    async def completar(self, texto, system=None, titulo="tarefa interna", tempo_max=180):
        """Pergunta isolada (consolidação de memória): sessão própria, sem a persona."""
        sid = await self.nova_sessao(titulo)
        partes = []
        async for ev in self.perguntar(sid, texto, tempo_max=tempo_max):
            if ev[0] == "texto":
                partes.append(ev[1])
            elif ev[0] == "permissao":
                await self.responder_permissao(ev[1]["id"], False)
            elif ev[0] == "erro":
                raise RuntimeError(ev[1])
        return "".join(partes).strip()
