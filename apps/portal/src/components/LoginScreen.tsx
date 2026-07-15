import { ArrowRight, Eye, EyeOff, LockKeyhole, ShieldCheck, UserRound } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { UserRole } from "@cecs/contracts";
import { ApiError, changePassword, clearSession, login, type Session } from "../api/client";

const roleCopy: Record<UserRole, { eyebrow: string; title: string; subtitle: string; account: string; accountHint: string }> = {
  student: { eyebrow: "STUDENT DESKTOP", title: "把每一次沟通，\n练成真实业务能力", subtitle: "AI 模拟海外买家 · 售前售中售后全流程沉浸式实训", account: "账号 / 学号", accountHint: "请输入账号 / 学号" },
  teacher: { eyebrow: "TEACHER DESKTOP", title: "看见训练过程，\n给出及时指导", subtitle: "任务下发 · 实时跟踪 · 多维考核与复盘", account: "教师账号", accountHint: "请输入教师账号" },
  admin: { eyebrow: "CLOUD ADMIN", title: "稳定运行，\n从每一项配置开始", subtitle: "国内云管理端 · AI 与语音服务 · 备份与运维", account: "管理员账号", accountHint: "请输入管理员账号" },
};

const roleLabel: Record<UserRole, string> = { student: "学生", teacher: "教师", admin: "管理员" };

function roleMismatchMessage(expected: UserRole, actual: UserRole): string {
  if (actual === "admin") return "管理员账号请通过浏览器管理端登录。";
  if (expected === "student" || expected === "teacher") {
    return `该账号为${roleLabel[actual]}账号，请切换到「${roleLabel[actual]}登录」。`;
  }
  return `该账号为${roleLabel[actual]}账号，无法登录管理端。`;
}

export function LoginScreen({ initialRole, onLogin }: { initialRole: UserRole; onLogin: (session: Session) => void }) {
  // 学生/教师共用同一客户端，登录卡片内切页签；管理端走独立登录（浏览器 ?role=admin）。
  const tabbed = initialRole !== "admin";
  const [activeRole, setActiveRole] = useState<UserRole>(initialRole);
  const [showPassword, setShowPassword] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pendingSession, setPendingSession] = useState<Session | null>(null);
  const [error, setError] = useState("");
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  const copy = roleCopy[activeRole];

  function switchRole(next: UserRole) {
    if (busy || next === activeRole) return;
    setActiveRole(next);
    setError("");
    setHint("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError("");
    setHint("");
    setBusy(true);
    try {
      const session = await login(username.trim(), password);
      if (session.user.role !== activeRole) {
        clearSession();
        setError(roleMismatchMessage(activeRole, session.user.role));
        return;
      }
      if (session.user.mustChangePassword) {
        setPendingSession(session);
      } else {
        onLogin(session);
      }
    } catch (cause) {
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
      const session = await login(pendingSession.user.username, newPassword);
      onLogin(session);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "无法连接服务器，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-story">
        <div className="story-grid" aria-hidden="true" />
        <div className="brand-lockup login-brand">
          <span className="brand-mark">K</span>
          <span><strong>跨境电商客服</strong><small>AI 实训平台</small></span>
        </div>
        <div className="story-copy">
          <span className="eyebrow light">{copy.eyebrow}</span>
          <h1>{copy.title.split("\n").map((line) => <span key={line}>{line}</span>)}</h1>
          <p>{copy.subtitle}</p>
          <div className="story-proof">
            <div><strong>4</strong><span>业务环节</span></div>
            <div><strong>20+</strong><span>买家画像</span></div>
            <div><strong>6</strong><span>能力维度</span></div>
          </div>
        </div>
        <p className="story-foot">Learn the conversation. Master the service.</p>
      </section>

      <section className="login-panel">
        <div className="login-card">
          {pendingSession ? (
            <>
              <span className="eyebrow">首次登录</span>
              <h2>请设置新密码</h2>
              <p className="muted">当前为临时密码，设置新密码后继续</p>
              <form onSubmit={submitPasswordChange}>
                <label>
                  <span>新密码</span>
                  <div className="input-wrap"><LockKeyhole size={18} /><input type={showPassword ? "text" : "password"} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} aria-label="新密码" autoComplete="new-password" /></div>
                </label>
                <label>
                  <span>确认新密码</span>
                  <div className="input-wrap"><LockKeyhole size={18} /><input type={showPassword ? "text" : "password"} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} aria-label="确认新密码" autoComplete="new-password" /><button type="button" className="icon-button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? "隐藏密码" : "显示密码"}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div>
                </label>
                {error ? <p className="form-error" role="alert">{error}</p> : null}
                <button className="primary-button login-submit" type="submit" disabled={busy}>{busy ? "提交中…" : "设置并进入"} <ArrowRight size={18} /></button>
              </form>
            </>
          ) : (
            <>
              {tabbed ? (
                <div className="login-tabs" role="tablist" aria-label="登录身份">
                  <button type="button" role="tab" aria-selected={activeRole === "student"} className={activeRole === "student" ? "login-tab active" : "login-tab"} onClick={() => switchRole("student")}>学生登录</button>
                  <button type="button" role="tab" aria-selected={activeRole === "teacher"} className={activeRole === "teacher" ? "login-tab active" : "login-tab"} onClick={() => switchRole("teacher")}>教师登录</button>
                </div>
              ) : (
                <>
                  <span className="eyebrow">安全登录</span>
                  <h2>管理端登录</h2>
                  <p className="muted">请输入分配给您的账号信息</p>
                </>
              )}
              <form onSubmit={submit}>
                <label>
                  <span>{copy.account}</span>
                  <div className="input-wrap"><UserRound size={18} /><input value={username} onChange={(event) => setUsername(event.target.value)} placeholder={copy.accountHint} aria-label={copy.account} autoComplete="username" /></div>
                </label>
                <label>
                  <span>密码</span>
                  <div className="input-wrap"><LockKeyhole size={18} /><input type={showPassword ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="请输入密码" aria-label="密码" autoComplete="current-password" /><button type="button" className="icon-button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? "隐藏密码" : "显示密码"}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div>
                </label>
                {error ? <p className="form-error" role="alert">{error}</p> : null}
                <button className="primary-button login-submit" type="submit" disabled={busy}>{busy ? "登录中…" : "登 录"}</button>
                <div className="login-forgot">
                  <button type="button" className="text-button" onClick={() => setHint(activeRole === "student" ? "请联系您的任课教师重置密码。" : "请联系平台管理员重置密码。")}>忘记密码？</button>
                  {hint ? <p className="muted">{hint}</p> : null}
                </div>
              </form>
            </>
          )}
          <div className="security-note"><ShieldCheck size={18} /><span>账号权限由服务端校验，所有关键操作均留存审计记录</span></div>
        </div>
      </section>
    </main>
  );
}
