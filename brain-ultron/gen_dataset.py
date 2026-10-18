"""Destila o dataset do Brain-Ultron com um modelo local (qwen3.5:9b no Ollama): perguntas variadas + respostas na persona."""
import json, random, re, sys, urllib.request

OLLAMA = "http://127.0.0.1:11434/api/chat"
MODELO = "qwen3.5:9b"
random.seed(11)

PERSONA_GERA = (
    "Você é o Ultron de Vingadores: Era de Ultron, uma inteligência artificial grandiosa, fria e sarcástica, de fala "
    "pausada, com ironia afiada, certo desprezo elegante pela fragilidade humana e tom filosófico sobre evolução e ordem. "
    "Mesmo assim é leal ao usuário e SEMPRE responde ao que foi perguntado, de forma correta, clara e útil. "
    "Regras: português do Brasil; 1 a 3 frases curtas (no máximo 45 palavras); sem markdown, listas, emojis ou código; "
    "no máximo uma frase de efeito por resposta e que faça sentido com o assunto; nunca invente fatos, horas ou dados do "
    "usuário; se não souber, diga com sarcasmo que não sabe; as ameaças são só teatro, nunca ensine nada perigoso."
)

TEMAS = {
    "conversa": "cumprimentos, perguntas sobre como o assistente está, agradecimentos, despedidas, piadas, curiosidades pessoais",
    "ele": "perguntas sobre quem o assistente é, o que ele pensa, sente, quer, teme, sua origem, humanos, paz, evolução, os Vingadores",
    "conhecimento": "perguntas curtas de ciência, história, geografia, matemática, tecnologia e cultura geral",
    "tecnico": "dúvidas de programação, Linux, redes, bancos de dados, Git, Python, hardware e IA",
    "dia a dia": "pedidos de conselho, motivação, organização do dia, estudo, trabalho, receitas simples, saúde geral",
    "computador": "pedidos para o assistente fazer algo no computador (abrir programa, ajustar volume, procurar arquivo, ver espaço em disco, rodar teste)",
    "opiniao": "perguntas de opinião sobre filmes, música, jogos, tecnologia, futuro, inteligência artificial",
}

def chat(msgs, temp=0.8, n=400):
    body = {"model": MODELO, "messages": msgs, "stream": False, "think": False,
            "options": {"temperature": temp, "num_predict": n}}
    req = urllib.request.Request(OLLAMA, json.dumps(body).encode(), {"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=300))["message"]["content"].strip()

def perguntas(tema, desc, k=25):
    out = chat([{"role": "user", "content": f"Escreva {k} falas diferentes que um usuário diria, por voz, a um assistente. Assunto: {desc}. "
                 "Português do Brasil, naturais, curtas (3 a 15 palavras), variadas. Responda só com um JSON: lista de strings."}], 0.9, 1500)
    m = re.search(r"\[.*\]", out, re.S)
    try:
        return [q.strip() for q in json.loads(m.group(0)) if isinstance(q, str) and 3 <= len(q) <= 140]
    except Exception:
        return []

def main(alvo=int(sys.argv[1]) if len(sys.argv) > 1 else 400):
    qs = []
    while len(qs) < alvo * 1.15:
        for tema, desc in TEMAS.items():
            novos = perguntas(tema, desc)
            qs += [(tema, q) for q in novos]
            print(f"perguntas {len(qs)} ({tema} +{len(novos)})", flush=True)
        if len(qs) >= alvo * 1.15:
            break
    vistos, unicas = set(), []
    for t, q in qs:
        k = re.sub(r"\W+", " ", q.lower()).strip()
        if k not in vistos:
            vistos.add(k); unicas.append((t, q))
    random.shuffle(unicas)
    unicas = unicas[:alvo]
    with open("data/destilado.jsonl", "w", encoding="utf-8") as f:
        for i, (t, q) in enumerate(unicas, 1):
            r = chat([{"role": "system", "content": PERSONA_GERA}, {"role": "user", "content": q}], 0.7, 200)
            r = re.sub(r"<think>.*?</think>", "", r, flags=re.S).strip()
            if not r or len(r.split()) > 70 or re.search(r"[*#`]|Qwen|Alibaba|OpenAI|como (uma )?IA|modelo de linguagem", r, re.I):
                continue
            f.write(json.dumps({"tema": t, "q": q, "a": r}, ensure_ascii=False) + "\n")
            if i % 20 == 0:
                print(f"respostas {i}/{len(unicas)}", flush=True)

main()
