import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * 模型/语音厂商 API Key 加密存储（AES-256-GCM）。
 * 密钥取 SETTINGS_ENCRYPTION_KEY；未设置时由 JWT_SECRET 派生（开发期可用，生产应单独设置，
 * 否则轮换 JWT_SECRET 会导致已存 Key 无法解密，需要在管理端重新填写）。
 * 存储格式：v1:<iv>:<tag>:<密文>（base64url）。
 */
export interface SecretSealer {
  seal(plain: string): string;
  open(sealed: string): string;
}

export function createSecretSealer(rawKey: string): SecretSealer {
  const key = createHash("sha256").update(`cecs-settings:${rawKey}`).digest();
  return {
    seal(plain) {
      if (!plain) return "";
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(":");
    },
    open(sealed) {
      if (!sealed) return "";
      const [version, iv, tag, data] = sealed.split(":");
      if (version !== "v1" || !iv || !tag || data === undefined) throw new Error("SECRET_FORMAT_INVALID");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
    },
  };
}

/**
 * 管理端显示用的打码值：长密钥露前后各 4 位，短一些的露 2 位，8 位以内全遮；中间固定 4 个星号，不暴露长度。
 * 明文从不回传前端，管理端只拿这个值显示“已设置”。
 */
export function maskSecret(key: string | undefined): string {
  if (!key) return "";
  if (key.length <= 8) return "****";
  const keep = key.length < 20 ? 2 : 4;
  return `${key.slice(0, keep)}****${key.slice(-keep)}`;
}
