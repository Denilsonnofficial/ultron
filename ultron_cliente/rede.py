"""Conexão WebSocket com a base, numa thread própria, com reconexão automática."""
import asyncio
import json
import threading
import urllib.parse

import websockets


def url_com_token(base, token):
    sep = "&" if "?" in base else "?"
    return f"{base}{sep}token={urllib.parse.quote(token)}" if token else base


class Rede(threading.Thread):
    def __init__(self, base, token, ao_json, ao_audio, ao_conexao, tipo="gadget"):
        super().__init__(daemon=True)
        self.url = url_com_token(base, token) + f"&cliente={tipo}"
        self.ao_json, self.ao_audio, self.ao_conexao = ao_json, ao_audio, ao_conexao
        self.loop = asyncio.new_event_loop()
        self.ws = None
        self.conectado = False

    def run(self):
        asyncio.set_event_loop(self.loop)
        self.loop.run_until_complete(self._laco())

    async def _laco(self):
        espera = 1
        while True:
            try:
                async with websockets.connect(self.url, max_size=None, ping_interval=20, open_timeout=8) as ws:
                    self.ws, self.conectado, espera = ws, True, 1
                    self.ao_conexao(True)
                    async for msg in ws:
                        if isinstance(msg, bytes):
                            self.ao_audio(msg)
                        else:
                            self.ao_json(json.loads(msg))
            except Exception as e:
                self.ultimo_erro = str(e)
            if self.conectado:
                self.conectado = False
                self.ao_conexao(False)
            self.ws = None
            await asyncio.sleep(espera)
            espera = min(espera * 2, 15)

    def _agendar(self, coro):
        if self.ws is None:
            coro.close()
            return False
        asyncio.run_coroutine_threadsafe(coro, self.loop)
        return True

    def json(self, msg):
        ws = self.ws
        return self._agendar(ws.send(json.dumps(msg)) if ws else _nada())

    def fala(self, pcm, dica="", origem="nome", apelidos=()):
        ws = self.ws
        if ws is None:
            return False

        async def enviar():
            await ws.send(json.dumps({"t": "fala_inicio", "dica": dica, "origem": origem, "apelidos": list(apelidos)}))
            for i in range(0, len(pcm), 32000):
                await ws.send(pcm[i:i + 32000])
            await ws.send(json.dumps({"t": "fala_fim"}))

        return self._agendar(enviar())


async def _nada():
    return None
