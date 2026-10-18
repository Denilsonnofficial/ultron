# brain-ultron

Cérebro do Ultron: `huihui-ai/Qwen2.5-7B-Instruct-abliterated-v2` + QLoRA (Unsloth, r=16, 3 épocas, 145 exemplos) com a
persona do Ultron de *Vingadores: Era de Ultron* e tool calling no formato `<tool_call>`.

- `build_dataset.py` gera `data/brain_ultron.jsonl`; `train_brain_ultron.py` treina (pico de 6 GB de VRAM numa RTX 3060);
  `export_gguf.py` gera o GGUF q4_k_m; `chat.py` conversa com o LoRA.
- `Modelfile` registra o GGUF no Ollama (`ollama create brain-ultron -f Modelfile`, com o `FROM` apontando para o arquivo).
- O GGUF fica na release `brain-ultron-v1` (3 partes + `SHA256SUMS`); `instalar.sh` baixa, junta e confere sozinho. À mão:
  `cat brain-ultron.Q4_K_M.gguf.part-* > brain-ultron.Q4_K_M.gguf && sha256sum -c SHA256SUMS`.
