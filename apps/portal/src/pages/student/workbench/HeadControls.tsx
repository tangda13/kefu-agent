import { Star } from "lucide-react";
import { Button } from "../../../ui";

/* 会话头右侧：待跟进星标、结束会话。咨询类型已去掉（D-68：真实工作台的会话头不会让客服先选咨询类型） */

export function FollowUpToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button type="button" className={on ? "wbk-fup is-on" : "wbk-fup"} aria-pressed={on} onClick={onToggle}>
      <Star size={15} />待跟进
    </button>
  );
}

export function EndButton({ onClick }: { onClick: () => void }) {
  return <Button size="sm" className="wbk-end-btn" onClick={onClick}>结束会话</Button>;
}
