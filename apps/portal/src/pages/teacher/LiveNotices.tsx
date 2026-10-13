import { Archive, ArrowRight, Check, ChevronDown, ChevronUp, Megaphone, Plus, Send } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  ApiError, deleteAnnouncement, fetchClasses, fetchTeacherAnnouncements, publishAnnouncement,
  type ClassSummary, type Session, type TeacherAnnouncement,
} from "../../api/client";
import { Bench, Board, Button, Confirm, Drawer, Field, Input, MoreMenu, Segmented, Select, Textarea, toast } from "../../ui";

type Expiry = "7" | "14" | "30" | "forever";

const EXPIRY_OPTIONS: Array<{ id: Expiry; label: string }> = [
  { id: "7", label: "7 天" },
  { id: "14", label: "14 天" },
  { id: "30", label: "30 天" },
  { id: "forever", label: "一直有效" },
];

/* 常用模板：空状态里点一下就起草 */
const TEMPLATES = [
  { name: "截止提醒", title: "「任务名」明天 18:00 截止", content: "还没完成的同学抓紧时间，按任务要求完成接待。遇到买家情绪激动，先安抚再给方案，记得用规范话术。" },
  { name: "课堂安排", title: "周四实训课改到 302 机房", content: "本周四的实训课改到实训楼 302 机房，请提前 5 分钟到，用自己的账号登录客户端。" },
  { name: "系统维护", title: "今晚 22:00–23:00 暂停使用", content: "平台今晚 22:00–23:00 维护，期间无法登录。正在进行的接待请在 22:00 前结束。" },
];

const errorText = (cause: unknown) => (cause instanceof ApiError ? cause.message : "无法连接服务器，请稍后重试。");
const day = (iso: string) => new Date(iso).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });

function leftText(item: TeacherAnnouncement): { text: string; warn: boolean } {
  if (!item.expiresAt) return { text: "一直有效", warn: false };
  const days = Math.ceil((new Date(item.expiresAt).getTime() - Date.now()) / 86400000);
  if (item.expired) return { text: `${day(item.expiresAt)} 已过期`, warn: false };
  return { text: days <= 1 ? "今天到期" : `还剩 ${days} 天`, warn: days <= 2 };
}

/** 学生端顶栏的示意：公告在学生那边长什么样 */
function ClientPreview({ title, content }: { title: string; content: string }) {
  return (
    <div className="client-preview" aria-hidden="true">
      <div className="client-preview-top"><i /><i /><i /></div>
      <div className="client-preview-banner">
        <Megaphone size={14} />
        <div><b>{title || "公告标题"}</b> {content ? `${content.slice(0, 30)}${content.length > 30 ? "…" : ""}` : "公告内容"}</div>
      </div>
      <div className="client-preview-lines"><span style={{ width: "70%" }} /><span style={{ width: "90%" }} /><span style={{ width: "55%" }} /><span style={{ width: "80%" }} /></div>
    </div>
  );
}

/* 通知公告：只用来“告知”，有有效期，过期自动从学生端消失；要学生去做的事走任务下发 */
export function LiveNotices({ session }: { session: Session }) {
  const [items, setItems] = useState<TeacherAnnouncement[]>([]);
  const [classes, setClasses] = useState<ClassSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showExpired, setShowExpired] = useState(false);
  const [draft, setDraft] = useState<{ title: string; content: string } | null>(null);
  const [revoking, setRevoking] = useState<TeacherAnnouncement | null>(null);

  const reload = useCallback(
    () => fetchTeacherAnnouncements(session).then(setItems).catch((cause) => toast.error(errorText(cause))).finally(() => setLoading(false)),
    [session],
  );
  useEffect(() => {
    void reload();
    fetchClasses(session).then(setClasses).catch(() => undefined);
  }, [reload, session]);

  const live = items.filter((item) => !item.expired);
  const expired = items.filter((item) => item.expired);

  async function revoke() {
    if (!revoking) return;
    try {
      await deleteAnnouncement(session, revoking.id);
      toast.ok(revoking.expired ? "已删除" : "已撤回，学生端不再显示");
      setRevoking(null);
      await reload();
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }

  const compose = (title = "", content = "") => setDraft({ title, content });
  const row = (item: TeacherAnnouncement) => {
    const left = leftText(item);
    const total = item.recipientCount ?? 0;
    const read = Math.min(item.readCount ?? 0, total);
    return (
      <article key={item.id} className={item.expired ? "nt-row is-expired" : "nt-row"}>
        <span className="nt-bar" />
        <div className="nt-main">
          <h4>{item.title}<span className="ui-tag is-neutral">{item.className ?? "全部班级"}</span></h4>
          <p>{item.content}</p>
          <div className="nt-meta"><span>{day(item.createdAt)} 发布</span>{left.warn ? <b>{left.text}</b> : <span>{left.text}</span>}</div>
        </div>
        <div className="nt-read">
          <div className="nt-read-top"><span>已读</span><span><b>{read}</b> / {total}</span></div>
          <div className="prog-track"><i style={{ width: `${total ? (read / total) * 100 : 0}%` }} /></div>
        </div>
        <MoreMenu items={[{ label: item.expired ? "删除" : "撤回", danger: true, onClick: () => setRevoking(item) }]} />
      </article>
    );
  };

  return (
    <>
      <Bench>
        {loading ? <Board><p className="board-quiet">正在读取…</p></Board> : live.length === 0 ? (
          <>
            <Board>
              <div className="nt-empty">
                <div>
                  <div className="nt-empty-icon"><Megaphone size={26} /></div>
                  <h3>还没有生效中的公告</h3>
                  <p>公告会出现在学生客户端顶部，学生看到即算已读，到期自动消失。适合调课、截止提醒、考核说明；要学生去完成的事，请用「实训任务」下发。</p>
                  <Button variant="primary" icon={Plus} onClick={() => compose()}>发布公告</Button>
                  <div className="nt-templates">
                    {TEMPLATES.map((tpl) => (
                      <button key={tpl.name} type="button" onClick={() => compose(tpl.title, tpl.content)}>
                        <b>{tpl.name}</b><span>“{tpl.title}”</span>
                      </button>
                    ))}
                  </div>
                </div>
                <ClientPreview title={TEMPLATES[1]!.title} content={TEMPLATES[1]!.content} />
              </div>
            </Board>
            {expired.length ? (
              <Board>
                <div className="nt-history">
                  <Archive size={16} />已过期的公告 {expired.length} 条 · 最近一条「{expired[0]!.title}」{expired[0]!.expiresAt ? `${day(expired[0]!.expiresAt)} 到期` : ""}
                  <button type="button" className="board-link" onClick={() => setShowExpired((value) => !value)}>{showExpired ? "收起" : "查看"}</button>
                </div>
                {showExpired ? expired.map(row) : null}
              </Board>
            ) : null}
          </>
        ) : (
          <div className="nt-grid">
            <Board
              title="生效中"
              count={live.length}
              extra={<Button variant="primary" icon={Plus} onClick={() => compose()}>发布公告</Button>}
            >
              {live.map(row)}
              {expired.length ? (
                <>
                  <button type="button" className="nt-fold" onClick={() => setShowExpired((value) => !value)}>
                    <Archive size={16} />已过期 {expired.length} 条
                    <span>{showExpired ? <>收起<ChevronUp size={14} /></> : <>展开<ChevronDown size={14} /></>}</span>
                  </button>
                  {showExpired ? expired.map(row) : null}
                </>
              ) : null}
            </Board>
            <Board>
              <div className="nt-side">
                <h4>学生端怎么显示</h4>
                <p>公告出现在学生客户端顶部，多条轮流显示；学生看到即算已读，到期自动消失。</p>
                <ClientPreview title={live[0]!.title} content={live[0]!.content} />
              </div>
              <div className="nt-tips">
                <div><Check size={16} /><span>适合：调课、截止提醒、考核说明</span></div>
                <div><ArrowRight size={16} /><span>要学生去<b>完成</b>的事，用「实训任务」下发，系统会统计完成情况</span></div>
              </div>
            </Board>
          </div>
        )}
      </Bench>
      {draft ? (
        <ComposeDrawer
          classes={classes}
          initial={draft}
          onClose={() => setDraft(null)}
          onSubmit={async (payload) => {
            try {
              await publishAnnouncement(session, payload);
              toast.ok("已发布，学生端顶部现在就能看到");
              setDraft(null);
              await reload();
            } catch (cause) {
              toast.error(errorText(cause));
            }
          }}
        />
      ) : null}
      {revoking ? (
        <Confirm title={revoking.expired ? "删除公告" : "撤回公告"} danger confirmText={revoking.expired ? "删除" : "撤回"} onConfirm={() => void revoke()} onClose={() => setRevoking(null)}>
          {revoking.expired ? `删除「${revoking.title}」？` : `撤回后学生端马上不再显示「${revoking.title}」。`}
        </Confirm>
      ) : null}
    </>
  );
}

function ComposeDrawer({ classes, initial, onClose, onSubmit }: {
  classes: ClassSummary[];
  initial: { title: string; content: string };
  onClose: () => void;
  onSubmit: (payload: { title: string; content: string; classIds?: string[]; days: number | null }) => Promise<void>;
}) {
  const [title, setTitle] = useState(initial.title);
  const [content, setContent] = useState(initial.content);
  const [classId, setClassId] = useState("all");
  const [expiry, setExpiry] = useState<Expiry>("14");
  const [busy, setBusy] = useState(false);
  const ready = title.trim() && content.trim();
  const recipients = classId === "all" ? classes.reduce((sum, item) => sum + item.studentCount, 0) : classes.find((item) => item.id === classId)?.studentCount ?? 0;
  const until = expiry === "forever" ? "一直显示，直到你撤回" : `${new Date(Date.now() + Number(expiry) * 86400000).toLocaleDateString("zh-CN", { month: "long", day: "numeric" })}后自动从学生端消失`;

  async function submit() {
    if (!ready) return;
    setBusy(true);
    await onSubmit({
      title: title.trim(),
      content: content.trim(),
      classIds: classId === "all" ? undefined : [classId],
      days: expiry === "forever" ? null : Number(expiry),
    });
    setBusy(false);
  }

  return (
    <Drawer
      title="发布公告"
      width={880}
      flush
      onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>取消</Button><Button variant="primary" icon={Send} loading={busy} disabled={!ready} onClick={() => void submit()}>发布给 {recipients} 名学生</Button></>}
    >
      <div className="nt-compose">
        <div className="form-stack nt-compose-form">
          <Field label="发给">
            <Select value={classId} onChange={(event) => setClassId(event.target.value)}>
              <option value="all">我的全部班级（{classes.reduce((sum, item) => sum + item.studentCount, 0)} 人）</option>
              {classes.map((item) => <option key={item.id} value={item.id}>{item.name}（{item.studentCount} 人）</option>)}
            </Select>
          </Field>
          <Field label="标题" hint={`${title.length} / 60`}><Input autoFocus maxLength={60} value={title} placeholder="例如：任务三周五 23:59 截止" onChange={(event) => setTitle(event.target.value)} /></Field>
          <Field label="内容" hint={`学生端顶部只显示前 30 个字，点开看全文 · ${content.length} / 500`}>
            <Textarea rows={6} maxLength={500} value={content} onChange={(event) => setContent(event.target.value)} />
          </Field>
          <Field label="有效期" hint={until}>
            <Segmented items={EXPIRY_OPTIONS} value={expiry} onChange={setExpiry} />
          </Field>
        </div>
        <div className="nt-compose-preview">
          <span className="nt-cap">学生端预览</span>
          <ClientPreview title={title} content={content} />
        </div>
      </div>
    </Drawer>
  );
}
