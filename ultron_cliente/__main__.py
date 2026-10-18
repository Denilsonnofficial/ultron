"""ultron                 no terminal: abre o harness (conversa por texto e comandos /)
                     fora do terminal (menu, login): abre o gadget
ultron gadget          abre o gadget flutuante
ultron terminal        abre uma janela de terminal com o harness (atalho do menu)
ultron configurar      refaz a configuração
ultron atualizar       baixa a versão mais nova do GitHub (mantém configuração e memória)
ultron texto "..."     manda uma pergunta digitada e mostra/toca a resposta
ultron teste-wav x.wav usa um .wav (16 kHz mono) no lugar do microfone, grava a resposta em resposta.wav
ultron microfones      lista as entradas de áudio
"""
import sys
import time

from . import config

VERSAO = "1.0.0"


def main():
    args = sys.argv[1:]
    cmd = args[0] if args else ""
    if cmd in ("-h", "--help", "ajuda"):
        print(__doc__)
        return 0
    if cmd in ("-v", "--versao", "--version"):
        print(VERSAO)
        return 0
    if cmd == "configurar":
        from . import assistente
        from .app import garantir_base

        garantir_base(config.carregar(), esperar=60)
        assistente.rodar()
        if "--sem-gadget" not in args:
            from .app import abrir_gadget_destacado

            abrir_gadget_destacado()
            print("  O gadget está aberto. Pode fechar este terminal.")
            if sys.stdin.isatty():
                time.sleep(4)
        return 0
    if cmd == "terminal":
        from .app import abrir_terminal

        return 0 if abrir_terminal([]) else 1
    if cmd == "atualizar":
        import subprocess

        url = "https://raw.githubusercontent.com/Denilsonnofficial/ultron/main/install.sh"
        r = subprocess.run(["bash", "-c", f"curl -fsSL {url} | bash -s -- --sem-configurar"])
        if r.returncode == 0:
            subprocess.run(["systemctl", "--user", "restart", "ultron-base.service", "ultron.service"], capture_output=True)
            print("Atualizado e reiniciado.")
        return r.returncode
    if cmd == "microfones":
        from .audio import listar_microfones

        for nome, desc in listar_microfones():
            print(f"{desc}\n    {nome}")
        return 0
    if cmd in ("texto", "teste-wav"):
        from .app import Cliente, garantir_base

        garantir_base(config.carregar(), esperar=60)
        from .audio import FonteWav

        cfg = config.carregar()
        cfg["mudo"] = False                     # o teste não herda o mudo do gadget
        fonte = FonteWav(args[1]) if cmd == "teste-wav" else None
        gravar = "resposta.wav" if cmd == "teste-wav" else None
        cli = Cliente(cfg, fonte=fonte, gravar_em=gravar, log=True)
        if cmd == "texto":
            cli.ouvinte.pausado = True
        cli.iniciar()
        t0 = time.time()
        while not cli.rede.conectado and time.time() - t0 < 10:
            time.sleep(0.1)
        if cmd == "texto":
            cli.rede.json({"t": "texto", "texto": " ".join(args[1:])})
        if cmd == "texto":
            cli.ultima_resposta.wait(240)
        else:                                   # vai até o fim do áudio e da última resposta
            limite = time.time() + 300
            while not fonte.fim.is_set() and time.time() < limite:
                time.sleep(0.2)
            quieto = 0.0
            while quieto < 4 and time.time() < limite:
                ativo = cli.estado_base in ("pensando", "agindo", "falando") or cli.reprodutor.tocando() or cli.ouvinte.pendente
                quieto = 0.0 if ativo else quieto + 0.2
                time.sleep(0.2)
        time.sleep(0.5)
        while cli.reprodutor.tocando():
            time.sleep(0.1)
        cli.fechar()
        return 0

    cfg = config.carregar()
    if cmd == "" and sys.stdin.isatty() and sys.stdout.isatty():
        from .app import abrir_gadget_destacado, garantir_base, pid_gadget
        from . import harness

        if not garantir_base(cfg, esperar=60):
            print("A base local não subiu. Veja: systemctl --user status ultron-base  (ou ~/.local/share/ultron/dados/base.log)")

        if not cfg.get("configurado"):
            from . import assistente

            assistente.rodar()
            abrir_gadget_destacado()
        elif not pid_gadget():
            abrir_gadget_destacado()
        return harness.rodar()
    if not cfg.get("configurado"):
        if sys.stdin.isatty():
            from . import assistente
            from .app import abrir_gadget_destacado

            assistente.rodar()
            abrir_gadget_destacado()
            return 0
        else:
            from .app import abrir_terminal

            if abrir_terminal(["configurar"]):
                return 0
    from .app import rodar_gadget

    return rodar_gadget()


if __name__ == "__main__":
    sys.exit(main())
