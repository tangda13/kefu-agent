import { ChevronDown, Languages, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Tip } from "../../../ui";

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

export function TranslateButton({ target, buyerTarget, onTarget, busy, disabled, empty, onTranslate }: {
  target: string;
  /** 买家的语言，在语言列表里标出来 */
  buyerTarget: string;
  onTarget: (next: string) => void;
  busy: boolean;
  disabled: boolean;
  /** 输入框还是空的：按钮照常可点（点了回到输入框），说明换成“写好中文后点这里” */
  empty: boolean;
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
  const full = FULL_NAMES[target] ?? "英语";

  return (
    <div className={open ? "wbk-intr is-open" : "wbk-intr"} ref={ref}>
      <Tip label={open ? null : empty ? `写好中文后点这里，译成${full}` : `把输入框里的内容译成${full}，替换原文`} placement="top">
        <button type="button" className="wbk-intr-main" disabled={disabled || busy} onClick={onTranslate}>
          {busy ? <LoaderCircle size={16} className="wbk-spin" /> : <Languages size={16} />}
          {busy ? "翻译中…" : `译成${full}`}
        </button>
      </Tip>
      <Tip label={open ? null : "换目标语言"} placement="top">
        <button type="button" className="wbk-intr-pick" aria-label="换目标语言" aria-expanded={open} disabled={disabled || busy} onClick={() => setOpen((value) => !value)}>
          <ChevronDown size={14} />
        </button>
      </Tip>
      {open ? (
        <div className="wbk-pop wbk-intr-pop" role="listbox" aria-label="目标语言">
          <h6>译成</h6>
          {OUTGOING_LANGUAGES.map((item) => (
            <button key={item.id} type="button" role="option" aria-selected={item.id === target} className={item.id === target ? "is-on" : ""} onClick={() => { onTarget(item.id); setOpen(false); }}>
              {FULL_NAMES[item.id]}{item.id === buyerTarget ? <span>买家语言</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
