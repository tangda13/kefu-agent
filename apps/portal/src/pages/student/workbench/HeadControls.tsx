import { MessageSquareX, Star } from "lucide-react";
import { Tip } from "../../../ui";

/* 会话头右侧：待跟进星标、结束会话，只放图标，鼠标移上去看含义。咨询类型已去掉（D-68：真实工作台的会话头不会让客服先选咨询类型） */

export function FollowUpToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <Tip label={on ? "已标记待跟进，点击取消" : "标记为待跟进"}>
      <button type="button" className={on ? "wbk-hbtn wbk-fup is-on" : "wbk-hbtn wbk-fup"} aria-label="待跟进" aria-pressed={on} onClick={onToggle}>
        <Star size={17} />
      </button>
    </Tip>
  );
}

export function EndButton({ onClick }: { onClick: () => void }) {
  return (
    <Tip label="结束会话">
      <button type="button" className="wbk-hbtn wbk-end-btn" aria-label="结束会话" onClick={onClick}>
        <MessageSquareX size={17} />
      </button>
    </Tip>
  );
}
