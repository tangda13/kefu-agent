import { useEffect, useMemo, useState } from "react";
import type { UserRole } from "@cecs/contracts";
import { AdminPages } from "./pages/admin/AdminPages";
import { AppShell, roleNav, type ShellAnnouncement, type ShellNotificationCenter } from "./components/AppShell";
import { LoginScreen } from "./components/LoginScreen";
import { MailStudio } from "./pages/student/MailStudio";
import { LiveMail, MAIL_COMPOSE_KEY, MAIL_TASK_KEY, buyerMailPreset, countUnreadMail } from "./pages/student/LiveMail";
import { Orders } from "./pages/student/Orders";
import { LiveOrders, OPEN_ORDER_KEY } from "./pages/student/LiveOrders";
import { LiveReviews } from "./pages/student/LiveReviews";
import { Records } from "./pages/student/Records";
import { LiveRecords, RECORD_TASK_KEY } from "./pages/student/LiveRecords";
import { TaskHall } from "./pages/student/TaskHall";
import { Workbench } from "./pages/student/Workbench";
import { LiveWorkbench } from "./pages/student/LiveWorkbench";
import { TeacherPages } from "./pages/teacher/TeacherPages";
import { openProvidersTab } from "./pages/admin/providersTab";
import { Button } from "./ui";
import {
  clearSession,
  fetchAdminAlerts,
  type AdminAlert,
  fetchStudentAnnouncements,
  apiGet,
  fetchReadMarks,
  fetchStudentGuidance,
  migrateLocalOnce,
  saveReadMarks,
  loadSession,
  type GuidanceItem,
  type Session,
  type StudentAnnouncement, saveSession,
  fetchStoreProfile,
  type ConversationSummary,
  type StoreProfile,
  } from "./api/client";

/** 旧版本的指导已读状态存在本机（且不分账号），首次进入时迁到云端（K4） */
const LEGACY_GUIDANCE_READ_KEY = "cecs.guidance.read";
export const OPEN_CONVERSATION_KEY = "cecs.openConversation";
export const OPEN_CONVERSATION_EVENT = "cecs:open-conversation";

// role 参数仅用于管理端入口（?role=admin）与登录页签预选；
// 学生/教师共用同一客户端，缺省进入「学生登录/教师登录」页签（学生优先）。
function readRole(): UserRole {
  const value = new URLSearchParams(window.location.search).get("role");
  return value === "teacher" || value === "admin" ? value : "student";
}

export function App() {
  const requestedRole = useMemo(readRole, []);
  const params = new URLSearchParams(window.location.search);
  const demo = params.get("demo") === "1";
  const [session, setSession] = useState<Session | null>(() =>
    demo ? null : loadSession(),
  );

  // demo=1 仅用于界面预览；真实会话以服务端返回的角色为准。
  const role: UserRole = demo ? requestedRole : session?.user.role ?? requestedRole;
  const requestedPage = params.get("page");
  const initialPage = roleNav[role].some((item) => item.id === requestedPage)
    ? requestedPage!
    : roleNav[role][0]!.id;
  const [signedIn, setSignedIn] = useState(demo || session !== null);
  const [active, setActive] = useState(initialPage);

  // 教师指导通知：学生端顶栏「消息」轮询（不进入会话消息流）
  const [guidance, setGuidance] = useState<GuidanceItem[]>([]);
  const [readIds, setReadIds] = useState<Set<string>>(new Set());
  const studentLive = !demo && signedIn && session !== null && role === "student";
  useEffect(() => {
    if (!studentLive || !session) return;
    void migrateLocalOnce<string[]>(LEGACY_GUIDANCE_READ_KEY, (ids) => saveReadMarks(session, "guidance", ids.slice(-500)))
      .then(() => fetchReadMarks(session, "guidance"))
      .then((ids) => setReadIds(new Set(ids)))
      .catch(() => undefined);
  }, [studentLive, session]);
  useEffect(() => {
    if (!studentLive || !session) return;
    const load = () => fetchStudentGuidance(session).then(setGuidance).catch(() => undefined);
    load();
    const timer = window.setInterval(load, 20_000);
    return () => window.clearInterval(timer);
  }, [studentLive, session]);

  // 公告：教师/管理员发布的广播（与铃铛"消息"分流），学生端顶栏轮播，60 秒轮询
  const [announcementItems, setAnnouncementItems] = useState<StudentAnnouncement[]>([]);
  useEffect(() => {
    if (!studentLive || !session) return;
    // 顶栏会轮播所有有效公告，拿到即视为看到：记已读，教师端公告列表据此统计“已读 N / 班级人数”
    const load = () => fetchStudentAnnouncements(session).then((items) => {
      setAnnouncementItems(items);
      if (items.length) void saveReadMarks(session, "notice", items.map((item) => item.id)).catch(() => undefined);
    }).catch(() => undefined);
    load();
    const timer = window.setInterval(load, 60_000);
    return () => window.clearInterval(timer);
  }, [studentLive, session]);

  const announcements = useMemo<ShellAnnouncement[] | undefined>(() => {
    if (!studentLive) return undefined;
    return announcementItems.map((item) => ({
      id: item.id,
      title: item.title,
      content: item.content,
      publisherName: item.publisherName,
      time: new Date(item.createdAt).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }),
      fresh: Date.now() - new Date(item.createdAt).getTime() < 48 * 3600_000,
    }));
  }, [studentLive, announcementItems]);

  const notifications = useMemo<ShellNotificationCenter | undefined>(() => {
    if (!studentLive) return undefined;
    return {
      items: guidance.map((item) => ({
        id: item.id,
        title: `教师指导 · ${item.buyerName}`,
        content: item.content,
        time: new Date(item.createdAt).toLocaleString("zh-CN", {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        }),
        unread: !readIds.has(item.id),
      })),
      onOpen: (id) => {
        setReadIds((prev) => new Set(prev).add(id));
        if (session) void saveReadMarks(session, "guidance", [id]).catch(() => undefined);
        const item = guidance.find((entry) => entry.id === id);
        if (item) {
          sessionStorage.setItem(OPEN_CONVERSATION_KEY, item.conversationId);
          setActive("workbench");
          window.dispatchEvent(new CustomEvent(OPEN_CONVERSATION_EVENT));
        }
      },
      onReadAll: () => {
        const ids = guidance.map((entry) => entry.id);
        setReadIds((prev) => new Set([...prev, ...ids]));
        if (session) void saveReadMarks(session, "guidance", ids).catch(() => undefined);
      },
    };
  }, [studentLive, session, guidance, readIds]);

  /** 页面内跳转（工作台“查看复盘”“发邮件跟进”）：页面派发 cecs:navigate，外壳切页 */
  useEffect(() => {
    const onNavigate = (event: Event) => {
      const page = (event as CustomEvent<{ page?: string }>).detail?.page;
      if (page && roleNav[role].some((item) => item.id === page)) setActive(page);
    };
    window.addEventListener("cecs:navigate", onNavigate);
    return () => window.removeEventListener("cecs:navigate", onNavigate);
  }, [role]);

  /** 学生端：店铺资料（侧栏分组标题）+ 店铺后台角标：买家在等的会话、未读邮件（D-37），30 秒刷新。评价不挂角标：平台没有“必须回复评价”的逻辑 */
  const [store, setStore] = useState<StoreProfile | null>(null);
  const [studentBadges, setStudentBadges] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!studentLive || !session) return;
    void fetchStoreProfile(session).then(setStore).catch(() => undefined);
    const load = () => {
      void apiGet<ConversationSummary[]>("/v1/conversations", session)
        .then((rows) => setStudentBadges((prev) => ({ ...prev, workbench: rows.filter((row) => row.unreplied).length })))
        .catch(() => undefined);
      void countUnreadMail(session)
        .then((count) => setStudentBadges((prev) => ({ ...prev, mail: count })))
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 30_000);
    return () => window.clearInterval(timer);
    // 切页时刷新：读完邮件、回完评价后角标马上变
  }, [studentLive, session, active]);

  /** 教师端侧栏角标：需介入的会话数（买家等 3 分钟以上或满意度低于 40，D-64），30 秒刷新（D-27） */
  const [teacherWaiting, setTeacherWaiting] = useState(0);
  const teacherLive = signedIn && !demo && role === "teacher" && session !== null;
  useEffect(() => {
    if (!teacherLive || !session) {
      setTeacherWaiting(0);
      return;
    }
    const load = () => void apiGet<Array<{ alert: boolean }>>("/v1/teacher/tracking", session).then((rows) => setTeacherWaiting(rows.filter((row) => row.alert).length)).catch(() => undefined);
    load();
    const timer = window.setInterval(load, 30_000);
    return () => window.clearInterval(timer);
  }, [teacherLive, session]);

  /** 管理端顶栏常驻提醒（E5）：额度、模型失败、备份过期等，每 5 分钟和切换页面时刷新 */
  const [adminAlerts, setAdminAlerts] = useState<AdminAlert[]>([]);
  const adminLive = signedIn && !demo && role === "admin" && session !== null;
  useEffect(() => {
    if (!adminLive || !session) {
      setAdminAlerts([]);
      return;
    }
    const load = () => void fetchAdminAlerts(session).then(setAdminAlerts).catch(() => undefined);
    load();
    const timer = window.setInterval(load, 5 * 60_000);
    return () => window.clearInterval(timer);
  }, [adminLive, session, active]);
  const topAlert = adminAlerts[0];
  const adminBanner =
    topAlert && active !== "system" && !(adminAlerts.length === 1 && topAlert.page === active) ? (
      <div className={adminAlerts.some((item) => item.level === "danger") ? "shell-banner is-danger" : "shell-banner"} role="status">
        <strong>{topAlert.title}</strong>
        {adminAlerts.length > 1 ? <span>等 {adminAlerts.length} 项需要处理</span> : <span>{topAlert.detail}</span>}
        <Button size="sm" onClick={() => { if (adminAlerts.length === 1) openProvidersTab(topAlert.tab); setActive(adminAlerts.length > 1 ? "system" : topAlert.page); }}>{adminAlerts.length > 1 ? "查看全部" : "去处理"}</Button>
      </div>
    ) : null;

  if (!signedIn) {
    return (
      <LoginScreen
        initialRole={requestedRole}
        onLogin={(next) => {
          setSession(next);
          setActive(roleNav[next.user.role][0]!.id);
          setSignedIn(true);
        }}
      />
    );
  }

  return (
    <AppShell
      role={role}
      active={active}
      onNavigate={setActive}
      userName={session?.user.displayName}
      userMeta={session?.user.username}
      notifications={notifications}
      announcements={announcements}
      banner={adminBanner}
      badges={role === "student" ? studentBadges : teacherWaiting ? { tracking: teacherWaiting } : undefined}
      store={role === "student" ? store : undefined}
      session={demo ? null : session}
      onSessionChange={(next) => { saveSession(next); setSession(next); }}
      onSignOut={
        demo
          ? undefined
          : () => {
              clearSession();
              setSession(null);
              setSignedIn(false);
            }
      }
    >
      {role === "student" && (
        <StudentPage active={active} onNavigate={setActive} session={session} />
      )}
      {role === "teacher" && <TeacherPages page={active} session={session} onNavigate={setActive} />}
      {role === "admin" && <AdminPages page={active} session={session} onNavigate={setActive} />}
    </AppShell>
  );
}

function StudentPage({
  active,
  onNavigate,
  session,
}: {
  active: string;
  onNavigate: (id: string) => void;
  session: Session | null;
}) {
  const [startTaskId, setStartTaskId] = useState<string | null>(null);
  if (active === "workbench") {
    return session ? (
      <LiveWorkbench session={session} initialTaskId={startTaskId} />
    ) : (
      <Workbench />
    );
  }
  if (active === "orders") return session ? <LiveOrders session={session} /> : <Orders />;
  if (active === "reviews") {
    return session ? (
      <LiveReviews
        session={session}
        onMailBuyer={(record) => {
          sessionStorage.setItem(MAIL_COMPOSE_KEY, buyerMailPreset(record.buyer.name, { id: record.orderId, orderNo: record.orderNo }));
          onNavigate("mail");
        }}
        onOpenOrder={(orderId) => {
          sessionStorage.setItem(OPEN_ORDER_KEY, orderId);
          onNavigate("orders");
        }}
      />
    ) : (
      <Orders />
    );
  }
  if (active === "mail") {
    return session ? (
      <LiveMail
        session={session}
        onOpenOrder={(orderId) => {
          sessionStorage.setItem(OPEN_ORDER_KEY, orderId);
          onNavigate("orders");
        }}
      />
    ) : (
      <MailStudio />
    );
  }
  if (active === "records") return session ? <LiveRecords session={session} onOpenHall={() => onNavigate("tasks")} /> : <Records />;
  return (
    <TaskHall
      onStart={(taskId) => {
        setStartTaskId(taskId ?? null);
        onNavigate("workbench");
      }}
      onWriteMail={(taskId, scenarioId) => {
        sessionStorage.setItem(MAIL_TASK_KEY, JSON.stringify({ taskId, scenarioId }));
        onNavigate("mail");
      }}
      onOpenRecords={(taskId) => {
        if (taskId) sessionStorage.setItem(RECORD_TASK_KEY, taskId);
        onNavigate("records");
      }}
      session={session}
    />
  );
}
