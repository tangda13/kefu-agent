// 尝试加载 apps/api/.env（不存在时静默跳过；密钥仅存于服务端环境，不入库不下发）
try {
  process.loadEnvFile?.();
} catch {
  /* no .env file */
}

export interface ApiEnv {
  databaseUrl: string;
  jwtSecret: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  adminInitialPassword: string;
  /**
   * 允许跨域的来源。生产环境客户端从服务器加载页面（D-83），页面和接口同源，不需要跨域：
   * 没配 CORS_ORIGINS 时生产为 false（不放行任何跨域），开发为 true（前端 5288 调接口 8787）
   */
  corsOrigins: string[] | boolean;
  /**
   * 学生、教师只能用客户端登录（参数 4.2.2，A3）：生产默认开，开发 / 测试默认关（方便浏览器里调试）；DESKTOP_ONLY 显式覆盖
   */
  desktopOnly: boolean;
  /** 部署在 nginx 后面时置真，request.ip 取 X-Forwarded-For（登录限流按 IP 计数依赖它） */
  trustProxy: boolean;
  port: number;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  /** 首次启动导入档案时附带的额外请求体（JSON），例如 {"thinking":{"type":"disabled"}} */
  llmExtraBody: string;
  /** 加密存储厂商 API Key 的密钥；未设置时由 jwtSecret 派生 */
  settingsEncryptionKey: string;
  ttsApiKey: string;
  ttsResourceId: string;
  ttsSpeaker: string;
  ttsSpeakerMale: string;
  asrResourceId: string;
}

export function loadEnv(overrides: Partial<ApiEnv> = {}): ApiEnv {
  const corsRaw = process.env.CORS_ORIGINS?.trim();
  const production = process.env.NODE_ENV === "production";
  return {
    databaseUrl:
      process.env.DATABASE_URL ??
      "postgres://cecs:cecs_dev_2026@127.0.0.1:5434/cecs",
    jwtSecret: process.env.JWT_SECRET ?? "cecs-dev-secret-change-in-production",
    accessTokenTtlSeconds: Number(process.env.ACCESS_TOKEN_TTL ?? 900),
    refreshTokenTtlSeconds: Number(process.env.REFRESH_TOKEN_TTL ?? 14 * 24 * 3600),
    adminInitialPassword: process.env.ADMIN_INITIAL_PASSWORD ?? "Admin#2026",
    corsOrigins: corsRaw ? corsRaw.split(",").map((item) => item.trim()) : !production,
    desktopOnly: process.env.DESKTOP_ONLY ? process.env.DESKTOP_ONLY === "true" : production,
    trustProxy: process.env.TRUST_PROXY === "true",
    port: Number(process.env.PORT ?? 8787),
    llmBaseUrl: (process.env.LLM_BASE_URL ?? "").replace(/\/+$/, ""),
    llmApiKey: process.env.LLM_API_KEY ?? "",
    llmModel: process.env.LLM_MODEL ?? "",
    llmExtraBody: process.env.LLM_EXTRA_BODY ?? "",
    settingsEncryptionKey: process.env.SETTINGS_ENCRYPTION_KEY ?? "",
    ttsApiKey: process.env.TTS_API_KEY ?? "",
    ttsResourceId: process.env.TTS_RESOURCE_ID ?? "seed-tts-2.0",
    ttsSpeaker: process.env.TTS_SPEAKER ?? "zh_female_vv_uranus_bigtts",
    ttsSpeakerMale: process.env.TTS_SPEAKER_MALE ?? "zh_male_dayi_uranus_bigtts",
    asrResourceId: process.env.ASR_RESOURCE_ID ?? "volc.seedasr.sauc.duration",
    ...overrides,
  };
}
