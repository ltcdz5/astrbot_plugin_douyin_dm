"""AstrBot adapter for the standalone perception engine."""
from copy import deepcopy
from types import SimpleNamespace

from astrbot.core.agent.message import ContentPart, Message
from astrbot.core.provider.sources.openai_source import ProviderOpenAIOfficial
from .bridge import BrowserError
from .mimi_douyin import perception as _engine
from .mimi_douyin.perception import (TEXT_MODE, NATIVE_MODE, DEFAULT_PROMPT, SCHEMA_PROMPT,
    VideoTranscript, format_transcript, uses_text_transcription)

class AudioFilePart(ContentPart):
    type:str='file'
    file:dict[str,str]

class _Context:
    def __init__(self,context):self.context=context
    def get_provider_by_id(self,provider_id):return self.context.get_provider_by_id(provider_id)
    async def llm_generate(self,**kwargs):
        perception_task=kwargs.pop('perception_task',None)
        wire_messages=[message.model_dump(mode='json') if hasattr(message,'model_dump') else deepcopy(message)
                       for message in kwargs['contexts']]
        kwargs['max_tokens']=(max(1,int(kwargs.get('max_tokens',600))) if perception_task=='image'
                              else max(3600,int(kwargs.get('max_tokens',3600))))
        provider=self.get_provider_by_id(kwargs['chat_provider_id'])
        if isinstance(provider,ProviderOpenAIOfficial):
            # AstrBot drops tool_choice when no FunctionTool is supplied. These
            # visual/audio calls only produce descriptions, never execute tools.
            # Reuse the configured SDK client so credentials/proxy stay native.
            extra=deepcopy(provider.provider_config.get('custom_extra_body') or {})
            extra.pop('tools',None);extra.pop('tool_choice',None)
            from urllib.parse import urlsplit
            base_url=getattr(provider.client,'base_url',None) or provider.provider_config.get('api_base','')
            try:host=urlsplit(str(base_url)).hostname
            except ValueError:host=None
            request_options={}
            if (host=='api.siliconflow.cn'
                    and provider.get_model() in ('Qwen/Qwen3-VL-30B-A3B-Instruct','Qwen/Qwen3.8-27B')
                    and 'response_format' not in extra):
                request_options['response_format']={'type':'json_object'}
            completion=await provider.client.chat.completions.create(
                model=provider.get_model(),
                messages=wire_messages,
                max_tokens=kwargs.get('max_tokens',2200),stream=False,
                tools=[],tool_choice='none',extra_body=extra,**request_options,
            )
            if not completion.choices:
                raise BrowserError('视频识别接口没有返回候选内容。')
            if completion.choices[0].finish_reason=='length':
                raise BrowserError('视频识别输出被截断，未采用不完整结果。')
            message=completion.choices[0].message
            if message.tool_calls:
                raise BrowserError('视频识别接口仅应返回识别内容，却返回了工具调用；未把它当作视频描述。')
            content=message.content
            if isinstance(content,list):
                content=''.join(part.get('text','') for part in content
                    if isinstance(part,dict) and part.get('type')=='text')
            if not isinstance(content,str) or not content.strip():
                raise BrowserError('视频识别接口没有返回可用的画面或声音描述。')
            return SimpleNamespace(role='assistant',completion_text=content)
        kwargs['contexts']=[Message.model_validate(message) for message in wire_messages]
        return await self.context.llm_generate(**kwargs)

class _Owner:
    def __init__(self,owner):self.owner=owner;self.context=_Context(owner.context)
    @property
    def asr_cache_version(self):
        provider_id = str(self.owner.config.get("video_provider_id") or "").strip()
        return "omni-audio-v1|" + provider_id
    def __getattr__(self,name):return getattr(self.owner,name)

SILICONFLOW_ASR_MODEL = "Qwen/Qwen3-Omni-30B-A3B-Instruct"
ASR_PROMPT = (
    "请逐字转写音频中实际听到的人声，包括对白、旁白和演唱的原样歌词。"
    "保持原语言、原词句和顺序，不翻译、不总结、不润色，不根据歌曲知识补全歌词。"
    "只输出转写文本；听不清的部分标记为[听不清]；没有可辨认的人声时输出空字符串。"
)


def _asr_connection(owner):
    """Read the selected provider's active credentials without changing its model."""
    provider_id = str(
        getattr(owner, "config", {}).get("video_provider_id") or ""
    ).strip()
    if not provider_id:
        raise BrowserError("音轨转写缺少 video_provider_id 配置。")
    try:
        provider = owner.context.get_provider_by_id(provider_id)
        client = getattr(provider, "client", None)
        api_key = getattr(client, "api_key", None)
        config = getattr(provider, "provider_config", None) or {}
        base_url = getattr(client, "base_url", None) or config.get("api_base")
    except Exception:
        raise BrowserError("音轨转写读取所选 provider 配置失败。") from None
    if not isinstance(api_key, str) or not api_key.strip() or not base_url:
        raise BrowserError("音轨转写所选 provider 缺少可用 client 凭据或 API 地址。")
    from urllib.parse import urlsplit

    try:
        parsed = urlsplit(str(base_url))
        valid = (parsed.scheme == "https"
                 and parsed.hostname == "api.siliconflow.cn"
                 and parsed.port in (None, 443)
                 and parsed.path.rstrip("/") == "/v1"
                 and not parsed.username and not parsed.password
                 and not parsed.query and not parsed.fragment)
    except ValueError:
        valid = False
    if not valid:
        raise BrowserError("音轨转写需要硅基流动 HTTPS /v1 API 地址。")
    return str(base_url).rstrip("/") + "/chat/completions", api_key


def _save_asr_diagnostic(owner, diagnostic):
    """Persist only bounded metadata; storage errors must never replay a request."""
    ledger = getattr(owner, "ledger", None)
    if ledger is not None:
        try:
            ledger.put("asr-debug:" + diagnostic["audio_sha256"], diagnostic)
        except Exception:
            pass


async def _sensevoice(audio_bytes, filename, *, owner=None):
    """Transcribe one MP3 using Omni, with one request and metadata-only diagnostics."""
    import base64
    import hashlib
    import time
    import httpx
    started = time.monotonic()
    diagnostic = {"model": SILICONFLOW_ASR_MODEL,
                  "audio_sha256": hashlib.sha256(audio_bytes).hexdigest(),
                  "audio_bytes": len(audio_bytes), "http_status": None,
                  "elapsed_seconds": 0.0, "text_chars": 0,
                  "state": "failed", "error_type": None}
    try:
        url, api_key = _asr_connection(owner)
        audio_url = "data:audio/mpeg;base64," + base64.b64encode(
            audio_bytes
        ).decode("ascii")
        async with httpx.AsyncClient(timeout=120) as client:
            response = await client.post(
                url,
                headers={"Authorization": "Bearer " + api_key},
                json={
                    "model": SILICONFLOW_ASR_MODEL,
                    "messages": [{"role": "user", "content": [
                        {"type": "text", "text": ASR_PROMPT},
                        {"type": "audio_url", "audio_url": {"url": audio_url}},
                    ]}],
                    "max_tokens": 4096,
                    "temperature": 0,
                    "stream": False,
                },
            )
        diagnostic["http_status"] = response.status_code
        if response.status_code != 200:
            raise BrowserError(f'音轨转写接口返回 {response.status_code}。')
        try:
            payload = response.json()
        except ValueError:
            raise BrowserError("音轨转写接口未返回有效 JSON。") from None
        choices = payload.get("choices") if isinstance(payload, dict) else None
        if (not isinstance(choices, list) or not choices
                or not isinstance(choices[0], dict)):
            raise BrowserError("音轨转写接口缺少有效 choices[0]。")
        choice = choices[0]
        if choice.get("finish_reason") == "length":
            raise BrowserError("音轨转写输出被截断，未采用不完整结果。")
        message = choice.get("message")
        if (not isinstance(message, dict)
                or not isinstance(message.get("content"), str)):
            raise BrowserError("音轨转写接口的 message.content 应为字符串。")
        text = message["content"].strip()
        diagnostic.update(state="draft" if text else "empty", text_chars=len(text))
        return text
    except Exception as exc:
        diagnostic["error_type"] = type(exc).__name__
        if isinstance(exc, BrowserError):
            raise
        raise BrowserError("音轨转写请求失败（" + type(exc).__name__ + "）。") from None
    finally:
        diagnostic["elapsed_seconds"] = round(time.monotonic() - started, 6)
        _save_asr_diagnostic(owner, diagnostic)

def _audio_target(path):
    from pathlib import Path
    return Path(path).with_name(Path(path).stem + '-transcription.mp3')

def _visual_target(path):
    from pathlib import Path
    return Path(path).with_name(Path(path).stem + '-vision.mp4')

def _fresh(file):
    import os
    try:return os.path.isfile(str(file)) and os.path.getsize(str(file)) > 0
    except OSError: return False

_prepared = {}

async def _audio_parts(owner, paths):
    if not paths:return []
    import asyncio, base64
    from astrbot.core.agent.message import TextPart
    async def one(index,path):
        try:
            files=await _engine._audio_parts(owner,[path])
            if not files:return f'视频 {index+1} 音轨状态：no_audio（经 ffprobe 确认无音轨）。'
            uri=(files[0].file or {}).get('file_data') or ''
            if ',' not in uri:raise ValueError('invalid audio input')
            raw=base64.b64decode(uri.split(',',1)[1])
            text=await _sensevoice(raw,(files[0].file or {}).get('filename') or 'audio.mp3',owner=owner)
            return f'视频 {index+1} ASR 状态：draft；ASR 初稿（仅候选，须与画面字幕校对）：\n{text}' if text else f'视频 {index+1} ASR 状态：empty；转写成功但文本为空，不代表无音轨或无声音。'
        except Exception as exc:
            print(f'[douyin_dm] ASR 初稿不可用，声音内容未知：{type(exc).__name__}')
            return f'视频 {index+1} ASR 状态：failed；转写服务或音轨读取失败，勿当作无声。'
    drafts=await asyncio.gather(*(one(i,p) for i,p in enumerate(paths)))
    return [TextPart(text='\n\n'.join(text for text in drafts if text))] if any(drafts) else []

async def transcribe_video(owner,sources):
    return await _engine.transcribe_video(_Owner(owner),sources,audio_factory=_audio_parts)
