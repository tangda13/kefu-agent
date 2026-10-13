import { Eye, EyeOff } from "lucide-react";
import { useState, type FormEvent } from "react";
import { BrandMark, useBrand } from "../brand";
import sceneImage from "../assets/login/scene.webp";
import type { UserRole } from "@cecs/contracts";
import { ApiError, changePassword, login, type Session } from "../api/client";

const roleCopy: Record<UserRole, { account: string; accountHint: string; remember: string }> = {
  student: { account: "学号", accountHint: "请输入学号", remember: "记住学号" },
  teacher: { account: "教师账号", accountHint: "请输入教师账号", remember: "记住账号" },
  admin: { account: "管理员账号", accountHint: "请输入管理员账号", remember: "记住账号" },
};

const REMEMBER_KEY = "cecs.login.remember";

function readRemembered(): Partial<Record<UserRole, string>> {
  try {
    return JSON.parse(localStorage.getItem(REMEMBER_KEY) ?? "{}") as Partial<Record<UserRole, string>>;
  } catch {
    return {};
  }
}

function writeRemembered(role: UserRole, username: string | null) {
  const next = readRemembered();
  if (username) next[role] = username;
  else delete next[role];
  try {
    localStorage.setItem(REMEMBER_KEY, JSON.stringify(next));
  } catch {
    /* 存不了就不记 */
  }
}

const roleLabel: Record<UserRole, string> = { student: "学生", teacher: "教师", admin: "管理员" };

export function LoginScreen({ initialRole, onLogin }: { initialRole: UserRole; onLogin: (session: Session) => void }) {
  // 学生/教师共用同一客户端，登录卡片内切页签；管理端走独立登录（浏览器 ?role=admin）。
  const tabbed = initialRole !== "admin";
  const [activeRole, setActiveRole] = useState<UserRole>(initialRole);
  const [showPassword, setShowPassword] = useState(false);
  const [username, setUsername] = useState(() => readRemembered()[initialRole] ?? "");
  const [remember, setRemember] = useState(() => Boolean(readRemembered()[initialRole]));
  const { brand, online } = useBrand();
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pendingSession, setPendingSession] = useState<Session | null>(null);
  const [error, setError] = useState("");
  /** 页签与账号角色不符时，可一键切换到的页签（I7） */
  const [switchTo, setSwitchTo] = useState<UserRole | null>(null);
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  const copy = roleCopy[activeRole];

  function switchRole(next: UserRole) {
    if (busy || next === activeRole) return;
    setActiveRole(next);
    setUsername(readRemembered()[next] ?? "");
    setRemember(Boolean(readRemembered()[next]));
    setError("");
    setSwitchTo(null);
    setHint("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError("");
    setSwitchTo(null);
    setHint("");
    setBusy(true);
    try {
      const session = await login(username.trim(), password, activeRole);
      writeRemembered(activeRole, remember ? username.trim() : null);
      if (session.user.mustChangePassword) {
        setPendingSession(session);
      } else {
        onLogin(session);
      }
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "ROLE_MISMATCH") {
        const actual = cause.body.actualRole;
        if (tabbed && (actual === "student" || actual === "teacher")) setSwitchTo(actual);
        else if (!tabbed) {
          setError(`该账号是${roleLabel[actual as UserRole] ?? "非管理员"}账号，无法登录管理端，请使用客户端登录。`);
          return;
        }
      }
      setError(cause instanceof ApiError ? cause.message : "无法连接服务器，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  async function submitPasswordChange(event: FormEvent) {
    event.preventDefault();
    if (busy || !pendingSession) return;
    if (newPassword.length < 8) {
      setError("新密码长度不得少于 8 位。");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("两次输入的新密码不一致。");
      return;
    }
    setError("");
    setBusy(true);
    try {
      await changePassword(pendingSession, password, newPassword);
      const session = await login(pendingSession.user.username, newPassword, activeRole);
      onLogin(session);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "无法连接服务器，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  const passwordToggle = (
    <button type="button" className="login-eye" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? "隐藏密码" : "显示密码"}>
      {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
    </button>
  );

  return (
    <main className="login-scene">
      <img className="login-scene-image" src={sceneImage} alt="" aria-hidden="true" decoding="async" />
      <div className="login-frame">
        <header className="login-brand">
          <BrandMark size={26} />
          <strong>{brand.name}</strong>
        </header>
        <div className="login-body">
          <p className="login-slogan" aria-hidden="true"><span>每一句回复，</span><span>都是一次真实的服务</span></p>
          <section className="login-card">
            {pendingSession ? (
              <form onSubmit={submitPasswordChange} noValidate>
                <div>
                  <h1>设置新密码</h1>
                  <p className="login-lede">首次登录需要把临时密码改成你自己的密码</p>
                </div>
                <label className="login-field">新密码
                  <span className="login-input"><input type={showPassword ? "text" : "password"} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="至少 8 位" autoComplete="new-password" />{passwordToggle}</span>
                </label>
                <label className="login-field">确认新密码
                  <span className="login-input"><input type={showPassword ? "text" : "password"} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="再输入一次" autoComplete="new-password" /></span>
                </label>
                {error ? <p className="login-error" role="alert">{error}</p> : null}
                <button className="login-submit" type="submit" disabled={busy}>{busy ? "提交中…" : "设置并进入"}</button>
              </form>
            ) : (
              <form onSubmit={submit} noValidate>
                {tabbed ? (
                  <div className="login-roles" role="tablist" aria-label="登录身份">
                    {(["student", "teacher"] as const).map((role) => (
                      <button key={role} type="button" role="tab" aria-selected={activeRole === role} className={activeRole === role ? "is-active" : undefined} onClick={() => switchRole(role)}>{roleLabel[role]}</button>
                    ))}
                  </div>
                ) : null}
                <div>
                  <h1>{tabbed ? "登录" : "管理端登录"}</h1>
                  <p className="login-lede">{tabbed ? "使用学校分配的账号" : "使用管理员账号"}</p>
                </div>
                <label className="login-field">{copy.account}
                  <span className="login-input"><input value={username} onChange={(event) => setUsername(event.target.value)} placeholder={copy.accountHint} autoComplete="username" aria-invalid={Boolean(error) || undefined} /></span>
                </label>
                <label className="login-field">密码
                  <span className="login-input"><input type={showPassword ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="请输入密码" autoComplete="current-password" aria-invalid={Boolean(error) || undefined} />{passwordToggle}</span>
                </label>
                {error ? (
                  <p className="login-error" role="alert">
                    {error}
                    {switchTo ? <button type="button" className="login-link" onClick={() => switchRole(switchTo)}>切换到{roleLabel[switchTo]}登录</button> : null}
                  </p>
                ) : null}
                <button className="login-submit" type="submit" disabled={busy}>{busy ? "登录中…" : "登录"}</button>
                <div className="login-row">
                  <label className="login-check"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />{copy.remember}</label>
                  <button type="button" className="login-link" onClick={() => setHint(activeRole === "student" ? "请联系任课教师重置密码。" : activeRole === "teacher" ? "请联系平台管理员重置密码。" : "请在服务器上运行重置密码命令，见运维手册。")}>忘记密码</button>
                </div>
                {hint ? <p className="login-hint">{hint}</p> : null}
              </form>
            )}
          </section>
        </div>
        <footer className="login-foot">
          <span />
          {online === false ? (
            <span className="login-conn is-off"><i />无法连接服务器，请检查网络</span>
          ) : online ? (
            <span className="login-conn"><i />已连接服务器</span>
          ) : <span />}
        </footer>
      </div>
    </main>
  );
}
