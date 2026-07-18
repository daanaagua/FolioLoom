import os
import yaml
from openai import OpenAI

# 读取配置
try:
    with open("小说翻译/config/config.yaml", "r", encoding="utf-8") as f:
        config = yaml.safe_load(f)
        doubao_config = config["llm"]["providers"]["doubao"]
        api_key = doubao_config["api_key"]
        base_url = doubao_config["base_url"]
        # 使用逻辑分析模型，通常推理能力更强
        model = doubao_config["models"]["logic"] 
except Exception as e:
    print(f"读取配置失败: {e}")
    exit(1)

client = OpenAI(
    api_key=api_key,
    base_url=base_url,
)

print(f"Testing model: {model}")
print("Sending prompt: '9.11 和 9.8 哪个大？请一步步思考。' (Streaming enabled)")
print("-" * 50)

try:
    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "user", "content": "9.11 和 9.8 哪个大？请一步步思考。"}
        ],
        stream=True
    )

    for chunk in response:
        # 打印原始 chunk 结构的一个片段，方便观察
        # 我们重点关注 delta 中是否有 reasoning_content 或 content
        delta = chunk.choices[0].delta
        
        # 检查是否有 reasoning_content (DeepSeek style)
        if hasattr(delta, 'reasoning_content') and delta.reasoning_content:
            print(f"[THINK] {delta.reasoning_content}", end="", flush=True)
        
        # 检查 content
        if delta.content:
            print(f"[CONTENT] {delta.content}", end="", flush=True)
            
except Exception as e:
    print(f"\nError: {e}")
