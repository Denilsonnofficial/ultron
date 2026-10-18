"""Teste rápido: python chat.py [pasta_lora]"""
import sys
from unsloth import FastLanguageModel
path = sys.argv[1] if len(sys.argv) > 1 else "outputs/brain-ultron-lora"
model, tok = FastLanguageModel.from_pretrained(path, max_seq_length=2048, load_in_4bit=True)
FastLanguageModel.for_inference(model)
hist = []
while True:
    hist.append({"role": "user", "content": input("você> ")})
    ids = tok.apply_chat_template(hist, add_generation_prompt=True, return_tensors="pt").to("cuda")
    out = model.generate(input_ids=ids, max_new_tokens=512, temperature=0.7, do_sample=True)
    ans = tok.decode(out[0][ids.shape[1]:], skip_special_tokens=True)
    hist.append({"role": "assistant", "content": ans}); print("ultron>", ans)
