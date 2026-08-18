import { Megaphone, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { PageHeader } from "../../components/AppShell";
import {
  ApiError,
  deleteAnnouncement,
  fetchClasses,
  fetchTeacherAnnouncements,
  publishAnnouncement,
  type ClassSummary,
  type Session,
  type TeacherAnnouncement,
} from "../../api/client";
import { TeacherDialog } from "./widgets";

const EXPIRY_OPTIONS = [
  { value: "7", label: "7 天" },
  { value: "14", label: "14 天" },
  { value: "30", label: "30 天" },
  { value: "forever", label: "长期有效" },
];

/* 通知公告：广播型信息（公告=知晓、有时效；需要学生处理的事项走任务下发/教师指导） */
export function LiveNotices({ session }: { session: Session }) {
  const [items, setItems] = useState<TeacherAnnouncement[]>([]);
  const [classes, setClasses] = useState<ClassSummary[]>([]);
  const [composing, setComposing] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [classId, setClassId] = useState("all");
  const [expiry, setExpiry] = useState("30");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dialogError, setDialogError] = useState("");
  const [notice, setNotice] = useState("");

  const reload = () => fetchTeacherAnnouncements(session).then(setItems).catch(() => undefined);

  useEffect(() => {
    reload();
    fetchClasses(session).then(setClasses).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  function openCompose() {
    setTitle("");
    setContent("");
    setClassId("all");
    setExpiry("30");
    setDialogError("");
    setComposing(true);
  }

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setDialogError("");
    try {
      await publishAnnouncement(session, {
        title: title.trim(),
        content: content.trim(),
        classIds: classId === "all" ? undefined : [classId],
        days: expiry === "forever" ? null : Number(expiry),
      });
      setComposing(false);
      setNotice(`公告「${title.trim()}」已发布，学生端顶栏即时可见`);
      await reload();
    } catch (cause) {
      setDialogError(cause instanceof ApiError ? cause.message : "发布失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (item: TeacherAnnouncement) => {
    if (!window.confirm(`确定撤回公告「${item.title}」吗？撤回后学生端立即不再显示。`)) return;
    try {
      await deleteAnnouncement(session, item.id);
      setNotice(`公告「${item.title}」已撤回`);
      await reload();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "撤回失败，请稍后重试。");
    }
  };

  const activeCount = items.filter((item) => !item.expired).length;

  return (
    <div className="page">
      <PageHeader
        title="通知公告"
        description="面向班级或全体学生的广播信息，发布后即时显示在学生端顶栏，过期自动消失。"
        actions={
          <button className="primary-button" onClick={openCompose}>
            <Plus size={16} /> 发布公告
          </button>
        }
      />
      {notice ? <p className="form-notice" role="status">{notice}</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}

      <section className="panel ann-manage">
        <div className="panel-heading">
          <div>
            <h2>公告列表</h2>
            <p>{items.length ? `共 ${items.length} 条 · ${activeCount} 条生效中` : "还没有发布过公告"}</p>
          </div>
        </div>
        <div className="ann-list">
          {items.map((item) => (
            <div key={item.id} className={item.expired ? "ann-row expired" : "ann-row"}>
              <Megaphone size={15} aria-hidden="true" />
              <div className="ann-row-main">
                <div className="ann-row-title">
                  <strong>{item.title}</strong>
                  <span className="ann-scope">{item.className ?? "全体"}</span>
                  {item.expired
                    ? <em className="ann-expired">已过期</em>
                    : <em className="ann-live">生效中</em>}
                </div>
                <p>{item.content}</p>
              </div>
              <small>
                {new Date(item.createdAt).toLocaleDateString("zh-CN")} 发布
                {item.expiresAt ? ` · ${new Date(item.expiresAt).toLocaleDateString("zh-CN")} 到期` : " · 长期"}
              </small>
              <button className="text-button tch-danger" onClick={() => revoke(item)}>撤回</button>
            </div>
          ))}
          {items.length === 0 ? (
            <div className="tt-empty">
              <Megaphone size={24} aria-hidden="true" />
              <strong>还没有发布过公告</strong>
              <p>课程安排、考核提醒、平台通知等广播信息可以发布在这里；需要学生处理的事项请用任务下发或会话内指导。</p>
            </div>
          ) : null}
        </div>
      </section>

      {composing ? (
        <TeacherDialog
          title="发布公告"
          subtitle="发布后即时显示在学生端顶栏，到期自动下线"
          size="wide"
          onClose={() => setComposing(false)}
          footer={
            <>
              <span className="muted" style={{ marginRight: "auto", fontSize: 12 }}>{content.length}/500</span>
              <button className="secondary-button" onClick={() => setComposing(false)}>取消</button>
              <button className="primary-button" onClick={submit} disabled={busy || !title.trim() || !content.trim()}>
                {busy ? "发布中…" : "发布"}
              </button>
            </>
          }
        >
          {dialogError ? <p className="form-error" role="alert">{dialogError}</p> : null}
          <label>
            公告标题
            <input
              value={title}
              maxLength={60}
              placeholder="如：任务三本周五 23:59 截止"
              onChange={(event) => setTitle(event.target.value)}
              autoFocus
            />
          </label>
          <div className="tt-grid-2">
            <label>
              发布范围
              <select value={classId} onChange={(event) => setClassId(event.target.value)}>
                <option value="all">全部我的班级</option>
                {classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
            <label>
              有效期
              <select value={expiry} onChange={(event) => setExpiry(event.target.value)}>
                {EXPIRY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
          </div>
          <label>
            公告内容
            <textarea
              value={content}
              maxLength={500}
              rows={5}
              placeholder="公告内容（500 字以内）"
              onChange={(event) => setContent(event.target.value)}
            />
          </label>
        </TeacherDialog>
      ) : null}
    </div>
  );
}
