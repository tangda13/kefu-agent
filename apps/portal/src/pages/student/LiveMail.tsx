import {
  Archive,
  ChevronUp,
  ExternalLink,
  FileText,
  Inbox,
  Mail,
  PenLine,
  RefreshCw,
  Reply,
  Search,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { deriveBuyerEmail } from "@cecs/domain";
import { PageHeader } from "../../components/AppShell";
import { BuyerAvatar } from "../../components/BuyerAvatar";
import {
  ApiError,
  assistMail,
  fetchForbiddenTerms,
  fetchMailReplies,
  fetchMailDrafts,
  fetchReadMarks,
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
  type StudentOrder,
} from "../../api/client";

type Folder = "inbox" | "sent" | "drafts";

/** 店铺客服发件邮箱（展示用） */
const SHOP_MAILBOX = "support@auroramart-global.com";

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
  replyToId: string | null;
  /** 关联订单：回信时来自来信，主动写信时按收件人邮箱反查（买家 AI 回信依赖它定位人设） */
  orderId: string | null;
}

interface AssistVersion {
  subject: string | null;
  body: string;
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
  const [assist, setAssist] = useState<"closed" | "loading" | "open">("closed");
  const [assistVersions, setAssistVersions] = useState<AssistVersion[]>([]);
  const [folder, setFolder] = useState<Folder>("inbox");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [compose, setCompose] = useState<ComposeState | null>(null);
  const [readIds, setReadIds] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<DraftMail[]>([]);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
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

  const unreadCount = inbox.filter((mail) => !readIds.has(mail.id)).length;

  const keyword = query.trim().toLowerCase();
  const filteredInbox = keyword
    ? inbox.filter((mail) => [mail.subject, mail.buyer.name, mail.body].some((field) => field.toLowerCase().includes(keyword)))
    : inbox;
  const filteredSent = keyword
    ? sent.filter((mail) => [mail.subject, mail.recipient ?? "", mail.body].some((field) => field.toLowerCase().includes(keyword)))
    : sent;
  const filteredDrafts = keyword
    ? drafts.filter((draft) => [draft.subject, draft.to, draft.body].some((field) => field.toLowerCase().includes(keyword)))
    : drafts;

  const activeInbound = folder === "inbox" ? inbox.find((mail) => mail.id === selectedId) ?? null : null;
  const activeSent = folder === "sent" ? sent.find((mail) => mail.id === selectedId) ?? null : null;

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

  /* ---------------- 撰写 ---------------- */

  function startCompose(preset?: Partial<ComposeState>) {
    setCompose({
      draftId: null,
      to: "",
      subject: "",
      body: "",
      templateId: null,
      replyToId: null,
      orderId: null,
      ...preset,
    });
    setAssist("closed");
    setAssistVersions([]);
    setNotice("");
    setError("");
  }

  function startReply(mail: InboundMail) {
    startCompose({
      to: mail.fromEmail,
      subject: mail.subject.startsWith("Re:") ? mail.subject : `Re: ${mail.subject}`,
      body: `\n\n----- Original Message -----\nFrom: ${mail.buyer.name} <${mail.fromEmail}>\nDate: ${fmtFullTime(mail.at)}\nSubject: ${mail.subject}\n\n${mail.body}`,
      replyToId: mail.id,
      orderId: mail.orderId,
    });
  }

  function resumeDraft(draft: DraftMail) {
    setCompose({
      draftId: draft.id,
      to: draft.to,
      subject: draft.subject,
      body: draft.body,
      templateId: draft.templateId,
      replyToId: null,
      orderId: null,
    });
    setAssist("closed");
    setAssistVersions([]);
  }

  /** 关联订单：优先取回信上下文，其次按收件人邮箱反查买家 */
  function linkedOrderId(state: ComposeState): string | undefined {
    if (state.orderId) return state.orderId;
    const target = state.to.trim().toLowerCase();
    if (!target) return undefined;
    return inbox.find((mail) => mail.fromEmail.toLowerCase() === target)?.orderId ?? undefined;
  }

  function applyTemplate(template: MailTemplate) {
    if (!compose) return;
    const recipientName = compose.replyToId
      ? inbox.find((mail) => mail.id === compose.replyToId)?.buyer.name ?? "Customer"
      : compose.to.split("@")[0]?.split(".").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ") || "Customer";
    setCompose({
      ...compose,
      templateId: template.id,
      subject: template.subject,
      body: template.body.replace("{customer}", recipientName).replace("{agent}", session.user.displayName),
    });
  }

  function saveDraft(silent = false) {
    if (!compose) return;
    if (!compose.to.trim() && !compose.subject.trim() && !compose.body.trim()) return;
    const id = compose.draftId ?? `d${Date.now()}${Math.floor(Math.random() * 1e4)}`;
    const next: DraftMail = {
      id,
      to: compose.to,
      subject: compose.subject,
      body: compose.body,
      templateId: compose.templateId,
      savedAt: new Date().toISOString(),
    };
    upsertDraft(next);
    if (!silent) {
      setCompose({ ...compose, draftId: id });
      setNotice("草稿已保存。");
    }
  }

  function closeCompose(saveAsDraft: boolean) {
    if (saveAsDraft) saveDraft(true);
    else if (compose?.draftId) removeDraft(compose.draftId);
    setCompose(null);
    setAssist("closed");
    setAssistVersions([]);
  }

  /* ---------------- AI 辅助写信 ---------------- */

  async function runAssist() {
    if (!compose || busy) return;
    const replySource = compose.replyToId ? inbox.find((mail) => mail.id === compose.replyToId) : null;
    setBusy(true);
    setError("");
    setAssist("loading");
    try {
      const result = await assistMail(session, {
        mode: compose.replyToId ? "reply" : "compose",
        orderId: linkedOrderId(compose),
        templateId: compose.templateId ?? undefined,
        originalSubject: replySource?.subject,
        originalBody: replySource?.body,
      });
      setAssistVersions(result.versions.slice(0, 3));
      setAssist("open");
    } catch (cause) {
      setError(errorText(cause));
      setAssist("closed");
    } finally {
      setBusy(false);
    }
  }

  /** 选择版本填入：回信模式保留引用块，主动模式同时填主题 */
  function applyAssistVersion(version: AssistVersion) {
    if (!compose) return;
    const marker = "----- Original Message -----";
    const markerIndex = compose.body.indexOf(marker);
    const quote = markerIndex >= 0 ? compose.body.slice(markerIndex) : null;
    setCompose({
      ...compose,
      subject: version.subject ?? compose.subject,
      body: quote ? `${version.body}\n\n${quote}` : version.body,
    });
  }

  // 实时违规词检测（前端本地扫描，输入即查）
  const violations = useMemo(() => {
    if (!compose) return [];
    const haystack = `${compose.subject}\n${compose.body}`.toLowerCase();
    return terms.filter((term) => haystack.includes(term.toLowerCase()));
  }, [compose, terms]);

  async function sendMail() {
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
        templateId: compose.templateId ?? (compose.replyToId ? "MAIL-REPLY" : "MAIL-CUSTOM"),
        subject: compose.subject.trim(),
        body: compose.body.trim(),
        recipient: compose.to.trim(),
        orderId: linkedOrderId(compose),
      });
      if (compose.draftId) removeDraft(compose.draftId);
      setNotice(
        result.compliant
          ? "邮件已发送，合规检测通过（0 个违规词）。"
          : `邮件已发送，但服务端检测到 ${result.violations.length} 个违规宣传用语，已记录：${result.violations.join("、")}。`,
      );
      setCompose(null);
      setAssist("closed");
      setAssistVersions([]);
      const sentList = await fetchMailSubmissions(session);
      setSent(sentList);
      setFolder("sent");
      setSelectedId(result.id);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  /* ---------------- 视图 ---------------- */

  function renderFolderRail() {
    const items: Array<[Folder, string, typeof Inbox, number | null]> = [
      ["inbox", "收件箱", Inbox, unreadCount || null],
      ["sent", "已发送", Send, null],
      ["drafts", "草稿箱", FileText, drafts.length || null],
    ];
    return (
      <aside className="ml-rail">
        <button className="primary-button full ml-compose-btn" onClick={() => startCompose()}>
          <PenLine size={15} /> 写邮件
        </button>
        {items.map(([id, label, Icon, badge]) => (
          <button
            key={id}
            className={folder === id && !compose ? "ml-folder active" : "ml-folder"}
            onClick={() => { setFolder(id); setSelectedId(null); setCompose(null); }}
          >
            <Icon size={15} /> {label}
            {badge ? <span className="ml-folder-badge">{badge}</span> : null}
          </button>
        ))}
        <div className="ml-rail-foot">
          <Mail size={13} /> {SHOP_MAILBOX}
        </div>
      </aside>
    );
  }

  function renderList() {
    return (
      <div className="ml-list">
        <div className="ml-search">
          <Search size={13} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索邮件…" aria-label="搜索邮件" />
        </div>
        {folder === "inbox" ? (
          <>
            {filteredInbox.map((mail) => (
              <button
                key={mail.id}
                className={`ml-item${readIds.has(mail.id) ? "" : " unread"}${selectedId === mail.id && !compose ? " active" : ""}`}
                onClick={() => { setSelectedId(mail.id); setCompose(null); markRead(mail.id); }}
              >
                <BuyerAvatar buyer={mail.buyer} size="tiny" />
                <span className="ml-item-main">
                  <span className="ml-item-top"><strong>{mail.buyer.name}</strong><small>{fmtListTime(mail.at)}</small></span>
                  <span className="ml-item-subject">{mail.subject}</span>
                  <span className="ml-snippet">{mail.body.replace(/\s+/g, " ").slice(0, 60)}</span>
                </span>
              </button>
            ))}
            {filteredInbox.length === 0 ? <p className="muted rail-empty">{inbox.length === 0 ? "暂无来信。" : "没有匹配的邮件。"}</p> : null}
          </>
        ) : null}
        {folder === "sent" ? (
          <>
            {filteredSent.map((mail) => (
              <button
                key={mail.id}
                className={`ml-item${selectedId === mail.id && !compose ? " active" : ""}`}
                onClick={() => { setSelectedId(mail.id); setCompose(null); }}
              >
                <span className="ml-item-main">
                  <span className="ml-item-top">
                    <strong>{mail.recipient ?? "（未填写收件人）"}</strong>
                    <small>{fmtListTime(mail.createdAt)}</small>
                  </span>
                  <span className="ml-item-subject">{mail.subject}</span>
                  <span className="ml-snippet">
                    {mail.compliant
                      ? <em className="status-pill green">合规</em>
                      : <em className="status-pill warn-pill">{mail.violations.length} 个违规词</em>}
                  </span>
                </span>
              </button>
            ))}
            {filteredSent.length === 0 ? <p className="muted rail-empty">{sent.length === 0 ? "还没有发送过邮件。" : "没有匹配的邮件。"}</p> : null}
          </>
        ) : null}
        {folder === "drafts" ? (
          <>
            {filteredDrafts.map((draft) => (
              <button key={draft.id} className="ml-item" onClick={() => resumeDraft(draft)}>
                <span className="ml-item-main">
                  <span className="ml-item-top"><strong>{draft.subject || "（无主题）"}</strong><small>{fmtListTime(draft.savedAt)}</small></span>
                  <span className="ml-item-subject">{draft.to || "（未填写收件人）"}</span>
                  <span className="ml-snippet">{draft.body.replace(/\s+/g, " ").slice(0, 60) || "（空白正文）"}</span>
                </span>
              </button>
            ))}
            {filteredDrafts.length === 0 ? <p className="muted rail-empty">{drafts.length === 0 ? "暂无草稿。" : "没有匹配的草稿。"}</p> : null}
          </>
        ) : null}
      </div>
    );
  }

  function renderViolationPanel() {
    return violations.length > 0 ? (
      <div className="violation-box">
        <strong><ShieldAlert size={14} /> 检测到 {violations.length} 个违规宣传用语（请替换为客观描述）：</strong>
        <div className="chip-row">
          {violations.map((term) => <span key={term} className="chip violation-chip">{term}</span>)}
        </div>
        {phrases.length > 0 ? (
          <div className="ml-phrase-hint">
            <span className="muted">规范话术提示（点击插入正文）：</span>
            <div className="chip-row">
              {phrases.slice(0, 4).map((phrase) => (
                <button
                  key={phrase}
                  className="chip"
                  onClick={() => compose && setCompose({ ...compose, body: `${compose.body.trimEnd()}\n${phrase}` })}
                >
                  {phrase}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    ) : (
      <p className="muted ml-scan-ok"><ShieldCheck size={13} /> 实时检测中，未发现违规宣传用语。</p>
    );
  }

  function renderCompose(state: ComposeState) {
    return (
      <div className="ml-main ml-compose">
        <div className="ml-compose-head">
          <h3>{state.replyToId ? "回复邮件" : "写邮件"}</h3>
          <span className={violations.length === 0 ? "status-pill green" : "status-pill warn-pill"}>
            {violations.length === 0 ? <><ShieldCheck size={12} /> 合规</> : <><ShieldAlert size={12} /> {violations.length} 个违规词</>}
          </span>
        </div>
        <div className="ml-template-row">
          <span className="muted">邮件模板：</span>
          {templates.map((template) => (
            <button
              key={template.id}
              className={state.templateId === template.id ? "chip active" : "chip"}
              title={template.purpose}
              onClick={() => applyTemplate(template)}
            >
              {template.name}
            </button>
          ))}
        </div>
        <label className="mail-field">收件人
          <input
            value={state.to}
            onChange={(event) => setCompose({ ...state, to: event.target.value })}
            placeholder="buyer@example.com"
            list="ml-buyer-emails"
          />
        </label>
        <datalist id="ml-buyer-emails">
          {[...new Map(inbox.map((mail) => [mail.fromEmail, mail.buyer.name])).entries()].map(([email, name]) => (
            <option key={email} value={email}>{name}</option>
          ))}
        </datalist>
        <label className="mail-field">主题
          <input value={state.subject} onChange={(event) => setCompose({ ...state, subject: event.target.value })} />
        </label>
        {assist !== "closed" ? (
          <div className="rv-assist-panel">
            <div className="ai-composer-head">
              <Sparkles size={14} />
              <strong>AI 辅助 · 选择一版填入，可再编辑</strong>
              {assist === "open" ? (
                <>
                  <button className="text-button" disabled={busy} onClick={() => void runAssist()}>
                    <RefreshCw size={13} /> 重新生成
                  </button>
                  <button className="text-button" onClick={() => setAssist("closed")}>
                    <ChevronUp size={13} /> 收起
                  </button>
                </>
              ) : null}
            </div>
            {assist === "loading" ? (
              <p className="muted rv-assist-loading">AI 正在结合买家资料与邮件上下文生成 3 版草稿…</p>
            ) : (
              <div className="suggestion-list">
                {assistVersions.map((version, index) => (
                  <button
                    key={index}
                    className={state.body.startsWith(version.body) ? "suggestion-card active" : "suggestion-card"}
                    onClick={() => applyAssistVersion(version)}
                  >
                    <em>版本 {index + 1}</em>
                    {version.subject ? <span className="ml-assist-subject">{version.subject}</span> : null}
                    <p>{version.body.length > 160 ? `${version.body.slice(0, 160)}…` : version.body}</p>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : null}
        <label className="mail-field ml-body-field">正文
          <textarea
            rows={12}
            value={state.body}
            onChange={(event) => setCompose({ ...state, body: event.target.value })}
            placeholder="以买家语言撰写邮件正文…"
          />
        </label>
        {renderViolationPanel()}
        <div className="ml-compose-actions">
          <button className="primary-button compact" disabled={busy} onClick={() => void sendMail()}>
            <Send size={14} /> 发送
          </button>
          <button className="secondary-button compact" disabled={busy} onClick={() => void runAssist()}>
            <Sparkles size={13} /> AI 辅助
          </button>
          <button className="secondary-button compact" disabled={busy} onClick={() => saveDraft()}>
            <Archive size={13} /> 存草稿
          </button>
          <button className="text-button ml-discard" disabled={busy} onClick={() => closeCompose(false)}>
            <Trash2 size={13} /> 丢弃
          </button>
        </div>
      </div>
    );
  }

  function renderInboundRead(mail: InboundMail) {
    const order = orders.find((item) => item.id === mail.orderId);
    return (
      <div className="ml-main">
        <div className="ml-read-head">
          <BuyerAvatar buyer={mail.buyer} />
          <div className="ml-read-meta">
            <strong>{mail.buyer.name} <small>&lt;{mail.fromEmail}&gt;</small></strong>
            <small>发送至 {SHOP_MAILBOX} · {fmtFullTime(mail.at)}</small>
          </div>
          <button className="primary-button compact" onClick={() => startReply(mail)}>
            <Reply size={13} /> 回复
          </button>
        </div>
        <h3 className="ml-subject">{mail.subject}</h3>
        {order ? (
          <div className="rv-product">
            <span>{mail.productName}</span>
            <small>订单号 {mail.orderNo}</small>
            {onOpenOrder ? (
              <button className="text-button" onClick={() => onOpenOrder(order.id)}>
                <ExternalLink size={12} /> 查看订单
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="ml-body">{mail.body}</div>
      </div>
    );
  }

  function renderSentRead(mail: MailSubmission) {
    const template = templates.find((item) => item.id === mail.templateId);
    return (
      <div className="ml-main">
        <div className="ml-read-head">
          <span className="avatar">我</span>
          <div className="ml-read-meta">
            <strong>{SHOP_MAILBOX}</strong>
            <small>发送至 {mail.recipient ?? "（未填写收件人）"} · {fmtFullTime(mail.createdAt)}</small>
          </div>
          {mail.compliant
            ? <em className="status-pill green"><ShieldCheck size={12} /> 合规</em>
            : <em className="status-pill warn-pill"><ShieldAlert size={12} /> {mail.violations.length} 个违规词</em>}
        </div>
        <h3 className="ml-subject">{mail.subject}</h3>
        {template ? <p className="muted ml-template-tag">使用模板：{template.name}</p> : null}
        <div className="ml-body">{mail.body}</div>
        {mail.violations.length > 0 ? (
          <div className="violation-box">
            <strong><ShieldAlert size={14} /> 服务端复核检出违规宣传用语：</strong>
            <div className="chip-row">
              {mail.violations.map((term) => <span key={term} className="chip violation-chip">{term}</span>)}
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  function renderMain() {
    if (compose) return renderCompose(compose);
    if (activeInbound) return renderInboundRead(activeInbound);
    if (activeSent) return renderSentRead(activeSent);
    return (
      <div className="ml-main ml-empty">
        <Mail size={28} />
        <strong>{folder === "inbox" ? "选择一封来信查看" : folder === "sent" ? "选择一封已发送邮件" : "选择草稿继续编辑"}</strong>
        <p>买家的售前咨询、物流查询与售后来信都会进入收件箱，点击「写邮件」可主动发送推广与关怀邮件。</p>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        eyebrow="MAILBOX"
        title="邮件"
        description="收发买家英文邮件：处理来信、套用模板撰写，编辑器实时检测违规宣传用语并提供规范话术提示。"
      />
      {notice ? <p className="form-notice" role="status">{notice}</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <section className="panel ml-layout">
        {renderFolderRail()}
        {renderList()}
        {renderMain()}
      </section>
    </div>
  );
}
