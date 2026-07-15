import { randomUUID } from "node:crypto";
import WebSocket from "ws";

// 火山引擎 v3 二进制协议常量
const MSG_FULL_CLIENT = 0b0001;
const MSG_FULL_SERVER = 0b1001;
const MSG_AUDIO_ONLY = 0b1011;
const MSG_ERROR = 0b1111;
const FLAG_WITH_EVENT = 0b100;
const EVENT_SESSION_FINISHED = 152;
const EVENT_SESSION_FAILED = 153;
const EVENT_TTS_ENDED = 359;
const CONNECTION_EVENTS = new Set([1, 2, 50, 51, 52]);

function buildClientFrame(payload: Buffer): Buffer {
  // version1+headerSize1 / type+flag / serializationJSON+compression0 / reserved
  const header = Buffer.from([0x11, (MSG_FULL_CLIENT << 4) | 0, 0x10, 0x00]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length);
  return Buffer.concat([header, size, payload]);
}

interface ServerFrame {
  type: number;
  event: number | null;
  payload: Buffer;
  errorCode: number | null;
}

function parseServerFrame(data: Buffer): ServerFrame {
  const headerSize = (data[0]! & 0x0f) * 4;
  const type = data[1]! >> 4;
  const flag = data[1]! & 0x0f;
  let offset = headerSize;
  let event: number | null = null;
  let errorCode: number | null = null;
  if (flag === 0b01 || flag === 0b11) offset += 4; // sequence
  if (type === MSG_ERROR) {
    errorCode = data.readUInt32BE(offset);
    offset += 4;
  }
  if (flag & FLAG_WITH_EVENT) {
    event = data.readInt32BE(offset);
    offset += 4;
    if (!CONNECTION_EVENTS.has(event)) {
      const sessionIdLength = data.readUInt32BE(offset);
      offset += 4 + sessionIdLength;
    }
  }
  const payloadLength = data.readUInt32BE(offset);
  offset += 4;
  return { type, event, errorCode, payload: data.subarray(offset, offset + payloadLength) };
}

export interface TtsConfig {
  apiKey: string;
  resourceId: string;
  speaker: string;
}

/** 画像语言 → ASR language 参数映射（zh/en 用默认中英模型，留空即可） */
export function mapAsrLanguage(language: string | undefined): string | null {
  if (!language) return null;
  const lower = language.toLowerCase();
  if (lower.startsWith("es")) return "es-MX";
  if (lower.startsWith("fr")) return "fr-FR";
  if (lower.startsWith("ja")) return "ja-JP";
  return null;
}

/** 画像语言 → 豆包 explicit_language 映射 */
export function mapExplicitLanguage(language: string | undefined): string | null {
  if (!language) return null;
  const lower = language.toLowerCase();
  if (lower.startsWith("en")) return "en";
  if (lower.startsWith("es")) return "es-mx";
  if (lower.startsWith("fr")) return "fr";
  if (lower.startsWith("ja")) return "ja";
  if (lower.startsWith("zh")) return "zh-cn";
  return null;
}

export interface TtsResult {
  audio: Buffer;
  elapsedMs: number;
}

/** 豆包单向流式语音合成：一次性输入文本，流式收集音频（mp3） */
export async function synthesizeSpeech(
  config: TtsConfig,
  text: string,
  timeoutMs = 20_000,
  explicitLanguage: string | null = null,
): Promise<TtsResult> {
  const started = Date.now();
  return new Promise<TtsResult>((resolve, reject) => {
    const ws = new WebSocket("wss://openspeech.bytedance.com/api/v3/tts/unidirectional/stream", {
      headers: {
        "X-Api-Key": config.apiKey,
        "X-Api-Resource-Id": config.resourceId,
        "X-Api-Request-Id": randomUUID(),
      },
    });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("TTS_TIMEOUT"));
    }, timeoutMs);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* noop */ }
      if (error) reject(error);
      else resolve({ audio: Buffer.concat(chunks), elapsedMs: Date.now() - started });
    };
    ws.on("open", () => {
      const payload = Buffer.from(
        JSON.stringify({
          req_params: {
            text,
            speaker: config.speaker,
            audio_params: { format: "mp3", sample_rate: 24000 },
            ...(explicitLanguage
              ? { additions: JSON.stringify({ explicit_language: explicitLanguage }) }
              : {}),
          },
        }),
        "utf-8",
      );
      ws.send(buildClientFrame(payload));
    });
    ws.on("message", (data: Buffer) => {
      try {
        const frame = parseServerFrame(data);
        if (frame.type === MSG_ERROR) {
          finish(new Error(`TTS_ERROR_${frame.errorCode}: ${frame.payload.toString("utf-8").slice(0, 200)}`));
          return;
        }
        if (frame.type === MSG_AUDIO_ONLY) {
          if (frame.payload.length > 0) chunks.push(frame.payload);
          return;
        }
        if (frame.type === MSG_FULL_SERVER) {
          if (frame.event === EVENT_SESSION_FINISHED || frame.event === EVENT_TTS_ENDED) {
            if (chunks.length === 0) finish(new Error("TTS_EMPTY_AUDIO"));
            else finish();
          } else if (frame.event === EVENT_SESSION_FAILED) {
            finish(new Error(`TTS_SESSION_FAILED: ${frame.payload.toString("utf-8").slice(0, 200)}`));
          }
        }
      } catch (error) {
        finish(error as Error);
      }
    });
    ws.on("error", (error) => finish(error as Error));
    ws.on("close", () => {
      // 服务端直接断开：有音频则视为完成
      clearTimeout(timer);
      if (chunks.length > 0) resolve({ audio: Buffer.concat(chunks), elapsedMs: Date.now() - started });
    });
  });
}

export interface AsrConfig {
  apiKey: string;
  resourceId: string;
}

export interface AsrResult {
  text: string;
  elapsedMs: number;
}

const ASR_MSG_AUDIO_ONLY = 0b0010;
const ASR_FLAG_LAST_PACKET = 0b0010;

function buildAsrFrame(type: number, flags: number, serialization: number, payload: Buffer): Buffer {
  const header = Buffer.from([0x11, (type << 4) | flags, (serialization << 4) | 0, 0x00]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length);
  return Buffer.concat([header, size, payload]);
}

/** 豆包流式语音识别（流式输入模式）：整段音频分包送入，最后一包后取最终识别结果 */
export async function recognizeSpeech(
  config: AsrConfig,
  audio: Buffer,
  format: "wav" | "mp3" | "pcm",
  language: string | null = null,
  timeoutMs = 15_000,
): Promise<AsrResult> {
  const started = Date.now();
  return new Promise<AsrResult>((resolve, reject) => {
    const ws = new WebSocket("wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream", {
      headers: {
        "X-Api-Key": config.apiKey,
        "X-Api-Resource-Id": config.resourceId,
        "X-Api-Request-Id": randomUUID(),
        "X-Api-Connect-Id": randomUUID(),
      },
    });
    let lastText = "";
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("ASR_TIMEOUT"));
    }, timeoutMs);
    const finish = (error?: Error, text?: string) => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* noop */ }
      if (error) reject(error);
      else resolve({ text: text ?? lastText, elapsedMs: Date.now() - started });
    };
    ws.on("open", () => {
      const request = {
        user: { uid: "cecs-student" },
        audio: {
          format,
          rate: 16000,
          bits: 16,
          channel: 1,
          ...(language ? { language } : {}),
        },
        request: { model_name: "bigmodel", enable_punc: true, enable_itn: true },
      };
      ws.send(buildAsrFrame(MSG_FULL_CLIENT, 0, 1, Buffer.from(JSON.stringify(request), "utf-8")));
      // 按 ~200ms（16k*2B*0.2=6400B）分包连续发送，最后一包置负包标记
      const chunkSize = 6400;
      for (let offset = 0; offset < audio.length; offset += chunkSize) {
        const chunk = audio.subarray(offset, offset + chunkSize);
        const isLast = offset + chunkSize >= audio.length;
        ws.send(buildAsrFrame(ASR_MSG_AUDIO_ONLY, isLast ? ASR_FLAG_LAST_PACKET : 0, 0, chunk));
      }
    });
    ws.on("message", (data: Buffer) => {
      try {
        const type = data[1]! >> 4;
        const flags = data[1]! & 0x0f;
        let offset = (data[0]! & 0x0f) * 4;
        if (type === MSG_ERROR) {
          const code = data.readUInt32BE(offset);
          const size = data.readUInt32BE(offset + 4);
          finish(new Error(`ASR_ERROR_${code}: ${data.subarray(offset + 8, offset + 8 + size).toString("utf-8").slice(0, 200)}`));
          return;
        }
        if (type !== MSG_FULL_SERVER) return;
        if (flags & 0b01) offset += 4; // sequence
        const payloadSize = data.readUInt32BE(offset);
        offset += 4;
        const payload = JSON.parse(data.subarray(offset, offset + payloadSize).toString("utf-8"));
        if (typeof payload?.result?.text === "string") lastText = payload.result.text;
        if (flags & 0b10) finish(undefined, lastText); // 最后一包结果
      } catch (error) {
        finish(error as Error);
      }
    });
    ws.on("error", (error) => finish(error as Error));
    ws.on("close", () => {
      clearTimeout(timer);
      if (lastText) resolve({ text: lastText, elapsedMs: Date.now() - started });
    });
  });
}
