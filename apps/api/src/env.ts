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
  corsOrigins: string[] | true;
  port: number;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  ttsApiKey: string;
  ttsResourceId: string;
  ttsSpeaker: string;
  ttsSpeakerMale: string;
  asrResourceId: string;
}

export function loadEnv(overrides: Partial<ApiEnv> = {}): ApiEnv {
  const corsRaw = process.env.CORS_ORIGINS?.trim();
  return {
    databaseUrl:
      process.env.DATABASE_URL ??
      "postgres://cecs:cecs_dev_2026@127.0.0.1:5434/cecs",
    jwtSecret: process.env.JWT_SECRET ?? "cecs-dev-secret-change-in-production",
    accessTokenTtlSeconds: Number(process.env.ACCESS_TOKEN_TTL ?? 900),
    refreshTokenTtlSeconds: Number(process.env.REFRESH_TOKEN_TTL ?? 14 * 24 * 3600),
    adminInitialPassword: process.env.ADMIN_INITIAL_PASSWORD ?? "Admin#2026",
    corsOrigins: corsRaw ? corsRaw.split(",").map((item) => item.trim()) : true,
    port: Number(process.env.PORT ?? 8787),
    llmBaseUrl: (process.env.LLM_BASE_URL ?? "").replace(/\/+$/, ""),
    llmApiKey: process.env.LLM_API_KEY ?? "",
    llmModel: process.env.LLM_MODEL ?? "",
    ttsApiKey: process.env.TTS_API_KEY ?? "",
    ttsResourceId: process.env.TTS_RESOURCE_ID ?? "seed-tts-2.0",
    ttsSpeaker: process.env.TTS_SPEAKER ?? "zh_female_vv_uranus_bigtts",
    ttsSpeakerMale: process.env.TTS_SPEAKER_MALE ?? "zh_male_dayi_uranus_bigtts",
    asrResourceId: process.env.ASR_RESOURCE_ID ?? "volc.seedasr.sauc.duration",
    ...overrides,
  };
}
