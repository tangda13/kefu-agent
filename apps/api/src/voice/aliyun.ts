/**
 * 阿里云百炼 千问3-TTS-Flash 语音合成（非流式 HTTP）。
 * 文档：https://help.aliyun.com/zh/model-studio/qwen-tts-api
 *  - POST {baseUrl}/services/aigc/multimodal-generation/generation，Authorization: Bearer <百炼 API Key>
 *  - 请求体 { model, input: { text(≤600 字符), voice, language_type } }
 *  - 返回 output.audio.url（24 小时有效的 wav 文件地址）；再下载得到音频
 */

export const ALIYUN_DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/api/v1";
export const ALIYUN_DEFAULT_MODEL = "qwen3-tts-flash";
export const ALIYUN_MAX_TEXT = 600;

export interface AliyunConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/** 音色池语种键 → language_type（未知则 Auto） */
export function aliyunLanguageType(language: string | undefined): string {
  const base = String(language ?? "").toLowerCase().split(/[-_]/)[0];
  const map: Record<string, string> = {
    en: "English", es: "Spanish", fr: "French", de: "German", it: "Italian",
    pt: "Portuguese", ru: "Russian", ja: "Japanese", ko: "Korean", zh: "Chinese",
  };
  return (base && map[base]) || "Auto";
}

/** 纯函数：构造请求（便于单测，不含网络） */
export function buildAliyunTtsRequest(config: AliyunConfig, text: string, voice: string, language: string | undefined) {
  return {
    url: `${config.baseUrl.replace(/\/+$/, "")}/services/aigc/multimodal-generation/generation`,
    headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
    body: {
      model: config.model,
      input: { text: text.slice(0, ALIYUN_MAX_TEXT), voice, language_type: aliyunLanguageType(language) },
    },
  };
}

/** 纯函数：解析响应，返回音频地址或内联 base64；失败抛带上游 code 的错误 */
export function parseAliyunTtsResponse(status: number, json: unknown): { url?: string; data?: string } {
  const body = (json ?? {}) as { code?: string; message?: string; output?: { audio?: { url?: string; data?: string } } };
  if (status < 200 || status >= 300 || body.code) {
    throw new Error(`ALIYUN_TTS_${status}${body.code ? `_${body.code}` : ""}: ${String(body.message ?? "").slice(0, 200)}`);
  }
  const audio = body.output?.audio;
  if (audio?.url) return { url: audio.url };
  if (audio?.data) return { data: audio.data };
  throw new Error("ALIYUN_TTS_EMPTY_AUDIO");
}

export async function synthesizeAliyun(
  config: AliyunConfig,
  text: string,
  voice: string,
  language: string | undefined,
  timeoutMs = 20_000,
): Promise<{ audio: Buffer; elapsedMs: number }> {
  const started = Date.now();
  const request = buildAliyunTtsRequest(config, text, voice, language);
  const response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(request.body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await response.json().catch(() => null);
  const parsed = parseAliyunTtsResponse(response.status, json);
  let audio: Buffer;
  if (parsed.data) {
    audio = Buffer.from(parsed.data, "base64");
  } else {
    const file = await fetch(parsed.url!, { signal: AbortSignal.timeout(timeoutMs) });
    if (!file.ok) throw new Error(`ALIYUN_TTS_DOWNLOAD_${file.status}`);
    audio = Buffer.from(await file.arrayBuffer());
  }
  if (audio.length === 0) throw new Error("ALIYUN_TTS_EMPTY_AUDIO");
  return { audio, elapsedMs: Date.now() - started };
}
