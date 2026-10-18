# brain-ultron

Cérebro do Ultron: `huihui-ai/Qwen2.5-7B-Instruct-abliterated-v2` + QLoRA (Unsloth, r=16, alpha 16, dropout 0,05, 2 épocas, lr 1e-4, ~330 exemplos + validação) com a
persona do Ultron de *Vingadores: Era de Ultron* e tool calling no formato `<tool_call>`.

- `build_dataset.py` gera `data/brain_ultron.jsonl`; `train_brain_ultron.py` treina (pico de 6 GB de VRAM numa RTX 3060);
  `export_gguf.py` gera o GGUF q4_k_m; `chat.py` conversa com o LoRA.
- `Modelfile` registra o GGUF no Ollama (`ollama create brain-ultron -f Modelfile`, com o `FROM` apontando para o arquivo).
- O GGUF fica na release `brain-ultron-v2` (3 partes + `SHA256SUMS`); `instalar.sh` baixa, junta e confere sozinho. À mão:
  `cat brain-ultron.Q4_K_M.gguf.part-* > brain-ultron.Q4_K_M.gguf && sha256sum -c SHA256SUMS`.

## Como treinar (v2)

Lições da v1 (145 exemplos, 3 épocas, lr 2e-4, persona repetida 3x): o modelo decorou frases e falava sem sentido. Na v2 (seguindo o
[guia de hiperparâmetros do Unsloth](https://docs.unsloth.ai/get-started/fine-tuning-guide/lora-hyperparameters-guide)):
dataset maior e variado, cada exemplo uma vez só, system prompts variados (inclusive o de voz do assistente), 1–3 épocas,
dropout, validação separada (a loss de validação tem de cair junto) e exemplos de tool calling misturados.

```
python gen_dataset.py 420      # destila perguntas/respostas na persona com um modelo local do Ollama (qwen3.5:9b)
python filtrar_dataset.py      # tira recusas, vilão exagerado e respostas sem sentido (nota do próprio modelo)
python build_dataset.py        # junta persona escrita à mão + destilado + tool calling; separa 8% para validação
python train_brain_ultron.py   # QLoRA (pico de ~6 GB de VRAM)
python export_gguf.py          # GGUF q4_k_m (precisa de ~30 GB livres no destino)
```
