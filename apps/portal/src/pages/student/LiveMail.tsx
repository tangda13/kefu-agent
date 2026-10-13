import {
  Archive,
  ChevronDown,
  ChevronUp,
  FileText,
  PackageSearch,
  PenLine,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { deriveBuyerEmail } from "@cecs/domain";
import { BuyerAvatar } from "../../components/BuyerAvatar";
import { HeaderExtra, TabCount, useBuyerTags, ZhTranslation } from "../../components/StoreHeader";
import {
  ApiError,
  assistMail,
  fetchForbiddenTerms,
  fetchMailReplies,
  fetchMailDrafts,
  fetchReadMarks,
  fetchStoreProfile,
  saveMailDraft,
  deleteMailDraft,
  saveReadMarks,
  migrateLocalOnce,
  type MailDraft,
  fetchMailSubmissions,
  fetchMailTemplates,
  fetchPhrases,
  fetchStudentOrders,
  submitMail,
  type MailReply,
  type MailSubmission,
  type MailTemplate,
  type Session,
  type StoreProfile,
  type StudentOrder,
} from "../../api/client";
import { Button, HeaderTabs, MoreMenu } from "../../ui";
import "../../styles/student-store.css";

type Tab = "inbox" | "pending" | "sent" | "drafts";

/** 店铺客服邮箱的兜底值（店铺资料读不到时使用） */
const DEFAULT_MAILBOX = "support@auroramart.com";

function errorText(cause: unknown): string {
  return cause instanceof ApiError ? cause.message : "无法连接服务器，请稍后重试。";
}

function hashSeed(text: string): number {
  let value = 0;
  for (let index = 0; index < text.length; index += 1) {
    value = (value * 31 + text.charCodeAt(index)) | 0;
  }
  return Math.abs(value);
}

function fmtListTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function fmtFullTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

interface InboundMail {
  id: string;
  orderId: string | null;
  orderNo: string;
  productName: string;
  buyer: StudentOrder["buyer"];
  fromEmail: string;
  subject: string;
  body: string;
  at: string;
}

/** 由订单状态派生买家来信（虚拟收件箱，按订单号稳定） */
function buildInboundMail(order: StudentOrder): InboundMail | null {
  const info = order.detail;
  const seed = hashSeed(`mail:${info.orderNo}`);
  const placedMs = new Date(info.placedAt).getTime();
  const jitterMin = (seed % 50) * 60_000;
  const name = order.buyer.name;
  const sign = `Best regards,\n${name}`;
  let subject = "";
  let body = "";
  let atMs = placedMs;

  const variant = seed % 3;
  if (info.status === "pending_payment") {
    const pool: Array<[string, string]> = [
      [`Question before I complete payment (${info.orderNo})`, `Hi Support team,\n\nI just placed order ${info.orderNo} for the ${info.productName}, but I haven't paid yet. Could you tell me the estimated shipping time to my country, and whether any discount code applies to this order?\n\nI'll complete the payment once I hear back from you.\n\n${sign}`],
      [`Shipping cost question - order ${info.orderNo}`, `Hello,\n\nBefore I pay for order ${info.orderNo} (${info.productName}), I'd like to confirm: is the shipping fee already included in the total? And do you provide a tracking number once it ships?\n\nWaiting for your confirmation.\n\n${sign}`],
      [`Can I change quantity before paying? (${info.orderNo})`, `Hi,\n\nI placed order ${info.orderNo} for the ${info.productName} but I'm considering adding one more piece. Should I cancel and reorder, or can you adjust it on your side? Also, would a larger order qualify for any discount?\n\n${sign}`],
    ];
    [subject, body] = pool[variant]!;
    atMs = placedMs + 45 * 60_000;
  } else if (info.status === "paid") {
    const pool: Array<[string, string]> = [
      [`When will order ${info.orderNo} ship?`, `Hello,\n\nMy payment for order ${info.orderNo} (${info.productName}) went through yesterday, but the status still shows "processing". When can I expect it to be handed to the carrier?\n\nThanks in advance.\n\n${sign}`],
      [`Order ${info.orderNo} - dispatch time?`, `Hi Support team,\n\nJust checking in on order ${info.orderNo}. I paid already and would love to know when the ${info.productName} will leave your warehouse, as I need it for an upcoming occasion.\n\n${sign}`],
      [`Please confirm my payment (${info.orderNo})`, `Hello,\n\nI completed the payment for order ${info.orderNo} but haven't received a shipping confirmation yet. Could you confirm everything is in order and let me know the expected dispatch date?\n\n${sign}`],
    ];
    [subject, body] = pool[variant]!;
    atMs = placedMs + 20 * 3_600_000;
  } else if (info.status === "in_transit") {
    const customsAt = info.logistics?.nodes.find((node) => node.key === "customs")?.at;
    const pool: Array<[string, string]> = [
      [`Package status inquiry - ${info.orderNo}`, `Hi,\n\nThe tracking for my order ${info.orderNo} hasn't updated for a few days and it seems to be stuck at customs. Is there anything wrong with the shipment? I'm a bit worried since I need the ${info.productName} soon.\n\nCould you check and let me know the latest status?\n\n${sign}`],
      [`Where is my parcel? ${info.orderNo}`, `Hello,\n\nIt's been quite a while since order ${info.orderNo} shipped, and the last tracking event is from several days ago. Is this normal for international delivery? Please check with the carrier - I'm getting worried.\n\n${sign}`],
      [`Customs delay? Order ${info.orderNo}`, `Hi Support team,\n\nMy tracking shows the ${info.productName} is in customs clearance. Do I need to do anything on my side, like paying import tax or providing documents? Please advise.\n\n${sign}`],
    ];
    [subject, body] = pool[variant]!;
    atMs = customsAt ? new Date(customsAt).getTime() + 6 * 3_600_000 : placedMs + 10 * 86_400_000;
  } else if (info.status === "delivered" && info.review && info.review.rating <= 3) {
    // 投诉来信与该订单的差评内容保持一致
    subject = `Disappointed with my order ${info.orderNo}`;
    body = `Hello,\n\nI received the ${info.productName}, but I have to complain: ${info.review.content}\n\nI'd like to know how you plan to resolve this - a replacement or a refund would both work for me.\n\n${sign}`;
    atMs = new Date(info.review.at).getTime() - 3 * 3_600_000;
  } else if (info.status === "delivered") {
    const pool: Array<[string, string]> = [
      [`Order ${info.orderNo} received - quick question`, `Hi Support team,\n\nJust letting you know the ${info.productName} arrived safely today. It looks great so far!\n\nOne quick question: what's the recommended way to clean and maintain it so it lasts longer?\n\n${sign}`],
      [`Delivered - how do I register the warranty? (${info.orderNo})`, `Hello,\n\nThe ${info.productName} from order ${info.orderNo} was delivered today in good condition. Is there a warranty I should register, and how long does it last?\n\nThanks!\n\n${sign}`],
      [`Got the package - sizing question (${info.orderNo})`, `Hi,\n\nMy order ${info.orderNo} arrived, thank you. The ${info.productName} is nice, though I'm debating whether I picked the right size/variant. If I ever need to exchange it, what's the process?\n\n${sign}`],
    ];
    [subject, body] = pool[variant]!;
    const deliveredAt = info.logistics?.nodes.find((node) => node.key === "delivery")?.at;
    atMs = deliveredAt ? new Date(deliveredAt).getTime() + 5 * 3_600_000 : placedMs + 20 * 86_400_000;
  } else if (info.status === "completed") {
    const pool: Array<[string, string]> = [
      [`Do you restock the ${info.productName}?`, `Hello,\n\nI bought the ${info.productName} a while ago (order ${info.orderNo}) and I've been really happy with it. I'd like to order another one as a gift - will it be restocked soon, and is there any offer for returning customers?\n\n${sign}`],
      [`Repurchase question - ${info.productName}`, `Hi Support team,\n\nMy previous order ${info.orderNo} worked out great. Do you have any newer model or color of the ${info.productName}? I'd also appreciate a coupon for a returning customer if available.\n\n${sign}`],
      [`Recommendation for my next order?`, `Hello,\n\nI've been enjoying the ${info.productName} from order ${info.orderNo}. Based on that purchase, is there anything similar in your store you'd recommend? I'm planning another order this month.\n\n${sign}`],
    ];
    [subject, body] = pool[variant]!;
    atMs = info.review ? new Date(info.review.at).getTime() + 26 * 3_600_000 : placedMs + 50 * 86_400_000;
  } else {
    return null;
  }
  return {
    id: `in-${order.id}`,
    orderId: order.id,
    orderNo: info.orderNo,
    productName: info.productName,
    buyer: order.buyer,
    fromEmail: deriveBuyerEmail(name, info.orderNo),
    subject,
    body,
    at: new Date(atMs + jitterMin).toISOString(),
  };
}

/** 草稿与已读状态都存云端（K2/K3），换机器登录可接着写 */
type DraftMail = MailDraft;

interface ComposeState {
  draftId: string | null;
  to: string;
  subject: string;
  body: string;
  templateId: string | null;
  /** 关联订单：回信时来自来信，主动写信时按收件人邮箱反查（买家 AI 回信依赖它定位人设） */
  orderId: string | null;
}

interface AssistVersion {
  subject: string | null;
  body: string;
}

/** 行内回复的内容（按来信 id 暂存） */
interface InlineReply {
  body: string;
  templateId: string | null;
  dirty: boolean;
}

/** 回复主题：已带 Re: 的不重复加 */
function replySubject(subject: string): string {
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

/** 来信时间：今天只写时分 */
function fmtFromTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? `今天 ${hm}` : `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${hm}`;
}

/** 回复框的编辑区：标题栏（模板 / AI 辅助）、AI 三版、正文、违规词、底栏（存草稿 / 发送） */
interface EditorProps {
  title: ReactNode;
  body: string;
  placeholder: string;
  onBody: (value: string) => void;
  templates: MailTemplate[];
  templateId: string | null;
  onTemplate: (template: MailTemplate) => void;
  assist: "closed" | "loading" | "open";
  assistVersions: AssistVersion[];
  onAssist: () => void;
  onCloseAssist: () => void;
  onPickVersion: (version: AssistVersion) => void;
  violations: string[];
  phrases: string[];
  onPhrase: (phrase: string) => void;
  note: ReactNode;
  busy: boolean;
  onSaveDraft: () => void;
  onSend: () => void;
  onDiscard?: () => void;
  flush?: boolean;
  /** 固定在阅读区底部的回复区（不套框，只有输入框有边框） */
  dock?: boolean;
}

function MailEditor(props: EditorProps) {
  const [showTpl, setShowTpl] = useState(false);
  /** 选中一版后草稿列表自动收起成一行，可再展开换版本；新一批草稿到了自动展开 */
  const [folded, setFolded] = useState(false);
  const { assist, assistVersions, violations } = props;
  useEffect(() => { setFolded(false); }, [assistVersions]);
  const pickedIndex = assistVersions.findIndex((version) => props.body.startsWith(version.body));
  return (
    <div className={props.dock ? "ml2-reply is-dock" : "ml2-reply"} style={props.flush ? { margin: 0 } : undefined}>
      <div className="h">
        {props.title}
        <div className="r">
          <Button size="sm" variant="ghost" icon={FileText} onClick={() => setShowTpl((value) => !value)} aria-expanded={showTpl}>模板</Button>
          <Button size="sm" icon={Sparkles} loading={assist === "loading"} onClick={props.onAssist}>AI 辅助</Button>
        </div>
      </div>
      {showTpl ? (
        <div className="ml2-tpl">
          {props.templates.map((template) => (
            <button
              key={template.id}
              type="button"
              className={props.templateId === template.id ? "ml2-chip is-on" : "ml2-chip"}
              title={template.purpose}
              onClick={() => { props.onTemplate(template); setShowTpl(false); }}
            >
              {template.name}
            </button>
          ))}
        </div>
      ) : null}
      {assist !== "closed" ? (
        <div className="ml2-assist">
          <div className="hd">
            <Sparkles size={13} />
            {assist === "loading"
              ? "AI 正在结合买家资料与邮件内容写三版草稿…"
              : folded
                ? <>AI 草稿 {assistVersions.length} 版{pickedIndex >= 0 ? <span className="hd-cur">· 已填入版本 {pickedIndex + 1}</span> : null}</>
                : "选一版填入下方，可再修改"}
            {assist === "open" ? (
              <span className="r">
                <button type="button" className="sx-link" disabled={props.busy} onClick={props.onAssist}><RefreshCw size={12} />重新生成</button>
                <button type="button" className="sx-link" onClick={() => setFolded((value) => !value)} aria-expanded={!folded}>
                  {folded ? <><ChevronDown size={12} />展开</> : <><ChevronUp size={12} />收起</>}
                </button>
              </span>
            ) : null}
          </div>
          {assist === "open" && !folded ? (
            <div className="vs">
              {assistVersions.map((version, index) => (
                <button
                  key={index}
                  type="button"
                  className={props.body.startsWith(version.body) ? "v is-on" : "v"}
                  title={version.body}
                  onClick={() => { props.onPickVersion(version); setFolded(true); }}
                >
                  <em>版本 {index + 1}</em>
                  {version.subject ? <strong>{version.subject}</strong> : null}
                  {/* 预览把换行合并成空格：草稿都以“Hi xx,”加空行开头，按原样只能看到称呼 */}
                  <p>{version.body.replace(/\s+/g, " ").trim()}</p>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="ml2-box">
      <textarea
        value={props.body}
        onChange={(event) => props.onBody(event.target.value)}
        placeholder={props.placeholder}
        aria-label="邮件正文"
      />
      {violations.length > 0 ? (
        <div className="ml2-viol">
          <ShieldAlert size={13} />检测到违规宣传用语，请换成客观描述：
          {violations.map((term) => <span key={term} className="chip">{term}</span>)}
          {props.phrases.slice(0, 3).map((phrase) => (
            <button key={phrase} type="button" title="插入正文" onClick={() => props.onPhrase(phrase)}>{phrase.length > 28 ? `${phrase.slice(0, 28)}…` : phrase}</button>
          ))}
        </div>
      ) : null}
      <div className="bt">
        <span>{props.note}</span>
        {violations.length === 0 && props.body.trim() ? <span className="sx-ok-line"><ShieldCheck size={13} />没有违规用语</span> : null}
        <div className="r">
          {props.onDiscard ? <Button size="sm" variant="ghost" icon={Trash2} disabled={props.busy} onClick={props.onDiscard}>丢弃</Button> : null}
          <Button size="sm" variant="ghost" icon={Archive} disabled={props.busy || !props.body.trim()} onClick={props.onSaveDraft}>存草稿</Button>
          <Button size="sm" variant="primary" icon={Send} loading={props.busy} disabled={!props.body.trim()} onClick={props.onSend}>发送</Button>
        </div>
      </div>
      </div>
    </div>
  );
}

export function LiveMail({
  session,
  onOpenOrder,
}: {
  session: Session;
  onOpenOrder?: (orderId: string) => void;
}) {
  const [orders, setOrders] = useState<StudentOrder[]>([]);
  const [templates, setTemplates] = useState<MailTemplate[]>([]);
  const [terms, setTerms] = useState<string[]>([]);
  const [phrases, setPhrases] = useState<string[]>([]);
  const [sent, setSent] = useState<MailSubmission[]>([]);
  const [buyerReplies, setBuyerReplies] = useState<MailReply[]>([]);
  const [store, setStore] = useState<StoreProfile | null>(null);
  const [assist, setAssist] = useState<"closed" | "loading" | "open">("closed");
  const [assistVersions, setAssistVersions] = useState<AssistVersion[]>([]);
  const [tab, setTab] = useState<Tab>("inbox");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [compose, setCompose] = useState<ComposeState | null>(null);
  const [inline, setInline] = useState<Record<string, InlineReply>>({});
  const [readIds, setReadIds] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<DraftMail[]>([]);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [savedNote, setSavedNote] = useState("");
  const buyerTags = useBuyerTags(session);

  const mailbox = store?.supportEmail || DEFAULT_MAILBOX;
  const signature = store?.signature?.trim() ?? "";

  const load = useCallback(async () => {
    try {
      fetchStoreProfile(session).then(setStore).catch(() => undefined);
      // 旧版本存在本机的已读/草稿一次性迁到云端
      await Promise.all([
        migrateLocalOnce<string[]>(`cecs.mailRead.${session.user.id}`, (ids) =>
          saveReadMarks(session, "mail", ids.slice(-500)),
        ),
        migrateLocalOnce<DraftMail[]>(`cecs.mailDrafts.${session.user.id}`, async (list) => {
          for (const draft of list.slice(0, 50)) await saveMailDraft(session, draft);
        }),
      ]);
      const [readList, draftList] = await Promise.all([
        fetchReadMarks(session, "mail"),
        fetchMailDrafts(session),
      ]);
      setReadIds(new Set(readList));
      setDrafts(draftList);
      const [orderList, templateList, termList, phraseList, sentList, replyList] = await Promise.all([
        fetchStudentOrders(session),
        fetchMailTemplates(session),
        fetchForbiddenTerms(session),
        fetchPhrases(session),
        fetchMailSubmissions(session),
        fetchMailReplies(session),
      ]);
      setOrders(orderList);
      setTemplates(templateList);
      setTerms(termList);
      setPhrases(phraseList);
      setSent(sentList);
      setBuyerReplies(replyList);
    } catch (cause) {
      setError(errorText(cause));
    }
  }, [session]);

  useEffect(() => { void load(); }, [load]);

  // 买家 AI 回信轮询：30 秒拉一次，新回信自动进收件箱并计入未读
  useEffect(() => {
    const timer = window.setInterval(() => {
      fetchMailReplies(session).then(setBuyerReplies).catch(() => undefined);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [session]);

  const inbox = useMemo(() => {
    const seedMails = orders.map(buildInboundMail).filter((mail): mail is InboundMail => mail !== null);
    const replyMails = buyerReplies.map((reply): InboundMail => {
      const order = orders.find((item) => item.id === reply.orderId);
      return {
        id: `db-${reply.id}`,
        orderId: order?.id ?? null,
        orderNo: order?.detail.orderNo ?? "",
        productName: order?.detail.productName ?? "",
        buyer: order?.buyer ?? {
          id: "",
          name: reply.fromName,
          nationality: "",
          identity: "",
          language: "",
          customerType: "",
          avatarUrl: null,
        },
        fromEmail: reply.fromEmail,
        subject: reply.subject,
        body: reply.body,
        at: reply.createdAt,
      };
    });
    const mails = [...seedMails, ...replyMails];
    mails.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    return mails;
  }, [orders, buyerReplies]);

  /** 一封来信是否已回复：之后给同一邮箱发过主题相同（或带该订单号）的邮件 */
  const isReplied = useCallback(
    (mail: InboundMail) => {
      const base = mail.subject.replace(/^re:\s*/i, "").toLowerCase();
      return sent.some((item) => {
        if (item.recipient?.toLowerCase() !== mail.fromEmail.toLowerCase()) return false;
        if (new Date(item.createdAt).getTime() < new Date(mail.at).getTime()) return false;
        const subject = item.subject.toLowerCase();
        return subject.includes(base) || (mail.orderNo !== "" && subject.includes(mail.orderNo.toLowerCase()));
      });
    },
    [sent],
  );

  const pendingMails = useMemo(() => inbox.filter((mail) => !isReplied(mail)), [inbox, isReplied]);
  const unreadCount = inbox.filter((mail) => !readIds.has(mail.id)).length;

  const keyword = query.trim().toLowerCase();
  const listInbox = useMemo(() => {
    const base = tab === "pending" ? pendingMails : inbox;
    return keyword
      ? base.filter((mail) => [mail.subject, mail.buyer.name, mail.body, mail.orderNo].some((field) => field.toLowerCase().includes(keyword)))
      : base;
  }, [tab, pendingMails, inbox, keyword]);
  const listSent = keyword
    ? sent.filter((mail) => [mail.subject, mail.recipient ?? "", mail.body].some((field) => field.toLowerCase().includes(keyword)))
    : sent;
  const listDrafts = keyword
    ? drafts.filter((draft) => [draft.subject, draft.to, draft.body].some((field) => field.toLowerCase().includes(keyword)))
    : drafts;

  /** 默认打开最新一封未回复的来信，没有未回复的就打开最新一封 */
  const activeInbound = useMemo(() => {
    if (tab !== "inbox" && tab !== "pending") return null;
    return (
      listInbox.find((mail) => mail.id === selectedId) ??
      listInbox.find((mail) => !isReplied(mail)) ??
      listInbox[0] ??
      null
    );
  }, [tab, listInbox, selectedId, isReplied]);
  const activeSent = tab === "sent" ? listSent.find((mail) => mail.id === selectedId) ?? listSent[0] ?? null : null;

  /* ---------------- 读写状态 ---------------- */

  function markRead(id: string) {
    if (readIds.has(id)) return;
    setReadIds((prev) => new Set(prev).add(id));
    void saveReadMarks(session, "mail", [id]).catch(() => undefined);
  }

  function upsertDraft(draft: DraftMail) {
    setDrafts((prev) => [draft, ...prev.filter((item) => item.id !== draft.id)].slice(0, 50));
    void saveMailDraft(session, draft).catch(() => setError("草稿未能保存到云端，请检查网络后再保存一次。"));
  }

  function removeDraft(id: string) {
    setDrafts((prev) => prev.filter((item) => item.id !== id));
    void deleteMailDraft(session, id).catch(() => undefined);
  }

  /* ---------------- 行内回复 ---------------- */

  const draftIdOf = (mail: InboundMail) => `rd-${mail.id}`;

  /** 当前来信的回复内容：本次编辑中的 > 云端草稿 > 空 */
  function replyOf(mail: InboundMail): InlineReply {
    const local = inline[mail.id];
    if (local) return local;
    const draft = drafts.find((item) => item.id === draftIdOf(mail));
    return { body: draft?.body ?? "", templateId: draft?.templateId ?? null, dirty: false };
  }

  function patchReply(mail: InboundMail, patch: Partial<InlineReply>) {
    setInline((prev) => ({ ...prev, [mail.id]: { ...replyOf(mail), ...patch, dirty: true } }));
  }

  /** 草稿自动保存：停手 1.2 秒后写云端；清空正文则删掉草稿 */
  const activeKey = activeInbound?.id ?? null;
  const activeReply = activeInbound ? inline[activeInbound.id] : undefined;
  useEffect(() => {
    if (!activeInbound || !activeReply?.dirty) return undefined;
    const mail = activeInbound;
    const reply = activeReply;
    const timer = window.setTimeout(() => {
      const id = `rd-${mail.id}`;
      if (!reply.body.trim()) {
        removeDraft(id);
      } else {
        upsertDraft({ id, to: mail.fromEmail, subject: replySubject(mail.subject), body: reply.body, templateId: reply.templateId, savedAt: new Date().toISOString() });
        setSavedNote("已自动保存");
      }
      setInline((prev) => (prev[mail.id] ? { ...prev, [mail.id]: { ...prev[mail.id]!, dirty: false } } : prev));
    }, 1200);
    return () => window.clearTimeout(timer);
    // upsertDraft/removeDraft 只依赖 session，不放进依赖里避免每次渲染重置计时
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, activeReply]);

  useEffect(() => { setSavedNote(""); }, [activeKey]);

  /** 套模板：只替换正文，主题仍是“Re: 原主题”；落款用店铺资料里的签名 */
  function bodyFromTemplate(template: MailTemplate, customer: string): string {
    let text = template.body.replace("{customer}", customer);
    if (signature) text = text.replace(/(Best|Warm|Kind) regards,\n\{agent\}/, signature);
    return text.replace("{agent}", session.user.displayName);
  }

  async function sendInline(mail: InboundMail) {
    const reply = replyOf(mail);
    if (!reply.body.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await submitMail(session, {
        templateId: reply.templateId ?? "MAIL-REPLY",
        subject: replySubject(mail.subject),
        body: reply.body.trim(),
        recipient: mail.fromEmail,
        orderId: mail.orderId ?? undefined,
      });
      removeDraft(draftIdOf(mail));
      setInline((prev) => {
        const next = { ...prev };
        delete next[mail.id];
        return next;
      });
      markRead(mail.id);
      setAssist("closed");
      setAssistVersions([]);
      setNotice(
        result.compliant
          ? "邮件已发送。"
          : `邮件已发送，但检测到 ${result.violations.length} 个违规宣传用语，已记录：${result.violations.join("、")}。`,
      );
      setSent(await fetchMailSubmissions(session));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  /* ---------------- 写新邮件 ---------------- */

  function startCompose(preset?: Partial<ComposeState>) {
    setCompose({
      draftId: null,
      to: "",
      subject: "",
      body: "",
      templateId: null,
      orderId: null,
      ...preset,
    });
    setAssist("closed");
    setAssistVersions([]);
    setNotice("");
    setError("");
  }

  function resumeDraft(draft: DraftMail) {
    setCompose({
      draftId: draft.id,
      to: draft.to,
      subject: draft.subject,
      body: draft.body,
      templateId: draft.templateId,
      orderId: null,
    });
    setAssist("closed");
    setAssistVersions([]);
  }

  /** 关联订单：优先取上下文，其次按收件人邮箱反查买家 */
  function linkedOrderId(state: ComposeState): string | undefined {
    if (state.orderId) return state.orderId;
    const target = state.to.trim().toLowerCase();
    if (!target) return undefined;
    return inbox.find((mail) => mail.fromEmail.toLowerCase() === target)?.orderId ?? undefined;
  }

  function saveComposeDraft(silent = false) {
    if (!compose) return;
    if (!compose.to.trim() && !compose.subject.trim() && !compose.body.trim()) return;
    const id = compose.draftId ?? `d${Date.now()}${Math.floor(Math.random() * 1e4)}`;
    upsertDraft({
      id,
      to: compose.to,
      subject: compose.subject,
      body: compose.body,
      templateId: compose.templateId,
      savedAt: new Date().toISOString(),
    });
    if (!silent) {
      setCompose({ ...compose, draftId: id });
      setNotice("草稿已保存。");
    }
  }

  function closeCompose(saveAsDraft: boolean) {
    if (saveAsDraft) saveComposeDraft(true);
    else if (compose?.draftId) removeDraft(compose.draftId);
    setCompose(null);
    setAssist("closed");
    setAssistVersions([]);
  }

  /** 离开写信界面（切页签、选别的邮件）：有内容就自动存成草稿 */
  function leaveCompose() {
    if (compose) closeCompose(true);
  }

  function switchTab(next: Tab) {
    leaveCompose();
    setTab(next);
    setSelectedId(null);
    setQuery("");
    setAssist("closed");
    setAssistVersions([]);
  }

  function pickMail(id: string) {
    leaveCompose();
    setSelectedId(id);
    setAssist("closed");
    setAssistVersions([]);
    markRead(id);
  }

  function pickDraft(draft: DraftMail) {
    // 行内回复存下的草稿回到对应来信，其余的在写信界面里继续编辑
    const mail = inbox.find((item) => draftIdOf(item) === draft.id);
    if (mail) {
      leaveCompose();
      setTab("inbox");
      setSelectedId(mail.id);
      setQuery("");
      return;
    }
    resumeDraft(draft);
  }

  function applyComposeTemplate(template: MailTemplate) {
    if (!compose) return;
    const recipientName =
      inbox.find((mail) => mail.fromEmail.toLowerCase() === compose.to.trim().toLowerCase())?.buyer.name ??
      (compose.to.split("@")[0]?.split(".").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ") || "Customer");
    setCompose({
      ...compose,
      templateId: template.id,
      subject: template.subject,
      body: bodyFromTemplate(template, recipientName),
    });
  }

  /* ---------------- AI 辅助写信 ---------------- */

  async function runAssist(context: { mode: "reply" | "compose"; orderId?: string; templateId?: string; subject?: string; body?: string }) {
    if (busy || assist === "loading") return;
    setError("");
    setAssist("loading");
    try {
      const result = await assistMail(session, {
        mode: context.mode,
        orderId: context.orderId,
        templateId: context.templateId,
        originalSubject: context.subject,
        originalBody: context.body,
      });
      setAssistVersions(result.versions.slice(0, 3));
      setAssist("open");
    } catch (cause) {
      setError(errorText(cause));
      setAssist("closed");
    }
  }

  /** 违规词检测：前端本地扫描，输入即查 */
  const scan = useCallback(
    (text: string) => {
      const haystack = text.toLowerCase();
      return terms.filter((term) => haystack.includes(term.toLowerCase()));
    },
    [terms],
  );
  const composeViolations = useMemo(() => (compose ? scan(`${compose.subject}\n${compose.body}`) : []), [compose, scan]);

  async function sendCompose() {
    if (!compose || busy) return;
    if (!compose.to.trim() || !/.+@.+\..+/.test(compose.to.trim())) {
      setError("请填写有效的收件人邮箱。");
      return;
    }
    if (!compose.subject.trim() || !compose.body.trim()) {
      setError("请填写主题与正文。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await submitMail(session, {
        templateId: compose.templateId ?? "MAIL-CUSTOM",
        subject: compose.subject.trim(),
        body: compose.body.trim(),
        recipient: compose.to.trim(),
        orderId: linkedOrderId(compose),
      });
      if (compose.draftId) removeDraft(compose.draftId);
      setNotice(
        result.compliant
          ? "邮件已发送。"
          : `邮件已发送，但检测到 ${result.violations.length} 个违规宣传用语，已记录：${result.violations.join("、")}。`,
      );
      setCompose(null);
      setAssist("closed");
      setAssistVersions([]);
      setSent(await fetchMailSubmissions(session));
      setTab("sent");
      setSelectedId(result.id);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  /* ---------------- 视图 ---------------- */

  function renderList() {
    return (
      <div className="ml2-list">
        <div className="ml2-lt">
          <label className="sx-search">
            <Search size={14} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索发件人、主题或订单号"
              aria-label="搜索邮件"
            />
          </label>
        </div>
        <div className="ml2-items">
          {tab === "inbox" || tab === "pending" ? (
            <>
              {listInbox.map((mail) => {
                const unread = !readIds.has(mail.id);
                const replied = isReplied(mail);
                return (
                  <button
                    key={mail.id}
                    type="button"
                    className={`ml2-item${unread ? "" : " is-read"}${!compose && activeInbound?.id === mail.id ? " is-on" : ""}`}
                    onClick={() => pickMail(mail.id)}
                  >
                    <span className={unread ? "ml2-dot" : "ml2-dot is-read"} />
                    <span className="sx-av is-34"><BuyerAvatar buyer={mail.buyer} /></span>
                    <span style={{ minWidth: 0 }}>
                      <span className="ml2-l1"><b>{mail.buyer.name}</b><span className="d">{fmtListTime(mail.at)}</span></span>
                      <span className="ml2-sj" style={{ display: "block" }}>{mail.subject}</span>
                      <span className="ml2-pv" style={{ display: "block" }}>{mail.body.replace(/\s+/g, " ")}</span>
                      {mail.orderNo || replied ? (
                        <span className="ml2-l4">
                          {mail.orderNo ? <span className="sx-tag">{mail.orderNo}</span> : null}
                          {replied ? <span className="sx-tag is-ok">已回复</span> : null}
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
              {listInbox.length === 0 ? (
                <div className="sx-empty"><strong>{inbox.length === 0 ? "暂无来信" : tab === "pending" && !keyword ? "来信都回复完了" : "没有匹配的邮件"}</strong></div>
              ) : null}
            </>
          ) : null}
          {tab === "sent" ? (
            <>
              {listSent.map((mail) => (
                <button
                  key={mail.id}
                  type="button"
                  className={!compose && activeSent?.id === mail.id ? "ml2-item is-read is-on" : "ml2-item is-read"}
                  onClick={() => { leaveCompose(); setSelectedId(mail.id); }}
                >
                  <span className="ml2-dot is-read" />
                  <span className="sx-av is-34"><span className="avatar">{(mail.recipient ?? "?").slice(0, 1).toUpperCase()}</span></span>
                  <span style={{ minWidth: 0 }}>
                    <span className="ml2-l1"><b>{mail.recipient ?? "（未填写收件人）"}</b><span className="d">{fmtListTime(mail.createdAt)}</span></span>
                    <span className="ml2-sj" style={{ display: "block" }}>{mail.subject}</span>
                    <span className="ml2-pv" style={{ display: "block" }}>{mail.body.replace(/\s+/g, " ")}</span>
                    {!mail.compliant ? <span className="ml2-l4"><span className="sx-tag is-danger">{mail.violations.length} 个违规词</span></span> : null}
                  </span>
                </button>
              ))}
              {listSent.length === 0 ? <div className="sx-empty"><strong>{sent.length === 0 ? "还没有发送过邮件" : "没有匹配的邮件"}</strong></div> : null}
            </>
          ) : null}
          {tab === "drafts" ? (
            <>
              {listDrafts.map((draft) => (
                <button
                  key={draft.id}
                  type="button"
                  className={compose?.draftId === draft.id ? "ml2-item is-read is-on" : "ml2-item is-read"}
                  onClick={() => pickDraft(draft)}
                >
                  <span className="ml2-dot is-read" />
                  <span className="sx-av is-34"><span className="avatar"><FileText size={15} /></span></span>
                  <span style={{ minWidth: 0 }}>
                    <span className="ml2-l1"><b>{draft.to || "（未填写收件人）"}</b><span className="d">{fmtListTime(draft.savedAt)}</span></span>
                    <span className="ml2-sj" style={{ display: "block" }}>{draft.subject || "（无主题）"}</span>
                    <span className="ml2-pv" style={{ display: "block" }}>{draft.body.replace(/\s+/g, " ") || "（空白正文）"}</span>
                  </span>
                </button>
              ))}
              {listDrafts.length === 0 ? <div className="sx-empty"><strong>{drafts.length === 0 ? "没有草稿" : "没有匹配的草稿"}</strong></div> : null}
            </>
          ) : null}
        </div>
      </div>
    );
  }

  function renderCompose(state: ComposeState) {
    return (
      <div className="ml2-detail">
        <div className="ml2-compose">
          <h3>
            写邮件
            <span className={composeViolations.length === 0 ? "sx-tag is-ok" : "sx-tag is-danger"}>
              {composeViolations.length === 0 ? "合规" : `${composeViolations.length} 个违规词`}
            </span>
          </h3>
          <label className="ml2-field">收件人
            <input
              value={state.to}
              onChange={(event) => setCompose({ ...state, to: event.target.value })}
              placeholder="buyer@example.com"
              list="ml2-buyer-emails"
            />
          </label>
          <datalist id="ml2-buyer-emails">
            {[...new Map(inbox.map((mail) => [mail.fromEmail, mail.buyer.name])).entries()].map(([email, name]) => (
              <option key={email} value={email}>{name}</option>
            ))}
          </datalist>
          <label className="ml2-field">主题
            <input value={state.subject} onChange={(event) => setCompose({ ...state, subject: event.target.value })} />
          </label>
          <MailEditor
            flush
            title={<span>正文</span>}
            body={state.body}
            placeholder="以买家的语言写邮件正文"
            onBody={(value) => setCompose({ ...state, body: value })}
            templates={templates}
            templateId={state.templateId}
            onTemplate={applyComposeTemplate}
            assist={assist}
            assistVersions={assistVersions}
            onAssist={() => void runAssist({ mode: "compose", orderId: linkedOrderId(state), templateId: state.templateId ?? undefined })}
            onCloseAssist={() => setAssist("closed")}
            onPickVersion={(version) => setCompose({ ...state, subject: version.subject ?? state.subject, body: version.body })}
            violations={composeViolations}
            phrases={phrases}
            onPhrase={(phrase) => setCompose({ ...state, body: `${state.body.trimEnd()}\n${phrase}` })}
            note=""
            busy={busy}
            onSaveDraft={() => saveComposeDraft()}
            onSend={() => void sendCompose()}
            onDiscard={() => closeCompose(false)}
          />
        </div>
      </div>
    );
  }

  function renderInbound(mail: InboundMail) {
    const order = orders.find((item) => item.id === mail.orderId);
    const reply = replyOf(mail);
    const tags = buyerTags[mail.buyer.id];
    return (
      <div className="ml2-detail is-read" key={mail.id}>
        <div className="ml2-top">
          <h3>{mail.subject}</h3>
          <div className="ml2-from">
            <span className="sx-av is-44"><BuyerAvatar buyer={mail.buyer} /></span>
            <div>
              <b>{mail.buyer.name}</b> <small>&lt;{mail.fromEmail}&gt;</small>
              {tags?.[0] ? <> <span className="sx-tag">{tags[0]}</span></> : null}
              <br />
              <small>发给 {mailbox} · {fmtFromTime(mail.at)}</small>
            </div>
            <div className="r">
              {order && onOpenOrder ? <Button size="sm" variant="ghost" icon={PackageSearch} onClick={() => onOpenOrder(order.id)}>查看订单</Button> : null}
              <MoreMenu
                items={[
                  { label: "复制发件人邮箱", onClick: () => { void navigator.clipboard?.writeText(mail.fromEmail); setNotice("邮箱已复制。"); } },
                  { label: "写新邮件给 TA", icon: PenLine, onClick: () => startCompose({ to: mail.fromEmail, orderId: mail.orderId }) },
                ]}
              />
            </div>
          </div>
        </div>
        <div className="ml2-body">
          <p className="ml2-text">{mail.body}</p>
          <ZhTranslation session={session} text={mail.body} />
        </div>
        {/* 回复区固定在阅读区底部，正文在上面单独滚动 */}
        <MailEditor
          dock
          title={<span>回复 {mail.buyer.name}</span>}
          body={reply.body}
          placeholder="用英文写回复，点 AI 辅助可以先出三版草稿"
          onBody={(value) => patchReply(mail, { body: value })}
          templates={templates}
          templateId={reply.templateId}
          onTemplate={(template) => patchReply(mail, { templateId: template.id, body: bodyFromTemplate(template, mail.buyer.name) })}
          assist={assist}
          assistVersions={assistVersions}
          onAssist={() => void runAssist({ mode: "reply", orderId: mail.orderId ?? undefined, templateId: reply.templateId ?? undefined, subject: mail.subject, body: mail.body })}
          onCloseAssist={() => setAssist("closed")}
          onPickVersion={(version) => patchReply(mail, { body: version.body })}
          violations={scan(reply.body)}
          phrases={phrases}
          onPhrase={(phrase) => patchReply(mail, { body: `${reply.body.trimEnd()}\n${phrase}` })}
          note={savedNote || "草稿会自动保存"}
          busy={busy}
          onSaveDraft={() => {
            upsertDraft({ id: draftIdOf(mail), to: mail.fromEmail, subject: replySubject(mail.subject), body: reply.body, templateId: reply.templateId, savedAt: new Date().toISOString() });
            setInline((prev) => (prev[mail.id] ? { ...prev, [mail.id]: { ...prev[mail.id]!, dirty: false } } : prev));
            setSavedNote("已保存");
          }}
          onSend={() => void sendInline(mail)}
        />
      </div>
    );
  }

  function renderSent(mail: MailSubmission) {
    const template = templates.find((item) => item.id === mail.templateId);
    return (
      <div className="ml2-detail">
        <div className="ml2-top">
          <h3>{mail.subject}</h3>
          <div className="ml2-from">
            <span className="sx-av is-44"><span className="avatar">{(store?.name ?? "A").slice(0, 1).toUpperCase()}</span></span>
            <div>
              <b>{store?.name ?? "店铺客服"}</b> <small>&lt;{mailbox}&gt;</small>
              <br />
              <small>发给 {mail.recipient ?? "（未填写收件人）"} · {fmtFromTime(mail.createdAt)}{template ? ` · 模板：${template.name}` : ""}</small>
            </div>
            <div className="r">
              {mail.compliant
                ? <span className="sx-tag is-ok">合规</span>
                : <span className="sx-tag is-danger">{mail.violations.length} 个违规词</span>}
            </div>
          </div>
        </div>
        <div className="ml2-body">
          <p className="ml2-text">{mail.body}</p>
          {mail.violations.length > 0 ? (
            <div className="ml2-viol" style={{ borderRadius: 8, border: 0 }}>
              <ShieldAlert size={13} />检出违规宣传用语：
              {mail.violations.map((term) => <span key={term} className="chip">{term}</span>)}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  function renderMain() {
    if (compose) return renderCompose(compose);
    if (activeInbound) return renderInbound(activeInbound);
    if (activeSent) return renderSent(activeSent);
    return <div className="ml2-detail" />;
  }

  return (
    <div className="sx-root">
      <HeaderTabs
        value={tab}
        onChange={switchTab}
        items={[
          { id: "inbox", label: <>收件箱<TabCount n={inbox.length} /></> },
          { id: "pending", label: <>待回复<TabCount n={pendingMails.length} red /></> },
          { id: "sent", label: "已发送" },
          { id: "drafts", label: <>草稿{drafts.length ? <TabCount n={drafts.length} /> : null}</> },
        ]}
      />
      <HeaderExtra>
        <Button variant="primary" size="sm" icon={PenLine} onClick={() => startCompose()}>写邮件</Button>
      </HeaderExtra>
      {notice ? <p className="sx-notice" role="status">{notice}</p> : null}
      {error ? <p className="sx-error" role="alert">{error}</p> : null}
      <div className="ml2 sx-split">
        {renderList()}
        {renderMain()}
      </div>
    </div>
  );
}

/** 侧栏邮件角标：未读来信数（与收件箱同一口径：订单派生来信 + 买家回信，减去已读） */
export async function countUnreadMail(session: Session): Promise<number> {
  const [orders, replies, readIds] = await Promise.all([
    fetchStudentOrders(session),
    fetchMailReplies(session),
    fetchReadMarks(session, "mail"),
  ]);
  const read = new Set(readIds);
  const ids = [
    ...orders.map(buildInboundMail).filter((mail): mail is InboundMail => mail !== null).map((mail) => mail.id),
    ...replies.map((reply) => `db-${reply.id}`),
  ];
  return ids.filter((id) => !read.has(id)).length;
}
