import {
  BarChart3,
  Bell,
  BookOpenCheck,
  Boxes,
  ChevronDown,
  ClipboardList,
  FileBarChart,
  GraduationCap,
  LayoutDashboard,
  LibraryBig,
  ListChecks,
  Mail,
  Megaphone,
  MessageSquareMore,
  PackageSearch,
  Settings2,
  ShieldCheck,
  Star,
  UserRoundCog,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { UserRole } from "@cecs/contracts";

export interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
}

export const roleNav: Record<UserRole, NavItem[]> = {
  student: [
    { id: "tasks", label: "任务大厅", icon: LayoutDashboard },
    { id: "workbench", label: "客服工作台", icon: MessageSquareMore },
    { id: "orders", label: "订单", icon: PackageSearch },
    { id: "reviews", label: "评价", icon: Star },
    { id: "mail", label: "邮件", icon: Mail },
    { id: "records", label: "我的记录", icon: GraduationCap },
  ],
  teacher: [
    { id: "overview", label: "数据总览", icon: BarChart3 },
    { id: "assignments", label: "实训任务", icon: ClipboardList },
    { id: "classes", label: "班级与学生", icon: UsersRound },
    { id: "notices", label: "通知公告", icon: Megaphone },
    { id: "tracking", label: "实训跟踪", icon: MessageSquareMore },
    { id: "reports", label: "考核报表", icon: FileBarChart },
    { id: "scenarios", label: "场景配置", icon: Boxes },
  ],
  admin: [
    { id: "system", label: "系统总览", icon: LayoutDashboard },
    { id: "providers", label: "AI 与语音服务", icon: Settings2 },
    { id: "accounts", label: "账号与权限", icon: UserRoundCog },
    { id: "content", label: "内容资源库", icon: LibraryBig },
    { id: "backup", label: "数据与备份", icon: ShieldCheck },
  ],
};

const identity: Record<UserRole, { name: string; meta: string; initials: string }> = {
  student: { name: "李明轩", meta: "跨境电商 2301 班", initials: "李" },
  teacher: { name: "王老师", meta: "跨境电商教研组", initials: "王" },
  admin: { name: "系统管理员", meta: "云端运维中心", initials: "管" },
};

export interface ShellNotification {
  id: string;
  title: string;
  content: string;
  time: string;
  unread: boolean;
}

export interface ShellNotificationCenter {
  items: ShellNotification[];
  onOpen: (id: string) => void;
  onReadAll: () => void;
}

function NotificationBell({ center }: { center?: ShellNotificationCenter }) {
  const [open, setOpen] = useState(false);
  const items = center?.items ?? [];
  const unreadCount = items.filter((item) => item.unread).length;
  return (
    <div className="notify-wrap">
      <button
        className="icon-button notification"
        aria-label={unreadCount > 0 ? `消息（${unreadCount} 条未读）` : "消息"}
        onClick={() => setOpen((value) => !value)}
      >
        <Bell size={19} />
        {unreadCount > 0 ? <span>{unreadCount > 99 ? "99+" : unreadCount}</span> : null}
      </button>
      {open ? (
        <>
          <div className="notify-overlay" onClick={() => setOpen(false)} />
          <div className="notify-panel" role="dialog" aria-label="消息中心">
            <div className="notify-head">
              <strong>消息</strong>
              {unreadCount > 0 && center ? (
                <button className="text-button" onClick={() => center.onReadAll()}>全部已读</button>
              ) : null}
            </div>
            <div className="notify-list">
              {items.map((item) => (
                <button
                  key={item.id}
                  className={item.unread ? "notify-item unread" : "notify-item"}
                  onClick={() => {
                    center?.onOpen(item.id);
                    setOpen(false);
                  }}
                >
                  <span className="notify-title">{item.title}<small>{item.time}</small></span>
                  <p>{item.content}</p>
                </button>
              ))}
              {items.length === 0 ? <p className="muted notify-empty">暂无消息。</p> : null}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

export interface ShellAnnouncement {
  id: string;
  title: string;
  content: string;
  publisherName?: string;
  time: string;
  fresh: boolean;
}

/* 学生端顶栏公告条：教师/管理员发布的广播公告，多条自动轮播，点击展开完整列表 */
function TopbarNotice({ items }: { items?: ShellAnnouncement[] }) {
  const list = items ?? [];
  const [cursor, setCursor] = useState(0);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (list.length <= 1 || open) return;
    const timer = window.setInterval(() => setCursor((value) => (value + 1) % list.length), 8000);
    return () => window.clearInterval(timer);
  }, [list.length, open]);
  const current = list.length ? list[cursor % list.length]! : null;
  return (
    <div className="topbar-notice">
      <Megaphone size={15} aria-hidden="true" />
      {current ? (
        <>
          <button
            className="topbar-notice-body"
            onClick={() => setOpen(true)}
            title={`${current.title}：${current.content}`}
          >
            {current.fresh ? <em className="topbar-notice-tag">新</em> : null}
            <strong>{current.title}</strong>
            <span>{current.content}</span>
            <small>{current.time}</small>
          </button>
          {list.length > 1 ? (
            <span className="topbar-notice-count">{(cursor % list.length) + 1}/{list.length}</span>
          ) : null}
          {open ? (
            <>
              <div className="notify-overlay" onClick={() => setOpen(false)} />
              <div className="ann-panel" role="dialog" aria-label="全部公告">
                <div className="notify-head"><strong>公告</strong></div>
                <div className="notify-list">
                  {list.map((item) => (
                    <div key={item.id} className="ann-item">
                      <span className="notify-title">{item.title}<small>{item.time}</small></span>
                      <p>{item.content}</p>
                      {item.publisherName ? <small className="ann-publisher">发布人：{item.publisherName}</small> : null}
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : null}
        </>
      ) : (
        <span className="topbar-notice-empty">暂无公告</span>
      )}
    </div>
  );
}

export function AppShell({ role, active, onNavigate, children, onSignOut, userName, userMeta, notifications, announcements }: { role: UserRole; active: string; onNavigate: (id: string) => void; children: ReactNode; onSignOut?: () => void; userName?: string; userMeta?: string; notifications?: ShellNotificationCenter; announcements?: ShellAnnouncement[] }) {
  const fallback = identity[role];
  const user = {
    name: userName ?? fallback.name,
    meta: userMeta ?? fallback.meta,
    initials: (userName ?? fallback.name).slice(0, 1),
  };
  const navigation = roleNav[role];
  const roleLabel = role === "student" ? "学生端" : role === "teacher" ? "教师端" : "管理端";
  const activeLabel = navigation.find((item) => item.id === active)?.label;
  return (
    <div className="app-frame">
      <aside className="sidebar">
        <div className="brand-lockup">
          <span className="brand-mark">K</span>
          <span><strong>跨境电商客服</strong><small>AI 实训平台</small></span>
        </div>
        <div className="role-chip">{roleLabel}</div>
        <nav aria-label="主导航">
          {navigation.map((item) => {
            const Icon = item.icon;
            return <button key={item.id} className={active === item.id ? "nav-item active" : "nav-item"} onClick={() => onNavigate(item.id)}><Icon size={19} /><span>{item.label}</span>{active === item.id && <i />}</button>;
          })}
        </nav>
        <div className="sidebar-foot">
          <button className="support-link"><BookOpenCheck size={18} /> 使用帮助</button>
          {onSignOut && <button className="support-link" onClick={onSignOut}><ShieldCheck size={18} /> 退出登录</button>}
          <div className="connection-state"><span className="pulse-dot" /> 云端服务已连接</div>
        </div>
      </aside>
      <section className="app-main">
        <header className="topbar">
          {role === "student" ? (
            <TopbarNotice items={announcements} />
          ) : (
            <nav className="topbar-crumb" aria-label="当前位置">
              <span>{roleLabel}</span>
              {activeLabel ? <><i aria-hidden="true">/</i><strong>{activeLabel}</strong></> : null}
            </nav>
          )}
          <div className="top-actions">
            <NotificationBell center={notifications} />
            <button className="profile-button"><span className="avatar small">{user.initials}</span><span><strong>{user.name}</strong><small>{user.meta}</small></span><ChevronDown size={15} /></button>
          </div>
        </header>
        <div className="content-scroll">{children}</div>
      </section>
    </div>
  );
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return <div className="page-header"><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{actions && <div className="page-actions">{actions}</div>}</div>;
}

export function MetricCard({ label, value, suffix, trend, icon: Icon, tone = "blue" }: { label: string; value: string; suffix?: string; trend: string; icon: LucideIcon; tone?: "blue" | "green" | "amber" | "coral" }) {
  return <article className={`metric-card tone-${tone}`}><div className="metric-top"><span>{label}</span><span className="metric-icon"><Icon size={16} /></span></div><strong className="metric-value">{value}<small>{suffix}</small></strong><p>{trend}</p></article>;
}

