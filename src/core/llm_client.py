"""
LLM 客户端工厂模块
支持多渠道模型切换：豆包、OpenAI、Anthropic、DeepSeek 等
"""
import os
import time
import json
import logging
from abc import ABC, abstractmethod
from typing import Optional, Dict, Any, List, Callable
from functools import wraps

from openai import OpenAI

# 配置日志
logger = logging.getLogger(__name__)

def retry_with_backoff(retries: int = 3, backoff_in_seconds: int = 1):
    """
    重试装饰器：指数退避策略
    """
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            x = 0
            while True:
                try:
                    return func(*args, **kwargs)
                except Exception as e:
                    if x == retries:
                        logger.error(f"LLM调用失败，已重试 {retries} 次: {e}")
                        raise e
                    sleep = (backoff_in_seconds * 2 ** x)
                    logger.warning(f"LLM调用出错: {e}. {sleep}秒后重试 ({x+1}/{retries})...")
                    time.sleep(sleep)
                    x += 1
        return wrapper
    return decorator

class BaseLLMClient(ABC):
    """
    LLM 客户端抽象基类
    定义统一的接口规范
    """
    
    def __init__(self, base_url: str, api_key: str, default_model: str, timeout: int = 600):
        self.base_url = base_url
        self.api_key = self._resolve_api_key(api_key)
        self.default_model = default_model
        self.timeout = timeout
    
    def _resolve_api_key(self, api_key: str) -> str:
        """解析 API Key，支持环境变量 ${VAR} 格式"""
        if api_key.startswith("${") and api_key.endswith("}"):
            env_var = api_key[2:-1]
            resolved = os.getenv(env_var)
            if not resolved:
                # 尝试从 ConfigLoader 已解析的配置中获取，或者直接报错
                # 在这里我们假设 ConfigLoader 已经处理过了，如果还是 ${} 说明环境变量缺失
                logger.warning(f"环境变量 {env_var} 未设置，使用原始字符串")
                return api_key 
            return resolved
        return api_key
    
    @abstractmethod
    def chat(
        self,
        messages: List[Dict[str, str]],
        model: Optional[str] = None,
        temperature: float = 0.7,
        max_tokens: int = 4096,
        json_mode: bool = False,
        stream: bool = False,
        extra_body: Optional[Dict[str, Any]] = None,
    ) -> Any:
        """
        发送聊天请求
        :param stream: 是否流式返回
        :return: 文本 (str) 或 生成器 (Iterator[str])
        """
        pass

class OpenAICompatibleClient(BaseLLMClient):
    """
    OpenAI 兼容客户端 (支持 OpenAI, Doubao, DeepSeek 等)
    """
    
    def __init__(self, base_url: str, api_key: str, default_model: str, timeout: int = 600):
        super().__init__(base_url, api_key, default_model, timeout)
        self.client = OpenAI(
            base_url=self.base_url,
            api_key=self.api_key,
            timeout=self.timeout
        )
    
    @retry_with_backoff(retries=3, backoff_in_seconds=2)
    def chat(
        self,
        messages: List[Dict[str, str]],
        model: Optional[str] = None,
        temperature: float = 0.7,
        max_tokens: int = 4096,
        json_mode: bool = False,
        stream: bool = False,
        extra_body: Optional[Dict[str, Any]] = None,
    ) -> Any:
        kwargs = {
            "model": model or self.default_model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": stream
        }
        
        if json_mode:
            kwargs["response_format"] = {"type": "json_object"}
        if extra_body:
            kwargs["extra_body"] = extra_body
        
        response = self.client.chat.completions.create(**kwargs)
        
        if stream:
            return self._stream_response(response)
        else:
            return response.choices[0].message.content

    def _stream_response(self, response):
        """
        处理流式响应生成器
        Yields:
            tuple: (type, content)
            type: "think" | "content"
        """
        for chunk in response:
            if not chunk.choices:
                continue
                
            delta = chunk.choices[0].delta
            
            # 支持 DeepSeek/Doubao 等模型的思维链字段
            if hasattr(delta, 'reasoning_content') and delta.reasoning_content:
                yield ("think", delta.reasoning_content)
            
            # 标准内容字段
            if delta.content:
                yield ("content", delta.content)

    @retry_with_backoff(retries=3, backoff_in_seconds=2)
    def chat_json(
        self,
        messages: List[Dict[str, str]],
        model: Optional[str] = None,
        temperature: float = 0.1,
        max_tokens: int = 4096
    ) -> Dict[str, Any]:
        """
        专门处理 JSON 返回的请求
        会自动尝试解析 JSON，如果解析失败会抛出异常触发重试
        """
        content = self.chat(
            messages=messages,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            json_mode=True
        )
        try:
            # 清理可能的 markdown 代码块标记
            content = content.strip()
            if content.startswith("```json"):
                content = content[7:]
            if content.endswith("```"):
                content = content[:-3]
            return json.loads(content)
        except json.JSONDecodeError as e:
            logger.error(f"JSON解析失败: {content[:100]}...")
            raise e



class AnthropicClient(BaseLLMClient):
    """
    Anthropic Claude 客户端
    注意：Claude 的 API 格式与 OpenAI 不同，需要单独处理
    """
    
    def __init__(self, base_url: str, api_key: str, default_model: str):
        super().__init__(base_url, api_key, default_model)
        # 延迟导入，避免未安装时报错
        try:
            from anthropic import Anthropic
            self.client = Anthropic(api_key=self.api_key)
        except ImportError:
            raise ImportError("请安装 anthropic 库: pip install anthropic")
    
    def chat(
        self,
        messages: List[Dict[str, str]],
        model: Optional[str] = None,
        temperature: float = 0.7,
        max_tokens: int = 4096,
        json_mode: bool = False,
        stream: bool = False,
        extra_body: Optional[Dict[str, Any]] = None,
    ) -> str:
        """发送聊天请求"""
        # 分离 system 消息
        system_msg = ""
        chat_messages = []
        for msg in messages:
            if msg["role"] == "system":
                system_msg = msg["content"]
            else:
                chat_messages.append(msg)
        
        response = self.client.messages.create(
            model=model or self.default_model,
            max_tokens=max_tokens,
            system=system_msg,
            messages=chat_messages
        )
        return response.content[0].text
    
    def chat_json(
        self,
        messages: List[Dict[str, str]],
        model: Optional[str] = None,
        temperature: float = 0.1,
        max_tokens: int = 4096
    ) -> Dict[str, Any]:
        """发送聊天请求，返回 JSON"""
        # Claude 需要在 prompt 中明确要求 JSON
        result = self.chat(
            messages=messages,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens
        )
        # 尝试提取 JSON
        return json.loads(result)


class LLMClientFactory:
    """
    LLM 客户端工厂
    根据配置创建对应的客户端实例
    """
    
    # 使用 OpenAI 兼容格式的 Provider
    OPENAI_COMPATIBLE = {"doubao", "openai", "deepseek", "custom"}
    
    @classmethod
    def create(
        cls,
        provider: str,
        base_url: str,
        api_key: str,
        default_model: str,
        timeout: int = 600,
    ) -> BaseLLMClient:
        """
        创建 LLM 客户端
        
        Args:
            provider: 服务商名称 (doubao, openai, anthropic, deepseek, custom)
            base_url: API 地址
            api_key: API Key (支持 ${ENV_VAR} 格式)
            default_model: 默认模型 ID
        
        Returns:
            对应的 LLM 客户端实例
        """
        if provider in cls.OPENAI_COMPATIBLE:
            return OpenAICompatibleClient(base_url, api_key, default_model, timeout=timeout)
        elif provider == "anthropic":
            return AnthropicClient(base_url, api_key, default_model)
        else:
            # 未知 provider，尝试用 OpenAI 兼容格式
            return OpenAICompatibleClient(base_url, api_key, default_model, timeout=timeout)


class LLMManager:
    """
    LLM 管理器
    统一管理多个模型实例，支持按用途（logic/draft/polish）调用不同模型
    """
    
    def __init__(self, config: Dict[str, Any]):
        """
        初始化 LLM 管理器
        
        Args:
            config: 从 config.yaml 读取的 llm 配置段
        """
        self.config = config
        self.active_provider = config["active_provider"]
        self.provider_config = config["providers"][self.active_provider]
        
        # 创建客户端（所有用途共用一个客户端，通过 model 参数区分）
        self.client = LLMClientFactory.create(
            provider=self.active_provider,
            base_url=self.provider_config["base_url"],
            api_key=self.provider_config["api_key"],
            default_model=self.provider_config["models"]["draft"],
            timeout=int(self.provider_config.get("timeout", 600)),
        )
        
        # 模型映射
        self.models = self.provider_config["models"]
        self.request_options = self.provider_config.get("request_options", {})
    
    def get_model(self, purpose: str) -> str:
        """获取指定用途的模型 ID"""
        return self.models.get(purpose, self.models["draft"])
    
    def chat(
        self,
        messages: List[Dict[str, str]],
        purpose: str = "draft",
        temperature: Optional[float] = None,
        max_tokens: int = 4096,
        json_mode: bool = False,
        stream: bool = False
    ) -> Any:
        """
        发送聊天请求
        
        Args:
            stream: 是否流式返回
        """
        model = self.get_model(purpose)
        temp = temperature if temperature is not None else (0.1 if purpose == "logic" else 0.7)
        extra_body = self.request_options.get(purpose) or self.request_options.get("default")
        
        return self.client.chat(
            messages=messages,
            model=model,
            temperature=temp,
            max_tokens=max_tokens,
            json_mode=json_mode,
            stream=stream,
            extra_body=extra_body,
        )
    
    def chat_json(
        self,
        messages: List[Dict[str, str]],
        purpose: str = "logic",
        temperature: float = 0.1,
        max_tokens: int = 4096
    ) -> Dict[str, Any]:
        """发送聊天请求，返回 JSON"""
        model = self.get_model(purpose)
        return self.client.chat_json(
            messages=messages,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens
        )
