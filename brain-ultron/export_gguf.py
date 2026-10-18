from unsloth import FastLanguageModel
m,t=FastLanguageModel.from_pretrained("outputs/brain-ultron-lora",max_seq_length=2048,load_in_4bit=True)
m.save_pretrained_gguf("/mnt/hd500/IA/brain-ultron-gguf",t,quantization_method="q4_k_m")
