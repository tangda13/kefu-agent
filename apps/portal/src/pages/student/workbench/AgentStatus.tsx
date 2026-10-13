import { Check, ChevronDown, Minus, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { UserAvatar } from "../../../components/AccountCenter";

/* 客服状态（参照千牛 / 飞鸽）：头像 + 状态角标，点开切换在线 / 小休 / 离线，设置最大接待人数。
   在线：正常进线；小休：可接待当前买家，不再进线新买家；离线：不进线，也不能发送消息。 */

export type AgentState = "online" | "rest" | "offline";

const STATES: Array<{ id: AgentState; label: string; desc: string }> = [
  { id: "online", label: "在线", desc: "可接待买家" },
  { id: "rest", label: "小休", desc: "可接待当前买家，无法接待新买家" },
  { id: "offline", label: "离线", desc: "无法接收和发送消息" },
];

export const MAX_SERVE_LIMIT = 5;

export function AgentStatus({ name, avatarUrl, storeName, state, onState, maxServe, onMaxServe }: {
  name: string;
  avatarUrl?: string | null;
  storeName: string;
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
        <UserAvatar name={name} url={avatarUrl} size={28} />
        <span className="wbk-agent-state">{current.label}<ChevronDown size={12} /></span>
      </button>
      {open ? (
        <div className="wbk-pop wbk-agent-pop" role="dialog" aria-label="客服状态">
          <div className="wbk-agent-who">
            <UserAvatar name={name} url={avatarUrl} size={44} />
            <div><b>{name}</b><small>{storeName}</small></div>
          </div>
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
          <div className="wbk-agent-max">
            <span>最大接待人数</span>
            <span className="stepper">
              <button type="button" aria-label="减少" disabled={maxServe <= 1} onClick={() => onMaxServe(maxServe - 1)}><Minus size={13} /></button>
              <b className="num">{maxServe}</b>
              <button type="button" aria-label="增加" disabled={maxServe >= MAX_SERVE_LIMIT} onClick={() => onMaxServe(maxServe + 1)}><Plus size={13} /></button>
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
