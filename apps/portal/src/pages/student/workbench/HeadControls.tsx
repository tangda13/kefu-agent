import { ChevronDown, Star } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CONTACT_REASONS, type ConversationSummary } from "../../../api/client";
import { Button } from "../../../ui";

/* 会话头右侧：咨询类型（客服自己选，同千牛“服务小记”）、待跟进星标、结束接待 */

export function ReasonPicker({ conversation, disabled, onPick }: {
  conversation: ConversationSummary;
  disabled: boolean;
  onPick: (reason: string) => void;
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

  const shown = conversation.contactReason ?? null;

  if (disabled) {
    return (
      <span className="wbk-reason is-static">
        咨询类型<b>{shown ?? "未选择"}</b>
      </span>
    );
  }
  return (
    <div className="wbk-reason-wrap" ref={ref}>
      <button type="button" className={shown ? "wbk-reason" : "wbk-reason is-empty"} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        咨询类型
        <b>{shown ?? "请选择"}</b>
        <ChevronDown size={14} />
      </button>
      {open ? (
        <div className="wbk-pop wbk-reason-pop" role="listbox" aria-label="咨询类型">
          <div className="wbk-reason-grid">
            {CONTACT_REASONS.map((reason) => (
              <button key={reason} type="button" role="option" aria-selected={reason === shown} className={reason === shown ? "is-on" : ""} onClick={() => { setOpen(false); onPick(reason); }}>
                {reason}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function FollowUpToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button type="button" className={on ? "wbk-fup is-on" : "wbk-fup"} aria-pressed={on} onClick={onToggle}>
      <Star size={15} />待跟进
    </button>
  );
}

export function EndButton({ onClick }: { onClick: () => void }) {
  return <Button size="sm" className="wbk-end-btn" onClick={onClick}>结束接待</Button>;
}
