import { englishLanguageOf, isEnglish } from "@cecs/domain";
import type { VoiceGender } from "./pool";

/**
 * 买家沟通语言（D-43）：买家说国籍的母语（打字和朗读一致）；
 * 朗读做不到这个语种（该语种 × 性别没有已配置厂商的音色，或语音整体未配置）就改用英语（国家口音英语）。
 * 任务规则里老师明确指定了语言时（explicit）尊重老师。
 */
export async function resolveBuyerLanguage(
  voice: { canSpeak(language: string, gender: VoiceGender, nationality?: string): Promise<boolean> },
  persona: { language: string; nationality: string; gender: VoiceGender },
  explicit = false,
): Promise<string> {
  if (explicit || isEnglish(persona.language)) return persona.language;
  return (await voice.canSpeak(persona.language, persona.gender, persona.nationality))
    ? persona.language
    : englishLanguageOf(persona.nationality);
}
