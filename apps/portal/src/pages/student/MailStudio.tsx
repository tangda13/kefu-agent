import { AlertTriangle, CheckCircle2, ChevronRight, FileText, MailCheck, RotateCcw, Send, ShieldCheck, Sparkles, SpellCheck2 } from "lucide-react";
import { useMemo, useState } from "react";
import { emailTemplates, forbiddenTerms } from "@cecs/domain";
import { PageHeader } from "../../components/AppShell";

const templateBodies: Record<string, string> = {
  "MAIL-001": "Dear Jessica,\n\nWe’re excited to introduce our new Wireless Earbuds Pro, designed for clear calls and comfortable daily use.\n\nKey features include advanced noise cancellation, a 30-hour battery life, and IPX5 water resistance. For a limited time, you can receive 15% off your first order.\n\nWould you like the full specification sheet?\n\nBest regards,\nABC Store Team",
  "MAIL-002": "Dear Purchasing Team,\n\nI’m reaching out to introduce a reliable supply option for your upcoming product range. We support sample evaluation, clear lead times, and order-status updates.\n\nCould you share the specifications and expected quantity you are considering?\n\nBest regards,\nABC Store Team",
  "MAIL-003": "Dear Customer,\n\nWarm wishes for the holiday season. Thank you for your continued support. We have prepared a small returning-customer offer based on your communication preferences.\n\nBest regards,\nABC Store Team",
  "MAIL-004": "Dear Customer,\n\nBased on your previous order, we thought you may be interested in our latest product update. If your needs have changed, please let us know and we can recommend a more suitable option.\n\nBest regards,\nABC Store Team",
};

export function MailStudio() {
  const [templateId, setTemplateId] = useState<string>(emailTemplates[0]!.id);
  const [subject, setSubject] = useState<string>(emailTemplates[0]!.subject);
  const [body, setBody] = useState(templateBodies[emailTemplates[0]!.id] ?? "");
  const detections = useMemo(() => forbiddenTerms.filter((term) => body.toLowerCase().includes(term.toLowerCase())), [body]);
  const selected = emailTemplates.find((item) => item.id === templateId) ?? emailTemplates[0]!;

  function choose(id: string) {
    const template = emailTemplates.find((item) => item.id === id)!;
    setTemplateId(id);
    setSubject(template.subject);
    setBody(templateBodies[id] ?? "");
  }

  return <div className="page mail-page"><PageHeader eyebrow="EMAIL PRACTICE" title="英文邮件撰写" description="从模板开始，练习清晰、合规且有行动引导的商务邮件。" actions={<button className="secondary-button"><RotateCcw size={16} /> 重置本次练习</button>} />
    <div className="mail-layout"><aside className="panel template-panel"><div className="panel-heading compact-heading"><div><h2>邮件模板</h2><p>{emailTemplates.length} 个内置模板</p></div></div>{emailTemplates.map((template) => <button key={template.id} className={template.id === templateId ? "template-item active" : "template-item"} onClick={() => choose(template.id)}><span className="template-icon"><FileText size={18} /></span><span><strong>{template.name}</strong><small>{template.purpose}</small></span><ChevronRight size={16} /></button>)}<div className="template-tip"><Sparkles size={18} /><p><strong>本次训练重点</strong>避免绝对化表达，邮件结尾给出明确下一步。</p></div></aside>
      <section className="panel editor-panel"><div className="mail-fields"><label>收件人<input defaultValue="jessica@example.com" /></label><label>主题<input value={subject} onChange={(event) => setSubject(event.target.value)} /></label></div><div className="format-bar"><select aria-label="段落样式"><option>正文</option><option>标题</option></select><button aria-label="粗体"><strong>B</strong></button><button aria-label="斜体"><em>I</em></button><button aria-label="下划线"><u>U</u></button><span /><small>{selected.name}</small></div><textarea aria-label="邮件正文" className="mail-editor" value={body} onChange={(event) => setBody(event.target.value)} /><div className="editor-footer"><span>{body.length} / 5000</span><button className="primary-button"><Send size={16} /> 完成并提交</button></div></section>
      <aside className="inspection-panel"><section className={detections.length ? "inspection warning" : "inspection success"}><div><span className="inspection-icon">{detections.length ? <AlertTriangle size={19} /> : <ShieldCheck size={19} />}</span><span><h3>违规词检测</h3><p>{detections.length ? `发现 ${detections.length} 处风险表达` : "未发现风险表达"}</p></span></div>{detections.map((term) => <em key={term}>{term}</em>)}</section><section className="inspection"><div><span className="inspection-icon blue"><SpellCheck2 size={19} /></span><span><h3>语法建议</h3><p>2 条可优化建议</p></span></div><ul><li>“designed for” 后的并列结构保持一致</li><li>CTA 可更直接地说明回复内容</li></ul></section><section className="inspection success"><div><span className="inspection-icon"><CheckCircle2 size={19} /></span><span><h3>合规检测</h3><p>整体表达合规</p></span></div></section><div className="mail-score"><MailCheck size={21} /><div><span>邮件完成度</span><strong>{detections.length ? 78 : 92}<small>/100</small></strong></div><div className="ring" style={{ "--progress": `${detections.length ? 78 : 92}%` } as React.CSSProperties} /></div></aside>
    </div></div>;
}
