import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

/** 朗读缓存保留天数（D-88）：按生成时间算，过期的删掉，学生再点播报会重新合成 */
export const TTS_CACHE_DAYS = 30;
export const TTS_CACHE_MAX_AGE_MS = TTS_CACHE_DAYS * 24 * 60 * 60 * 1000;

/**
 * 删掉 dir 里生成超过 maxAgeMs 的朗读缓存，返回删了几个。
 * 管理端试听文件（preview-*）数量固定、要即点即听，不删；目录不存在算 0。
 */
export async function pruneTtsCache(dir: string, maxAgeMs: number, now = Date.now()): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let removed = 0;
  for (const name of names) {
    if (name.startsWith("preview-")) continue;
    const file = path.join(dir, name);
    try {
      const info = await stat(file);
      if (!info.isFile() || now - info.mtimeMs <= maxAgeMs) continue;
      await unlink(file);
      removed += 1;
    } catch (error) {
      // 同时被别处删掉了就跳过
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return removed;
}
