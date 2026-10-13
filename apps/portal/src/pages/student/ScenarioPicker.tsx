import { Check, ChevronDown, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { BUSINESS_STAGES, BUSINESS_STAGE_LABELS, type BusinessStage } from "@cecs/contracts";
import type { ScenarioSummary } from "../../api/client";

/* 自由练习的场景选择：替换原生下拉（原生的会撑满整屏）。
   向下展开、限高滚动，“全部随机”时按业务环节分组，场景多时可搜索。 */

const STAGE_CAT: Record<BusinessStage, number> = { in_sale: 1, pre_sale: 2, after_sale: 3, customer_care: 4 };

export function ScenarioPicker({ scenarios, stage, value, onChange }: {
  scenarios: ScenarioSummary[];
  stage: BusinessStage | "random";
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  useEffect(() => { if (!open) setQuery(""); }, [open]);

  const pool = stage === "random" ? scenarios : scenarios.filter((item) => item.stage === stage);
  const keyword = query.trim().toLowerCase();
  const shown = keyword ? pool.filter((item) => item.name.toLowerCase().includes(keyword)) : pool;
  const randomLabel = stage === "random" ? "全部随机" : "本环节随机";
  const current = pool.find((item) => item.id === value);
  const pick = (id: string) => { onChange(id); setOpen(false); };
  const groups = stage === "random"
    ? BUSINESS_STAGES.map((key) => ({ key, items: shown.filter((item) => item.stage === key) })).filter((group) => group.items.length)
    : [{ key: stage, items: shown }];

  return (
    <div className="spk" ref={ref}>
      <button type="button" className="spk-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span>场景：{current ? current.name : randomLabel}</span>
        <ChevronDown size={14} />
      </button>
      {open ? (
        <div className="spk-pop" role="listbox" aria-label="练习场景">
          {pool.length > 8 ? (
            <label className="spk-search"><Search size={13} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索场景" /></label>
          ) : null}
          <div className="spk-list">
            {!keyword ? (
              <button type="button" role="option" aria-selected={!value} className={!value ? "is-on" : ""} onClick={() => pick("")}>
                {randomLabel}{!value ? <Check size={14} /> : null}
              </button>
            ) : null}
            {groups.map((group) => (
              <div key={group.key}>
                {stage === "random" ? <div className="spk-g"><i style={{ background: `var(--c-cat-${STAGE_CAT[group.key as BusinessStage]})` }} />{BUSINESS_STAGE_LABELS[group.key as BusinessStage]}</div> : null}
                {group.items.map((item) => (
                  <button key={item.id} type="button" role="option" aria-selected={item.id === value} className={item.id === value ? "is-on" : ""} onClick={() => pick(item.id)}>
                    {item.name}{item.id === value ? <Check size={14} /> : null}
                  </button>
                ))}
              </div>
            ))}
            {keyword && shown.length === 0 ? <p className="spk-none">没有找到场景</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
