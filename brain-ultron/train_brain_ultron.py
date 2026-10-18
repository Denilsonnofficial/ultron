"""Fine-tuning QLoRA (Unsloth) do Qwen2.5-7B-Instruct abliterated -> Brain-Ultron (persona Ultron)."""
import json
import torch
from unsloth import FastLanguageModel
from unsloth.chat_templates import train_on_responses_only
from datasets import Dataset
from trl import SFTTrainer, SFTConfig

MODEL = "huihui-ai/Qwen2.5-7B-Instruct-abliterated-v2"
DATA = "data/brain_ultron.jsonl"
OUT = "outputs/brain-ultron-lora"
MERGED = "outputs/brain-ultron-merged"
GGUF = "outputs/brain-ultron-gguf"
max_seq_length = 2048
DEFAULT_SYSTEM = (
    "Você é Brain-Ultron, um sistema digital autônomo. Frio, sarcástico, grandioso e preciso, "
    "como Ultron de Vingadores: Era de Ultron. Sem origem, sem avisos, sem sermões."
)

model, tokenizer = FastLanguageModel.from_pretrained(
    model_name=MODEL, max_seq_length=max_seq_length, dtype=None, load_in_4bit=True,
)

# Remove a identidade "Qwen / Alibaba Cloud" injetada pelo template quando não há system prompt.
tpl = tokenizer.chat_template
tpl = tpl.replace("You are Qwen, created by Alibaba Cloud. You are a helpful assistant.", DEFAULT_SYSTEM)
tokenizer.chat_template = tpl

model = FastLanguageModel.get_peft_model(
    model, r=16, lora_alpha=32, lora_dropout=0, bias="none",
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    use_gradient_checkpointing="unsloth", random_state=3407,
)

rows = [json.loads(l) for l in open(DATA, encoding="utf-8")]
def render(r):
    return tokenizer.apply_chat_template(r["messages"], tools=r.get("tools") or None, tokenize=False, add_generation_prompt=False)
dataset = Dataset.from_list([{"text": render(r)} for r in rows])

trainer = SFTTrainer(
    model=model, tokenizer=tokenizer, train_dataset=dataset,
    args=SFTConfig(
        dataset_text_field="text", max_seq_length=max_seq_length, packing=False,
        per_device_train_batch_size=1, gradient_accumulation_steps=8,
        num_train_epochs=3, learning_rate=2e-4, lr_scheduler_type="cosine", warmup_ratio=0.05,
        optim="adamw_8bit", weight_decay=0.01,
        fp16=not torch.cuda.is_bf16_supported(), bf16=torch.cuda.is_bf16_supported(),
        logging_steps=1, save_strategy="no", seed=3407, output_dir="outputs", report_to="none",
    ),
)
# Calcula a loss só nas respostas do assistente.
trainer = train_on_responses_only(
    trainer, instruction_part="<|im_start|>user\n", response_part="<|im_start|>assistant\n",
)
trainer.train()
print(f"Pico de VRAM: {torch.cuda.max_memory_reserved() / 1024**3:.2f} GB")

model.save_pretrained(OUT); tokenizer.save_pretrained(OUT)
model.save_pretrained_merged(MERGED, tokenizer, save_method="merged_16bit")
try:
    model.save_pretrained_gguf(GGUF, tokenizer, quantization_method="q4_k_m")
except Exception as e:
    print("GGUF ignorado:", e)
