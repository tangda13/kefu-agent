import { Camera, Eye, EyeOff, History, KeyRound, LogOut, School, ShieldCheck, UserRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ApiError, apiGet, apiRequestDelete, apiRequestPatch, assetUrl, changePassword, loadSession, login, saveSession, uploadMyAvatar, type Session } from "../api/client";
import { Button, Dialog, Field, Input, toast } from "../ui";

/** 个人中心（顶栏头像）：查看资料、改姓名、改密码。三个端共用 */

export interface MyProfile {
  id: string;
  username: string;
  displayName: string;
  role: "student" | "teacher" | "admin";
  className: string | null;
  createdAt: string;
  classes: Array<{ id: string; name: string; role: string; studentCount: number }>;
  recentLogins: string[];
  passwordChangedAt: string | null;
  avatarUrl: string | null;
}

const ROLE_LABELS = { student: "学生", teacher: "教师", admin: "管理员" } as const;
const ACCOUNT_LABELS = { student: "学号", teacher: "工号", admin: "账号" } as const;
const errorText = (cause: unknown) => (cause instanceof ApiError ? cause.message : "无法连接服务器，请稍后重试。");
const dateTime = (iso: string) => new Date(iso).toLocaleString("zh-CN", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const daysAgo = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);

/** 头像：有图片显示图片，没有显示姓名首字（顶栏、菜单、个人资料共用） */
export function UserAvatar({ name, url, size = 28, className }: { name: string; url?: string | null; size?: number; className?: string }) {
  const src = url ? assetUrl(url) : null;
  return (
    <span className={["ac-avatar", className].filter(Boolean).join(" ")} style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}>
      {src ? <img src={src} alt="" /> : (name || "?").slice(0, 1)}
    </span>
  );
}

/** 上传前在本地裁成正方形并压缩到 320×320，文件通常只有几十 KB */
async function squareImage(file: File, size = 320): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("读不了这张图片"));
      element.src = url;
    });
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#fff";
    context.fillRect(0, 0, size, size);
    context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("图片处理失败"))), "image/jpeg", 0.88));
  } finally {
    URL.revokeObjectURL(url);
  }
}

const loginText = (iso: string) => {
  const date = new Date(iso);
  const today = new Date();
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === today.toDateString()) return `今天 ${time}`;
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${time}`;
  return `${date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })} ${time}`;
};

export function ProfileDialog({ session, onClose, onSessionChange, onChangePassword }: {
  session: Session;
  onClose: () => void;
  onSessionChange: (next: Session) => void;
  onChangePassword: () => void;
}) {
  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [name, setName] = useState(session.user.displayName);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    apiGet<MyProfile>("/v1/me", session).then((data) => { setProfile(data); setName(data.displayName); }).catch((cause) => toast.error(errorText(cause)));
  }, [session]);

  const avatarUrl = session.user.avatarUrl ?? profile?.avatarUrl ?? null;
  const commit = (patch: Partial<Session["user"]>) => {
    // 令牌以本机存的为准（续期后手里这份是旧的），只改用户资料
    const base = loadSession() ?? session;
    const next = { ...base, user: { ...base.user, ...patch } };
    saveSession(next);
    onSessionChange(next);
  };

  async function pickAvatar(file: File | undefined) {
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp)$/.test(file.type)) return toast.error("请选 png / jpg / webp 图片");
    setUploading(true);
    try {
      const { avatarUrl: url } = await uploadMyAvatar(session, await squareImage(file));
      commit({ avatarUrl: url });
      toast.ok("头像已更新");
    } catch (cause) {
      toast.error(cause instanceof Error && !(cause instanceof ApiError) ? cause.message : errorText(cause));
    } finally {
      setUploading(false);
    }
  }

  async function removeAvatar() {
    try {
      await apiRequestDelete("/v1/me/avatar", session);
      commit({ avatarUrl: null });
      toast.ok("已恢复默认头像");
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }

  const dirty = Boolean(name.trim()) && name.trim() !== (profile?.displayName ?? session.user.displayName);
  async function save() {
    setBusy(true);
    try {
      const result = await apiRequestPatch<{ ok: boolean; displayName: string }>("/v1/me", session, { displayName: name.trim() });
      commit({ displayName: result.displayName });
      toast.ok("已保存");
      onClose();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  const role = profile?.role ?? session.user.role;
  const pwDays = profile?.passwordChangedAt ? daysAgo(profile.passwordChangedAt) : null;
  const shownName = name.trim() || session.user.displayName;
  return (
    <Dialog
      title="个人资料"
      width={760}
      onClose={onClose}
      footer={<><Button onClick={onClose}>{dirty ? "取消" : "关闭"}</Button>{dirty ? <Button variant="primary" loading={busy} onClick={() => void save()}>保存</Button> : null}</>}
    >
      <div className="ac">
        <div className="ac-hero">
          <div className="ac-hero-av">
            <button type="button" className="ac-av-btn" title="更换头像" disabled={uploading} onClick={() => fileRef.current?.click()}>
              <UserAvatar name={shownName} url={avatarUrl} size={76} />
              <span className="ac-av-mask">{uploading ? "上传中…" : <><Camera size={16} />更换</>}</span>
            </button>
            <input ref={fileRef} type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={(event) => { void pickAvatar(event.target.files?.[0]); event.target.value = ""; }} />
          </div>
          <div className="ac-hero-info">
            <b>{shownName}</b>
            <span><span className="ac-role">{ROLE_LABELS[role]}</span>{ACCOUNT_LABELS[role]} {session.user.username}</span>
            <span className="ac-hero-links">
              <button type="button" onClick={() => fileRef.current?.click()}>上传头像</button>
              {avatarUrl ? <button type="button" onClick={() => void removeAvatar()}>恢复默认</button> : null}
              <em>建议用正方形照片，会自动裁剪</em>
            </span>
          </div>
          {profile?.createdAt ? <span className="ac-hero-since">{new Date(profile.createdAt).toLocaleDateString("zh-CN")} 开通</span> : null}
        </div>

        <div className="ac-body">
          <div className="ac-col">
            <section className="ac-sec">
              <h5><UserRound size={14} />基本信息</h5>
              <Field label="姓名"><Input value={name} maxLength={30} onChange={(event) => setName(event.target.value)} /></Field>
              <Field label={ACCOUNT_LABELS[role]} hint="账号由管理员分配，不能自己修改"><Input value={session.user.username} disabled /></Field>
            </section>
            {role !== "admin" ? (
              <section className="ac-sec">
                <h5><School size={14} />{role === "teacher" ? "我的班级" : "所在班级"}</h5>
                {role === "teacher" ? (
                  profile?.classes.length ? (
                    <ul className="ac-classes">
                      {profile.classes.map((item) => <li key={item.id}><b>{item.name}</b><span>{item.studentCount} 名学生</span><em className={item.role === "班主任" ? "is-head" : undefined}>{item.role}</em></li>)}
                    </ul>
                  ) : <p className="ac-fact">{profile ? "还没有分到班级，请联系管理员" : "正在读取…"}</p>
                ) : <p className="ac-fact">{profile ? profile.className ?? "还没有分到班级" : "正在读取…"}</p>}
              </section>
            ) : null}
          </div>

          <div className="ac-col">
            <section className="ac-sec">
              <h5><ShieldCheck size={14} />账号安全</h5>
              <div className="ac-security">
                <span className={pwDays == null || pwDays > 180 ? "ac-sec-ico is-warn" : "ac-sec-ico"}><KeyRound size={16} /></span>
                <div>
                  <b>登录密码</b>
                  <span className={pwDays == null || pwDays > 180 ? "is-warn" : undefined}>
                    {profile ? (profile.passwordChangedAt ? `${pwDays === 0 ? "今天" : `${pwDays} 天前`}修改过` : "还在用初始密码，建议修改") : "…"}
                  </span>
                </div>
                <Button size="sm" onClick={onChangePassword}>修改</Button>
              </div>
            </section>
            <section className="ac-sec">
              <h5><History size={14} />最近登录</h5>
              {profile?.recentLogins.length ? (
                <ul className="ac-logins">
                  {profile.recentLogins.map((iso, index) => (
                    <li key={iso} className={index === 0 ? "is-now" : undefined}><i />{loginText(iso)}{index === 0 ? <em>本次</em> : null}</li>
                  ))}
                </ul>
              ) : <p className="ac-fact">{profile ? "还没有登录记录" : "正在读取…"}</p>}
              <p className="ac-fact">不是你本人登录的话，马上修改密码。</p>
            </section>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

export function PasswordDialog({ session, onClose, onSessionChange }: { session: Session; onClose: () => void; onSessionChange: (next: Session) => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const strength = next.length === 0 ? 0 : next.length < 8 ? 1 : [/[a-z]/, /[A-Z]/, /\d/, /[^\w]/].filter((re) => re.test(next)).length >= 3 && next.length >= 10 ? 3 : 2;

  async function submit() {
    if (!current) return setError("请输入当前密码");
    if (next.length < 8) return setError("新密码不少于 8 位");
    if (next !== confirm) return setError("两次输入的新密码不一致");
    if (next === current) return setError("新密码不能和当前密码相同");
    setError("");
    setBusy(true);
    try {
      await changePassword(session, current, next);
      // 改密后服务端会让旧的登录令牌失效，这里用新密码直接重新登录，不打断老师手上的工作
      const fresh = await login(session.user.username, next, session.user.role);
      onSessionChange(fresh);
      toast.ok("密码已修改，其他设备上的登录已退出");
      onClose();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  const type = show ? "text" : "password";
  return (
    <Dialog
      title="修改密码"
      onClose={onClose}
      footer={<>{error ? <span className="drawer-error" role="alert">{error}</span> : null}<Button onClick={onClose}>取消</Button><Button variant="primary" loading={busy} onClick={() => void submit()}>确认修改</Button></>}
    >
      <div className="ac-pw">
        <Field label="当前密码"><Input type={type} autoFocus value={current} autoComplete="current-password" onChange={(event) => setCurrent(event.target.value)} /></Field>
        <Field label="新密码" hint="不少于 8 位；字母、数字、符号混用更安全">
          <div className="ac-pw-in">
            <Input type={type} value={next} autoComplete="new-password" onChange={(event) => setNext(event.target.value)} />
            <button type="button" title={show ? "隐藏密码" : "显示密码"} onClick={() => setShow(!show)}>{show ? <EyeOff size={16} /> : <Eye size={16} />}</button>
          </div>
          {next ? <div className={`ac-strength is-${strength}`}><i /><i /><i /><span>{["", "太短", "一般", "较强"][strength]}</span></div> : null}
        </Field>
        <Field label="再输一次新密码"><Input type={type} value={confirm} autoComplete="new-password" onChange={(event) => setConfirm(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void submit(); }} /></Field>
        <p className="ac-fact">修改后，其他电脑和浏览器上的登录会自动退出。</p>
      </div>
    </Dialog>
  );
}

/** 顶栏头像的下拉菜单内容 */
export function ProfileMenuItems({ name, meta, roleLabel, avatarUrl, onProfile, onPassword, onSignOut }: {
  name: string; meta: string; roleLabel: string; avatarUrl?: string | null; onProfile?: () => void; onPassword?: () => void; onSignOut?: () => void;
}) {
  return (
    <>
      <div className="shell-profile-meta">
        <UserAvatar name={name} url={avatarUrl} size={40} />
        <div><strong>{name}</strong><small>{roleLabel} · {meta}</small></div>
      </div>
      {onProfile ? <button type="button" role="menuitem" onClick={onProfile}><UserRound size={14} />个人资料</button> : null}
      {onPassword ? <button type="button" role="menuitem" onClick={onPassword}><KeyRound size={14} />修改密码</button> : null}
      {onSignOut ? <><span className="shell-profile-sep" /><button type="button" role="menuitem" onClick={onSignOut}><LogOut size={14} />退出登录</button></> : null}
    </>
  );
}
