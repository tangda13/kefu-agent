import { ChevronDown, CircleAlert, FileText, Headphones, Languages, Mic, MoreHorizontal, Package2, Paperclip, Send, ShieldCheck, Sparkles, Volume2 } from "lucide-react";
import { useMemo, useState } from "react";
import { buyers, initialMessages } from "../../data/demo";

type MessageMap = typeof initialMessages;

export function Workbench() {
  const [activeBuyerId, setActiveBuyerId] = useState("BUY-001");
  const [messages, setMessages] = useState<MessageMap>(initialMessages);
  const [input, setInput] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const buyer = buyers.find((item) => item.id === activeBuyerId) ?? buyers[0]!;
  const conversation = messages[activeBuyerId] ?? [];
  const turnCount = useMemo(() => conversation.filter((item) => item.side === "student").length, [conversation]);

  function send() {
    const text = input.trim();
    if (!text) return;
    setMessages((current) => ({
      ...current,
      [activeBuyerId]: [...(current[activeBuyerId] ?? []), { id: `local-${Date.now()}`, side: "student", text, time: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) }],
    }));
    setInput("");
    setNotice("消息已加入会话。当前里程碑未配置 LLM Provider，因此不会用固定话术伪造买家回复。");
    window.setTimeout(() => setNotice(null), 5000);
  }

  return (
    <div className="workbench-page">
      <header className="workbench-header">
        <div><span className="eyebrow">ACTIVE TRAINING</span><h1>客服工作台</h1></div>
        <div className="session-stat"><span>新品咨询实训</span><strong>第 {Math.max(turnCount + 1, 3)} / 20 轮</strong><i><b style={{ width: `${Math.min(100, ((turnCount + 1) / 20) * 100)}%` }} /></i></div>
        <button className="secondary-button compact"><FileText size={16} /> 任务说明</button>
      </header>
      <div className="workbench-grid">
        <aside className="conversation-rail">
          <div className="rail-head"><div><h2>买家会话</h2><span>{buyers.filter((item) => item.status === "在线").length} 位在线</span></div><button className="icon-button"><MoreHorizontal size={19} /></button></div>
          <div className="rail-filter"><button className="active">全部</button><button>待回复 <span>3</span></button><button>已标记</button></div>
          <div className="buyer-list">{buyers.map((item) => <button key={item.id} className={item.id === activeBuyerId ? "buyer-card active" : "buyer-card"} onClick={() => setActiveBuyerId(item.id)}>
            <span className="photo-avatar"><img src={item.avatar} alt={`${item.name} 买家头像`} /><i className={item.status === "在线" ? "online" : ""} /></span>
            <span className="buyer-meta"><span><strong>{item.name}</strong><small>{item.flag}</small></span><em>{item.tag}</em><p>{initialMessages[item.id]?.at(-1)?.text ?? "暂无消息"}</p></span>
            <span className="buyer-side"><small>{item.status}</small>{item.unread > 0 && <b>{item.unread}</b>}</span>
          </button>)}</div>
          <div className="rail-foot"><ShieldCheck size={16} /><span>画像标签由服务端随机组合<br />学生开始前不可预知</span></div>
        </aside>

        <section className="chat-stage">
          <div className="chat-head">
            <div className="chat-identity"><span className="photo-avatar"><img src={buyer.avatar} alt="" /><i className="online" /></span><span><strong>{buyer.name} <small>{buyer.flag}</small></strong><p>{buyer.country} · {buyer.status}</p></span></div>
            <div className="chat-tools"><button><Languages size={17} /> EN <ChevronDown size={14} /></button><button aria-label="播报买家消息"><Volume2 size={18} /></button><button aria-label="更多"><MoreHorizontal size={19} /></button></div>
          </div>
          <div className="scenario-strip"><Sparkles size={16} /><span><strong>当前目标</strong> 识别购买顾虑，并使用合规英文说明库存、物流和质保。</span></div>
          <div className="message-list">
            <div className="time-divider"><span>今天</span></div>
            {conversation.map((message) => <div key={message.id} className={`message ${message.side}`}>
              {message.side === "buyer" && <span className="photo-avatar tiny"><img src={buyer.avatar} alt="" /></span>}
              <div><p>{message.text}</p><span>{message.time}{message.side === "buyer" && <button aria-label="播报"><Volume2 size={13} /></button>}</span></div>
            </div>)}
          </div>
          {notice && <div className="provider-notice"><CircleAlert size={17} />{notice}</div>}
          <div className="composer">
            <div className="composer-tools"><button aria-label="附件"><Paperclip size={17} /></button><button aria-label="常用话术"><Sparkles size={17} /></button><span>英语</span><span className="compliance-ok"><ShieldCheck size={14} /> 合规检测开启</span></div>
            <textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); } }} placeholder="输入英文回复，Enter 发送，Shift + Enter 换行…" />
            <div className="composer-actions"><button className="voice-button"><Mic size={18} /> 按住说话</button><span>{input.length} / 1000</span><button className="primary-button compact" onClick={send}>发送 <Send size={16} /></button></div>
          </div>
        </section>

        <aside className="context-panel">
          <div className="context-tabs"><button className="active">买家信息</button><button>会话提示</button></div>
          <section className="buyer-profile"><span className="photo-avatar xl"><img src={buyer.avatar} alt={`${buyer.name} 买家头像`} /></span><h2>{buyer.name}</h2><p>{buyer.flag} {buyer.country} · {buyer.tag}</p><div className="profile-tags"><span>英语</span><span>UTC-4</span><span>已购 3 次</span></div></section>
          <section className="context-block"><div className="context-title"><span><Package2 size={17} /> 关联订单</span><button>查看详情</button></div><div className="order-card"><div><span className="product-thumb"><Headphones size={25} /></span><span><strong>{buyer.product}</strong><small>{buyer.order}</small></span></div><div><span>订单金额</span><strong>{buyer.price}</strong></div><div><span>当前状态</span><em>待发货</em></div></div></section>
          <section className="context-block"><div className="context-title"><span><Sparkles size={17} /> 实训提醒</span></div><ul className="hint-list"><li>先确认客户最关注的因素</li><li>避免使用绝对化质保承诺</li><li>在回复中给出下一步行动</li></ul></section>
          <section className="score-glance"><div><span>实时表现</span><strong>86<small>/100</small></strong></div><div className="score-bars"><span><i style={{ width: "92%" }} />合规</span><span><i style={{ width: "84%" }} />专业</span><span><i style={{ width: "78%" }} />共情</span></div></section>
        </aside>
      </div>
    </div>
  );
}

