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
  MessageSquareMore,
  PackageSearch,
  Settings2,
  ShieldCheck,
  Star,
  UserRoundCog,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
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

export function AppShell({ role, active, onNavigate, children, onSignOut, userName, userMeta, notifications }: { role: UserRole; active: string; onNavigate: (id: string) => void; children: ReactNode; onSignOut?: () => void; userName?: string; userMeta?: string; notifications?: ShellNotificationCenter }) {
  const fallback = identity[role];
  const user = {
    name: userName ?? fallback.name,
    meta: userMeta ?? fallback.meta,
    initials: (userName ?? fallback.name).slice(0, 1),
  };
  const navigation = roleNav[role];
  return (
    <div className="app-frame">
      <aside className="sidebar">
        <div className="brand-lockup">
          <span className="brand-mark">K</span>
          <span><strong>跨境电商客服</strong><small>AI 实训平台</small></span>
        </div>
        <div className="role-chip">{role === "student" ? "学生端" : role === "teacher" ? "教师端" : "管理端"}</div>
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
  return <article className={`metric-card tone-${tone}`}><div className="metric-top"><span className="metric-icon"><Icon size={19} /></span><span className="mini-chart" aria-hidden="true"><i /><i /><i /><i /><i /></span></div><div><strong>{value}<small>{suffix}</small></strong><span>{label}</span></div><p>{trend}</p></article>;
}

