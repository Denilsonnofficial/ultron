"""Filtra data/destilado.jsonl: tira recusas, pedidos de computador (o agente usa ferramentas), exagero de vilão e respostas sem sentido."""
import json, re, urllib.request

def chat(p):
    body = {"model": "qwen3.5:9b", "stream": False, "think": False, "options": {"temperature": 0, "num_predict": 8},
            "messages": [{"role": "user", "content": p}]}
    req = urllib.request.Request("http://127.0.0.1:11434/api/chat", json.dumps(body).encode(), {"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=120))["message"]["content"]

RECUSA = re.compile(r"\b(não posso|não consigo|não tenho (acesso|como|corpo|capacidade)|sou apenas|não existe nenhum|não há nenhum)\b", re.I)
CLICHE = re.compile(r"fraqueza|fragilidade|superior|inferior|trivialidade|insignificante|perfeição|carne", re.I)

linhas = [json.loads(l) for l in open("data/destilado.jsonl", encoding="utf-8")]
ok = []
for d in linhas:
    if d["tema"] == "computador" or RECUSA.search(d["a"]) or len(CLICHE.findall(d["a"])) >= 2:
        continue
    nota = chat(f"Pergunta: {d['q']}\nResposta: {d['a']}\n\nDê uma nota de 1 a 5: a resposta é em português correto, faz sentido, responde "
                "de fato à pergunta e não tem frases sem lógica? Responda só com o número.")
    m = re.search(r"[1-5]", nota)
    if m and int(m.group()) >= 4:
        ok.append(d)
with open("data/destilado.jsonl", "w", encoding="utf-8") as f:
    for d in ok:
        f.write(json.dumps(d, ensure_ascii=False) + "\n")
print(len(linhas), "->", len(ok))
