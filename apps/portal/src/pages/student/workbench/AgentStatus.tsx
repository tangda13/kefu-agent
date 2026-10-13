import { Check, ChevronDown, Minus, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PRACTICE_TOTALS } from "../practice";

/* 客服状态（参照千牛 / 飞鸽）：状态标签，点开切换在线 / 小休 / 离线，设置最大接待人数。
   在线：正常进线；小休：可接待当前买家，不再进线新买家；离线：不进线，也不能发送消息。 */

export type AgentState = "online" | "rest" | "offline";

const STATES: Array<{ id: AgentState; label: string; desc: string }> = [
  { id: "online", label: "在线", desc: "可接待买家" },
  { id: "rest", label: "小休", desc: "可接待当前买家，无法接待新买家" },
  { id: "offline", label: "离线", desc: "无法接收和发送消息" },
];

export const MAX_SERVE_LIMIT = 5;

export function AgentStatus({ state, onState, maxServe, onMaxServe, canSetMax, total, onTotal }: {
  /** 接待人数只在自由练习时可设；任务里按老师的进线规则，同时最多 3 位 */
  canSetMax: boolean;
  /** 最大接待人数：这一轮累计进线上限，0 = 不限 */
  total: number;
  onTotal: (next: number) => void;
  state: AgentState;
  onState: (next: AgentState) => void;
  maxServe: number;
  onMaxServe: (next: number) => void;
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
  const current = STATES.find((item) => item.id === state)!;

  return (
    <div className="wbk-agent" ref={ref}>
      <button type="button" className={`wbk-agent-btn is-${state}`} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="wbk-agent-state">{current.label}<ChevronDown size={12} /></span>
      </button>
      {open ? (
        <div className="wbk-pop wbk-agent-pop" role="dialog" aria-label="客服状态">
          <div className="wbk-agent-sec">
            <span className="t">切换状态</span>
            {STATES.map((item) => (
              <button key={item.id} type="button" className={item.id === state ? "is-on" : ""} onClick={() => { onState(item.id); setOpen(false); }}>
                <i className={`dot is-${item.id}`} />
                <b>{item.label}</b>
                <span>{item.desc}</span>
                {item.id === state ? <Check size={15} /> : null}
              </button>
            ))}
          </div>
          {canSetMax ? (
          <div className="wbk-agent-max">
            <span>同时接待人数</span>
            <span className="stepper">
              <button type="button" aria-label="减少" disabled={maxServe <= 1} onClick={() => onMaxServe(maxServe - 1)}><Minus size={13} /></button>
              <b className="num">{maxServe}</b>
              <button type="button" aria-label="增加" disabled={maxServe >= MAX_SERVE_LIMIT} onClick={() => onMaxServe(maxServe + 1)}><Plus size={13} /></button>
            </span>
          </div>
          ) : null}
          {canSetMax ? (
          <div className="wbk-agent-max">
            <span>最大接待人数</span>
            <span className="wbk-agent-seg">
              {PRACTICE_TOTALS.map((value) => (
                <button key={value} type="button" className={value === total ? "is-on" : ""} onClick={() => onTotal(value)}>{value === 0 ? "不限" : value}</button>
              ))}
            </span>
          </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
