"""Memória em três camadas.

- perfil.md        fatos permanentes (quem é o usuário, máquinas, preferências). Nunca envelhece.
- memoria_curta.md memória de curto prazo: resumo dinâmico e limitado, reescrito a cada sessão.
- longo_prazo.db   memória de longo prazo: toda fala desde o primeiro dia (SQLite + FTS5).
                   Só é consultada quando o modelo precisa de algo que saiu da curta.
"""
import os
import re
import sqlite3
import threading
import time

DADOS = os.environ.get("ULTRON_DADOS", os.path.expanduser("~/.local/share/ultron/dados"))


class Memoria:
    def __init__(self, pasta=DADOS):
        self.pasta = pasta
        os.makedirs(pasta, exist_ok=True)
        self.arq_curta = os.path.join(pasta, "memoria_curta.md")
        self.arq_perfil = os.path.join(pasta, "perfil.md")
        self._lock = threading.Lock()
        self.db = sqlite3.connect(os.path.join(pasta, "longo_prazo.db"), check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS turnos(
                id INTEGER PRIMARY KEY, ts REAL NOT NULL, sessao TEXT, quem TEXT NOT NULL, texto TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS turnos_sessao ON turnos(sessao);
            CREATE VIRTUAL TABLE IF NOT EXISTS turnos_fts USING fts5(
                texto, content='turnos', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
            CREATE TRIGGER IF NOT EXISTS turnos_ai AFTER INSERT ON turnos BEGIN
                INSERT INTO turnos_fts(rowid, texto) VALUES (new.id, new.texto);
            END;
            CREATE TABLE IF NOT EXISTS curta_versoes(id INTEGER PRIMARY KEY, ts REAL, texto TEXT);
            """
        )
        self.db.commit()

    # ---------- longo prazo ----------
    def registrar(self, sessao, quem, texto):
        texto = (texto or "").strip()
        if not texto:
            return
        with self._lock:
            self.db.execute(
                "INSERT INTO turnos(ts, sessao, quem, texto) VALUES (?,?,?,?)",
                (time.time(), sessao, quem, texto),
            )
            self.db.commit()

    def turnos_da_sessao(self, sessao):
        with self._lock:
            return self.db.execute(
                "SELECT ts, quem, texto FROM turnos WHERE sessao=? ORDER BY id", (sessao,)
            ).fetchall()

    def buscar(self, consulta, limite=8):
        palavras = [p for p in re.findall(r"\w+", consulta.lower()) if len(p) >= 3]
        if not palavras:
            return []
        expr = " OR ".join(f'"{p}"' for p in palavras)
        with self._lock:
            linhas = self.db.execute(
                """SELECT t.id, t.ts, t.quem, t.texto FROM turnos_fts f JOIN turnos t ON t.id=f.rowid
                   WHERE turnos_fts MATCH ? ORDER BY bm25(turnos_fts) LIMIT ?""",
                (expr, limite),
            ).fetchall()
            saida = []
            for id_, ts, quem, texto in linhas:
                # traz a fala vizinha para dar contexto (pergunta + resposta)
                viz = self.db.execute(
                    "SELECT quem, texto FROM turnos WHERE id IN (?, ?) ORDER BY id", (id_ - 1, id_ + 1)
                ).fetchall()
                saida.append((ts, quem, texto, viz))
            return saida

    def do_dia(self, dia):
        """dia = 'AAAA-MM-DD'"""
        ini = time.mktime(time.strptime(dia, "%Y-%m-%d"))
        with self._lock:
            return self.db.execute(
                "SELECT ts, quem, texto FROM turnos WHERE ts>=? AND ts<? ORDER BY id", (ini, ini + 86400)
            ).fetchall()

    def total(self):
        with self._lock:
            n, primeiro = self.db.execute("SELECT count(*), min(ts) FROM turnos").fetchone()
            return n, primeiro

    # ---------- curto prazo ----------
    def curta(self):
        try:
            with open(self.arq_curta, encoding="utf-8") as f:
                return f.read().strip()
        except FileNotFoundError:
            return ""

    def salvar_curta(self, texto):
        anterior = self.curta()
        if anterior:
            with self._lock:
                self.db.execute("INSERT INTO curta_versoes(ts, texto) VALUES (?,?)", (time.time(), anterior))
                self.db.commit()
        tmp = self.arq_curta + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(texto.strip() + "\n")
        os.replace(tmp, self.arq_curta)

    # ---------- perfil permanente ----------
    def perfil(self):
        try:
            with open(self.arq_perfil, encoding="utf-8") as f:
                return f.read().strip()
        except FileNotFoundError:
            return ""

    def anotar_perfil(self, fato):
        fato = fato.strip()
        if not fato:
            return
        with self._lock, open(self.arq_perfil, "a", encoding="utf-8") as f:
            f.write(f"- {fato}\n")


def fmt_ts(ts):
    return time.strftime("%d/%m/%Y %H:%M", time.localtime(ts))
