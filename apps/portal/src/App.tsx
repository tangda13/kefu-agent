import { useEffect, useMemo, useState } from "react";
import type { UserRole } from "@cecs/contracts";
import { AdminPages } from "./pages/admin/AdminPages";
import { AppShell, roleNav, type ShellNotificationCenter } from "./components/AppShell";
import { LoginScreen } from "./components/LoginScreen";
import { MailStudio } from "./pages/student/MailStudio";
import { LiveMail } from "./pages/student/LiveMail";
import { Orders } from "./pages/student/Orders";
import { LiveOrders, OPEN_ORDER_KEY } from "./pages/student/LiveOrders";
import { LiveReviews } from "./pages/student/LiveReviews";
import { Records } from "./pages/student/Records";
import { LiveRecords } from "./pages/student/LiveRecords";
import { TaskHall } from "./pages/student/TaskHall";
import { Workbench } from "./pages/student/Workbench";
import { LiveWorkbench } from "./pages/student/LiveWorkbench";
import { TeacherPages } from "./pages/teacher/TeacherPages";
import {
  clearSession,
  fetchStudentGuidance,
  loadSession,
  type GuidanceItem,
  type Session,
} from "./api/client";

const GUIDANCE_READ_KEY = "cecs.guidance.read";
export const OPEN_CONVERSATION_KEY = "cecs.openConversation";
export const OPEN_CONVERSATION_EVENT = "cecs:open-conversation";

function loadReadIds(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(GUIDANCE_READ_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function saveReadIds(ids: Set<string>): void {
  localStorage.setItem(GUIDANCE_READ_KEY, JSON.stringify([...ids].slice(-200)));
}

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
  const [readIds, setReadIds] = useState<Set<string>>(loadReadIds);
  const studentLive = !demo && signedIn && session !== null && role === "student";
  useEffect(() => {
    if (!studentLive || !session) return;
    const load = () => fetchStudentGuidance(session).then(setGuidance).catch(() => undefined);
    load();
    const timer = window.setInterval(load, 20_000);
    return () => window.clearInterval(timer);
  }, [studentLive, session]);

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
        setReadIds((prev) => {
          const next = new Set(prev);
          next.add(id);
          saveReadIds(next);
          return next;
        });
        const item = guidance.find((entry) => entry.id === id);
        if (item) {
          sessionStorage.setItem(OPEN_CONVERSATION_KEY, item.conversationId);
          setActive("workbench");
          window.dispatchEvent(new CustomEvent(OPEN_CONVERSATION_EVENT));
        }
      },
      onReadAll: () => {
        setReadIds(() => {
          const next = new Set(guidance.map((entry) => entry.id));
          saveReadIds(next);
          return next;
        });
      },
    };
  }, [studentLive, guidance, readIds]);

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
      {role === "teacher" && <TeacherPages page={active} session={session} />}
      {role === "admin" && <AdminPages page={active} session={session} />}
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
  if (active === "records") return session ? <LiveRecords session={session} /> : <Records />;
  return (
    <TaskHall
      onStart={(taskId) => {
        setStartTaskId(taskId ?? null);
        onNavigate("workbench");
      }}
      session={session}
    />
  );
}
