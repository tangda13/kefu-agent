import { ChevronDown, Languages, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/* 输入框翻译：把客服写好的（多为中文）一键译成买家的语言，译文直接替换输入框内容；
   目标语言默认取买家的语言，可切换。 */

export const OUTGOING_LANGUAGES: Array<{ id: string; label: string }> = [
  { id: "en", label: "英" },
  { id: "es", label: "西" },
  { id: "fr", label: "法" },
  { id: "de", label: "德" },
  { id: "it", label: "意" },
  { id: "pt", label: "葡" },
  { id: "ru", label: "俄" },
  { id: "ja", label: "日" },
  { id: "ko", label: "韩" },
  { id: "ar", label: "阿" },
];
const FULL_NAMES: Record<string, string> = {
  en: "英语", es: "西班牙语", fr: "法语", de: "德语", it: "意大利语", pt: "葡萄牙语", ru: "俄语", ja: "日语", ko: "韩语", ar: "阿拉伯语",
};

/** 买家语言（如 en-US、es-ES）→ 目标语言代码，不认识的按英语 */
export function targetOf(language: string | undefined | null): string {
  const code = (language ?? "en").slice(0, 2).toLowerCase();
  return OUTGOING_LANGUAGES.some((item) => item.id === code) ? code : "en";
}

export function TranslateButton({ target, onTarget, busy, disabled, onTranslate }: {
  target: string;
  onTarget: (next: string) => void;
  busy: boolean;
  disabled: boolean;
  onTranslate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const label = OUTGOING_LANGUAGES.find((item) => item.id === target)?.label ?? "英";

  return (
    <div className="wbk-intr" ref={ref}>
      <button type="button" className="wbk-intr-main" disabled={disabled || busy} onClick={onTranslate} title={`把输入框里的内容译成${FULL_NAMES[target] ?? "英语"}`}>
        {busy ? <LoaderCircle size={15} className="wbk-spin" /> : <Languages size={15} />}
        翻译 中→{label}
      </button>
      <button type="button" className="wbk-intr-pick" aria-label="切换目标语言" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <ChevronDown size={13} />
      </button>
      {open ? (
        <div className="wbk-pop wbk-intr-pop" role="listbox" aria-label="目标语言">
          {OUTGOING_LANGUAGES.map((item) => (
            <button key={item.id} type="button" role="option" aria-selected={item.id === target} className={item.id === target ? "is-on" : ""} onClick={() => { onTarget(item.id); setOpen(false); }}>
              中→{item.label}<span>{FULL_NAMES[item.id]}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
