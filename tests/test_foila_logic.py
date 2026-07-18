import os
import json
from openai import OpenAI

# 1. 配置 API (从环境变量读取)
api_key = os.getenv('ARK_API_KEY')
if not api_key:
    raise ValueError("请设置 ARK_API_KEY 环境变量")

client = OpenAI(
    base_url="https://ark.cn-beijing.volces.com/api/v3",
    api_key=api_key,
)

# 2. 准备测试文本 (严格还原分段)
# 注意：Gene Wolfe 的文本特点是对话常常跨段落。
source_text = """The only woman I recognized was Foila, and that only because she recognized me, calling "Severian!" as I walked among the wounded and dying. I went to her and tried to question her, but she was very weak and could tell me little. The attack had come without warning and shattered the lazaret like a thunderbolt; her memories were all of the aftermath, of hearing the screams that for a long time had brought no rescuers, and at last being dragged forth by soldiers who knew little of medicine. I kissed her as well as I could, and promised to come and see her again-a promise, I think, that both of us knew I would not be able to keep. She said, "Do you recall the time when all of us told stories? I thought of that."

I said I knew she had.

"I mean while they were carrying us here. Melito and Hallvard and the rest are dead, I think. You will be the only one who remembers, Severian."

I told her I would remember always."""

# 3. 构建 Prompt：强制逻辑分析 (Logic-First)
# 这里的核心是要求模型输出 JSON，先分析 "I mean" 的指代对象
system_prompt = """你是一个精通逻辑分析的文学翻译专家。你的任务是翻译复杂的英文小说文本。

在翻译之前，你必须执行【深度逻辑分析】，特别是针对对话中的衔接关系。
Gene Wolfe 的小说中，对话经常被叙述打断，或者后一句是对前几句的补充说明（而非紧接上一句）。

遇到 "I mean", "That is", "Which is" 等补充说明性的句子时，你必须：
1. 找到它具体修饰前文的哪句话？
2. 排除它修饰临近句子的可能性（如果逻辑不通）。
3. 在 JSON 中输出你的分析。

请按以下 JSON 格式输出（不要输出其他废话）：
{
    "logic_analysis": [
        {
            "quote": "原文中有歧义的句子",
            "connects_to": "它修饰的前文句子",
            "interpretation": "用中文解释它的实际含义和时间/逻辑关系",
            "disconnection": "明确它【不是】修饰哪句话（排雷）"
        }
    ],
    "translation": "最终的中文翻译（保持文学性，分段要对应）"
}
"""

print(f"--- 开始测试模型: ep-20260110004038-6h49x ---")
print("正在进行逻辑推演...\n")

try:
    response = client.chat.completions.create(
        model="ep-20260110004038-6h49x",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": source_text},
        ],
        temperature=0.1, # 低温以保证逻辑分析的准确性
        response_format={ "type": "json_object" } # 强制 JSON 输出
    )

    result_json = response.choices[0].message.content
    
    # 解析并打印结果
    parsed_result = json.loads(result_json)
    
    print("【逻辑分析结果】:")
    for analysis in parsed_result.get("logic_analysis", []):
        print(f"--- 分析对象: {analysis['quote']}")
        print(f"    -> 连接至: {analysis['connects_to']}")
        print(f"    -> 含义: {analysis['interpretation']}")
        print(f"    -> 排雷: {analysis['disconnection']}")
    
    print("\n【最终翻译】:")
    print(parsed_result.get("translation"))

except Exception as e:
    print(f"发生错误: {e}")
