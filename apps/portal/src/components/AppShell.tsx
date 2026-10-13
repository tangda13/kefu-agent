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
  LogOut,
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
import { BrandMark, useBrand } from "../brand";
import { ShellSlotContext } from "../ui";
import type { Session } from "../api/client";
import { PasswordDialog, ProfileDialog, ProfileMenuItems, UserAvatar } from "./AccountCenter";

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

/** banner：顶栏下方的常驻提醒（如管理端额度告警），没有时不占位 */
export function AppShell({ role, active, onNavigate, children, onSignOut, userName, userMeta, notifications, announcements, banner, badges, session, onSessionChange }: { role: UserRole; active: string; onNavigate: (id: string) => void; children: ReactNode; onSignOut?: () => void; userName?: string; userMeta?: string; notifications?: ShellNotificationCenter; announcements?: ShellAnnouncement[]; banner?: ReactNode; badges?: Record<string, number>; /** 个人中心（查看资料、改姓名、改密码）需要当前会话；演示模式不传 */ session?: Session | null; onSessionChange?: (next: Session) => void }) {
  const { brand } = useBrand();
  const fallback = identity[role];
  const name = userName ?? fallback.name;
  const meta = userMeta ?? fallback.meta;
  const navigation = roleNav[role];
  const activeLabel = navigation.find((item) => item.id === active)?.label ?? "";
  // 顶栏里给页面放页签的位置（HeaderTabs 渲染到这里）
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <div className="shell">
      <aside className="shell-side">
        <div className="shell-brand" title={brand.name}>
          <BrandMark size={24} />
          <strong>{brand.name}</strong>
        </div>
        <nav className="shell-nav" aria-label="主导航">
          {navigation.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} type="button" className={active === item.id ? "is-active" : undefined} aria-current={active === item.id ? "page" : undefined} onClick={() => onNavigate(item.id)}>
                <Icon size={18} />
                <span>{item.label}</span>
                {badges?.[item.id] ? <em className="shell-nav-badge">{badges[item.id]}</em> : null}
              </button>
            );
          })}
        </nav>
        <div className="shell-side-foot">
          <button type="button"><BookOpenCheck size={18} /><span>使用帮助</span></button>
        </div>
      </aside>
      <section className="shell-main">
        <header className="shell-top">
          <h1 className="shell-title">{activeLabel}</h1>
          <div className="shell-head-slot" ref={setSlot} />
          {role === "student" ? <TopbarNotice items={announcements} /> : <span className="shell-top-fill" />}
          <div className="shell-top-actions">
            <NotificationBell center={notifications} />
            <ProfileMenu name={name} meta={meta} role={role} onSignOut={onSignOut} session={session ?? null} onSessionChange={onSessionChange} />
          </div>
        </header>
        {banner}
        <ShellSlotContext.Provider value={slot}>
          <div className="content-scroll">{children}</div>
        </ShellSlotContext.Provider>
      </section>
    </div>
  );
}

const ROLE_NAMES: Record<UserRole, string> = { student: "学生", teacher: "教师", admin: "管理员" };

function ProfileMenu({ name, meta, role, onSignOut, session, onSessionChange }: {
  name: string; meta: string; role: UserRole; onSignOut?: () => void; session: Session | null; onSessionChange?: (next: Session) => void;
}) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<"profile" | "password" | null>(null);
  const canEdit = Boolean(session && onSessionChange);
  const pick = (next: "profile" | "password") => { setOpen(false); setDialog(next); };
  return (
    <div className="shell-profile">
      <button type="button" className="shell-profile-btn" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <UserAvatar name={name} url={session?.user.avatarUrl} size={28} />
        <span>{name}</span>
        <ChevronDown size={14} />
      </button>
      {open ? (
        <>
          <div className="notify-overlay" onClick={() => setOpen(false)} />
          <div className="ui-menu-pop shell-profile-pop" role="menu">
            <ProfileMenuItems name={name} meta={meta} roleLabel={ROLE_NAMES[role]} avatarUrl={session?.user.avatarUrl}
              onProfile={canEdit ? () => pick("profile") : undefined}
              onPassword={canEdit ? () => pick("password") : undefined}
              onSignOut={onSignOut ? () => { setOpen(false); onSignOut(); } : undefined} />
          </div>
        </>
      ) : null}
      {dialog === "profile" && session && onSessionChange ? (
        <ProfileDialog session={session} onClose={() => setDialog(null)} onSessionChange={onSessionChange} onChangePassword={() => setDialog("password")} />
      ) : null}
      {dialog === "password" && session && onSessionChange ? (
        <PasswordDialog session={session} onClose={() => setDialog(null)} onSessionChange={onSessionChange} />
      ) : null}
    </div>
  );
}

/** 页面工具栏：页名已在顶栏，这里只放页面级操作。旧版的英文眉标、大标题和说明不再显示（P3 去 AI 味）。 */
export function PageHeader({ actions }: { eyebrow?: string; title?: string; description?: string; actions?: ReactNode }) {
  if (!actions) return null;
  return <div className="page-toolbar">{actions}</div>;
}

/** 指标：多个 MetricCard 放在 .metric-grid 里时，样式上拼成一条统计条（DESIGN.md 第 6 节） */
export function MetricCard({ label, value, suffix, trend }: { label: string; value: string; suffix?: string; trend?: string; icon?: LucideIcon; tone?: "blue" | "green" | "amber" | "coral" }) {
  const empty = value === "" || value === "—" || value === "-";
  return (
    <article className="metric-card">
      <span className="metric-label">{label}</span>
      <span className="metric-line">
        <strong className={empty ? "metric-value is-empty" : "metric-value"}>{empty ? "暂无" : value}{!empty && suffix ? <small>{suffix}</small> : null}</strong>
        {trend ? <small className="metric-trend">{trend}</small> : null}
      </span>
    </article>
  );
}
