import type { CouponKind, OrderKind, ProductDetails, ProductSource } from "@cecs/contracts";
// 生产部署走 nginx 同域反代时设 VITE_API_URL 为空字符串（API_BASE="" → 相对路径 /v1/...）；
// 未设置则回退本地开发地址。显式空串不等于 undefined，故不用 ?? 而显式判 undefined。
const apiUrl = (import.meta as { env?: Record<string, string> }).env?.VITE_API_URL;
export const API_BASE =
  apiUrl === undefined ? "http://127.0.0.1:8787" : apiUrl.replace(/\/+$/, "");

/** 拼接服务端相对资源地址（如商品主图 /uploads/...） */
export function assetUrl(pathname: string | null | undefined): string | null {
  if (!pathname) return null;
  return pathname.startsWith("http") ? pathname : `${API_BASE}${pathname}`;
}

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  role: "student" | "teacher" | "admin";
  classId: string | null;
  mustChangePassword: boolean;
  /** 头像（/uploads/avatars/...），没上传时为空，显示姓名首字 */
  avatarUrl?: string | null;
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  user: SessionUser;
}

export interface StudentTask {
  id: string;
  name: string;
  businessStage: "pre_sale" | "in_sale" | "after_sale" | "customer_care";
  scenarioIds: string[];
  scenarioNames: string[];
  /** 场景 id→name 明细（与 scenarioIds 对应，用于工作台按场景接入）；channel=mail 的是邮件任务（D-58），在邮件页写信 */
  scenarios: Array<{ id: string; name: string; channel?: "chat" | "mail" }>;
  interactionMode: string;
  timeLimitMinutes: number | null;
  startAt: string | null;
  deadline: string | null;
  scoringWeights: Record<string, number>;
  progressStatus: "todo" | "in_progress" | "done";
  score: number | null;
  /** 完成标准：all_scenarios 每场景至少一次 / conversation_count 完成 N 次会话 */
  completionRule: "all_scenarios" | "conversation_count";
  requiredCount: number | null;
  /** 达标分数线（空 = 不设线，完成即达标） */
  passScore: number | null;
  /** 接待节奏：sequential 依次进线 / interval 每 N 分钟进线一位 / all_at_once 全部同时进线 */
  arrivalMode: "sequential" | "interval" | "all_at_once";
  arrivalIntervalMinutes: number | null;
  /** 完成进度：已完成 progressDone / 需完成 requiredTotal */
  progressDone: number;
  requiredTotal: number;
  /** 该任务下已创建的会话总数（含进行中/已结束；自动进线的止流依据） */
  conversationCount: number;
  /** 已开过会话的场景 id（工作台据此列出待接入的场景） */
  startedScenarioIds: Array<string | null>;
  /** 完成后按分数线判定；未完成为 null */
  qualified: boolean | null;
  /** 定时开放：未到开始时间，学生可见但不可进入 */
  locked: boolean;
  createdAt: string;
  /** 已完成任务：最后一次评分时间 */
  completedAt: string | null;
  /** 已完成任务：评分均经老师复核 */
  reviewed: boolean;
  teacherName: string | null;
}

const SESSION_KEY = "cecs.session";

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function saveSession(session: Session): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** 服务端返回的完整错误体（如 ROLE_MISMATCH 带 actualRole） */
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function parseError(response: Response): Promise<never> {
  let code = "UNKNOWN";
  let message = `请求失败（${response.status}）`;
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) ?? {};
    if (typeof body.code === "string") code = body.code;
    if (typeof body.message === "string") message = body.message;
  } catch {
    /* keep defaults */
  }
  throw new ApiError(response.status, code, message, body);
}

/** expectedRole：登录页签对应的角色，与账号不符时服务端拒绝并返回 ROLE_MISMATCH（不签发令牌） */
export async function login(
  username: string,
  password: string,
  expectedRole?: SessionUser["role"],
): Promise<Session> {
  const response = await fetch(`${API_BASE}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password, expectedRole }),
  });
  if (!response.ok) await parseError(response);
  const session = (await response.json()) as Session;
  saveSession(session);
  return session;
}

export async function changePassword(
  session: Session,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const response = await authFetch(session, `${API_BASE}/v1/auth/change-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  if (!response.ok) await parseError(response);
}

/* 令牌续期：访问令牌 15 分钟过期，刷新令牌用一次就作废（服务端轮换）。
   页面各处拿着的 session 是登录时那一份，续期后的新令牌只存本机、不推进 React 状态（推进会让依赖 session 的数据全部重载），
   所以发请求一律按本机存的最新令牌发；同一时刻只续一次，几个请求同时 401 时共用这次结果，不拿作废的刷新令牌再去换。 */

const expiredListeners = new Set<(message: string) => void>();

/** 登录真的失效（刷新令牌过期、被吊销、账号停用）时通知外壳回登录页，message 显示在登录页上 */
export function onSessionExpired(listener: (message: string) => void): () => void {
  expiredListeners.add(listener);
  return () => expiredListeners.delete(listener);
}

/** 清掉这份登录并通知外壳；本机已经换成另一份登录（别处续过期、退出后重新登录）时不动它 */
function expireSession(session: Session, message: string): void {
  if (loadSession()?.refreshToken !== session.refreshToken) return;
  clearSession();
  for (const listener of expiredListeners) listener(message);
}

/** 同一账号以本机存的为准：续期后令牌已换新，手里这份可能是旧的 */
function latestSession(session: Session): Session {
  const stored = loadSession();
  return stored && stored.user.id === session.user.id ? stored : session;
}

let refreshing: Promise<Session | null> | null = null;

async function refreshSession(session: Session): Promise<Session | null> {
  // 断网照常抛出（显示“连不上服务器”），服务器 5xx 也不清登录：只有服务端明确说刷新令牌不行了才算登录失效
  const response = await fetch(`${API_BASE}/v1/auth/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: session.refreshToken }),
  });
  if (response.status === 400 || response.status === 401) {
    // 别处已经拿这张刷新令牌续过了：用那份新的
    const stored = loadSession();
    if (stored && stored.user.id === session.user.id && stored.refreshToken !== session.refreshToken) return stored;
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    expireSession(session, body.message ?? "登录已过期，请重新登录。");
    return null;
  }
  if (!response.ok) throw new ApiError(response.status, "REFRESH_UNAVAILABLE", "服务器暂时不可用，请稍后重试。");
  const next = (await response.json()) as Session;
  saveSession(next);
  return next;
}

function renewSession(session: Session): Promise<Session | null> {
  refreshing ??= refreshSession(session).finally(() => { refreshing = null; });
  return refreshing;
}

/** 带登录的请求：按最新令牌发，401 时续期一次再重发（鉴权在接口处理之前，重发不会重复执行） */
async function authFetch(session: Session, url: string, init: RequestInit = {}): Promise<Response> {
  const send = (token: string) =>
    fetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` } });
  const used = latestSession(session);
  const response = await send(used.accessToken);
  if (response.status !== 401) return response;
  // 只有“令牌无效”才续期；当前密码错误这类 401 原样交回，账号被停用直接回登录页
  const { code, message } = ((await response.clone().json().catch(() => ({}))) ?? {}) as { code?: string; message?: string };
  if (code === "ACCOUNT_DISABLED") expireSession(used, message ?? "账号已停用，请联系教师或管理员。");
  if (code !== "UNAUTHORIZED") return response;
  // 等响应期间别的请求可能已经续好了，直接用新的
  const current = latestSession(session);
  const renewed = current.accessToken !== used.accessToken ? current : await renewSession(current);
  return renewed ? send(renewed.accessToken) : response;
}

async function apiRequest<T>(
  method: string,
  path: string,
  session: Session,
  body?: unknown,
): Promise<T> {
  const response = await authFetch(session, `${API_BASE}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) await parseError(response);
  return (await response.json()) as T;
}

export function apiGet<T>(path: string, session: Session): Promise<T> {
  return apiRequest<T>("GET", path, session);
}

export function apiPost<T>(
  path: string,
  session: Session,
  body?: unknown,
): Promise<T> {
  return apiRequest<T>("POST", path, session, body);
}

export function apiRequestPatch<T = { ok: boolean }>(
  path: string,
  session: Session,
  body?: unknown,
): Promise<T> {
  return apiRequest<T>("PATCH", path, session, body);
}

export function apiRequestDelete<T = { ok: boolean }>(
  path: string,
  session: Session,
): Promise<T> {
  return apiRequest<T>("DELETE", path, session);
}

export function fetchStudentTasks(session: Session): Promise<StudentTask[]> {
  return apiGet<StudentTask[]>("/v1/student/tasks", session);
}

// ---------- 教师端 ----------

export interface ClassSummary {
  id: string;
  name: string;
  headTeacherId: string | null;
  headTeacherName: string | null;
  /** 授权任课教师（不含班主任） */
  teachers: Array<{ id: string; displayName: string }>;
  studentCount: number;
  /** 待改密的账号数（D-35 班级清单角标） */
  pendingPasswordCount?: number;
  createdAt: string;
}

export interface ClassStudent {
  id: string;
  username: string;
  displayName: string;
  status: "active" | "disabled";
  mustChangePassword: boolean;
  createdAt: string;
  /** 班内分组，null = 未分组 */
  groupName: string | null;
  tasksTotal: number;
  tasksDone: number;
  /** 任务口径平均分，没有成绩时为 null */
  averageScore: number | null;
  /** 最近一次发消息的时间 */
  lastActiveAt: string | null;
}

export interface ImportResult {
  created: Array<{ username: string; displayName: string; initialPassword?: string }>;
  failed: Array<{ username: string; reason: string }>;
}

export interface ScenarioSummary {
  id: string;
  name: string;
  stage: "pre_sale" | "in_sale" | "after_sale" | "customer_care";
  objective: string;
  defaultLanguage: string;
  enabled: boolean;
  /** D-32：沟通方式（在线会话 / 邮件）与开会话时生成的订单状态（null = 按业务环节默认） */
  channel?: "chat" | "mail";
  orderKind?: OrderKind | null;
  /** D-33：适用客户价值层，新建任务时预选人群范围；空 = 不限 */
  customerTypes?: string[];
  /** 场景剧本（J5）：买家目标、隐藏信息、情绪触发点、让步底线、结束条件 */
  script: Partial<Record<"buyerGoal" | "hiddenInfo" | "emotionTriggers" | "bottomLine" | "endConditions", string>> | null;
  /** 被几个未关闭的任务使用（场景卡片显示影响面） */
  taskCount?: number;
}

export interface TeacherTask {
  id: string;
  name: string;
  businessStage: "pre_sale" | "in_sale" | "after_sale" | "customer_care";
  scenarioIds: string[];
  interactionMode: string;
  timeLimitMinutes: number | null;
  startAt: string | null;
  deadline: string | null;
  scoringWeights: Record<string, number>;
  status: string;
  /** 完成标准：all_scenarios 每场景至少一次 / conversation_count 完成 N 次会话；passScore 空 = 不设线 */
  completionRule: "all_scenarios" | "conversation_count";
  requiredCount: number | null;
  passScore: number | null;
  /** 接待节奏（买家自动进线策略） */
  arrivalMode: "sequential" | "interval" | "all_at_once";
  arrivalIntervalMinutes: number | null;
  /** 买家画像随机规则（空对象 = 完全随机） */
  personaRule?: Record<string, string[] | undefined>;
  classes: Array<{ id: string; name: string }>;
  studentTotal: number;
  studentDone: number;
  /** 已出成绩学生的任务平均分，没有成绩时为 null */
  averageScore: number | null;
  createdAt: string;
}

export interface CreateTaskPayload {
  name: string;
  businessStage: string;
  scenarioIds: string[];
  classIds: string[];
  personaRule?: Record<string, unknown>;
  interactionMode: string;
  timeLimitMinutes?: number;
  startAt?: string;
  deadline?: string;
  scoringWeights: Record<string, number>;
  completionRule?: "all_scenarios" | "conversation_count";
  requiredCount?: number | null;
  passScore?: number | null;
  arrivalMode?: "sequential" | "interval" | "all_at_once";
  arrivalIntervalMinutes?: number | null;
}

export const fetchClasses = (session: Session) =>
  apiGet<ClassSummary[]>("/v1/classes", session);
export const createClass = (session: Session, name: string) =>
  apiPost<ClassSummary>("/v1/classes", session, { name });
/** 学生详情里的参训任务（D-63）：完成状态、任务成绩、有没有接待记录 */
export interface StudentTaskItem {
  id: string;
  name: string;
  businessStage: "pre_sale" | "in_sale" | "after_sale" | "customer_care";
  taskStatus: string;
  startAt: string | null;
  deadline: string | null;
  progress: "todo" | "in_progress" | "done";
  score: number | null;
  conversations: number;
}

export const fetchStudentTaskList = (session: Session, studentId: string) =>
  apiGet<StudentTaskItem[]>(`/v1/students/${studentId}/tasks`, session);

export const fetchClassStudents = (session: Session, classId: string) =>
  apiGet<ClassStudent[]>(`/v1/classes/${classId}/students`, session);
export const setStudentGroup = (session: Session, classId: string, studentIds: string[], groupName: string | null) =>
  apiRequestPut<{ updated: number }>(`/v1/classes/${classId}/groups`, session, { studentIds, groupName });
export const importStudents = (
  session: Session,
  classId: string,
  students: Array<{ username: string; displayName: string; password?: string }>,
) =>
  apiPost<ImportResult>(`/v1/classes/${classId}/students/import`, session, {
    students,
  });
export const resetStudentPassword = (session: Session, studentId: string) =>
  apiPost<{ temporaryPassword: string }>(
    `/v1/students/${studentId}/reset-password`,
    session,
  );
export const fetchScenarios = (session: Session) =>
  apiGet<ScenarioSummary[]>("/v1/catalog/scenarios", session);

// ---------- 实训会话 ----------

export interface BuyerPublicView {
  id: string;
  name: string;
  nationality: string;
  identity: string;
  language: string;
  customerType: string;
  avatarUrl: string | null;
  /** 头像类型：default 灰色剪影 / initial 首字母 / photo 生活照 / object 非人脸；缺省按有无 avatarUrl 判断 */
  avatarKind?: "default" | "initial" | "photo" | "object";
}

export interface OrderLogisticsNode {
  key: string;
  label: string;
  at: string | null;
  done: boolean;
  current: boolean;
}

export interface OrderAddress {
  recipient: string;
  line1: string;
  city: string;
  country: string;
  phone: string;
}

export interface OrderInfo {
  orderNo: string;
  productName: string;
  productSpec: string;
  productImage?: string | null;
  quantity: number;
  unitPrice: number;
  currency: string;
  totalAmount: number;
  status: string;
  statusLabel: string;
  placedAt: string;
  logistics: { carrier: string; trackingNo: string; nodes: OrderLogisticsNode[] } | null;
  review: {
    rating: number;
    content: string;
    at: string;
    /** 闭环改评：买家在服务挽回成功后修改过评价 */
    revised?: boolean;
    original?: { rating?: number; content?: string; at?: string };
  } | null;
  address?: OrderAddress | null;
  remark?: string | null;
  returnStatus?: "requested" | "returning" | "refunded" | null;
}

export interface ConversationOrder {
  id: string;
  isPrimary: boolean;
  detail: OrderInfo;
}

export interface ConversationSummary {
  id: string;
  taskId: string | null;
  scenarioId?: string | null;
  scenario?: { id: string; name: string; objective: string; stage?: string } | null;
  buyer: BuyerPublicView;
  order: OrderInfo | null;
  status?: string;
  lastMessage?: { content: string; sender: string; createdAt: string } | null;
  unreplied?: boolean;
  visits72h?: number;
  createdAt: string;
  /** 系统客户标签（按订单规则计算，只读）：粉丝 / 大订单客户 / 普通客户 / 沉睡客户 / 新客 */
  customerTags?: CustomerTag[];
  orderStats?: { count: number; total: number; lastPlacedAt: string | null };
  /** 客服标记（C2）：待跟进、客户备注。咨询类型 D-68 起不在工作台显示，库里的 contact_reason 列保留 */
  followUp?: boolean;
  buyerNote?: string | null;
  buyerNoteAt?: string | null;
  closedReason?: string | null;
  /** 第一次结束的时间：聊天里“客户已离开 · 会话时长”画在这个位置，之后是工具卡片和跟进 */
  closedAt?: string | null;
  /** 买家服务评价 1–5 星（D-54） */
  serviceRating?: number | null;
  /** 工具跟进（D-56）：会话结束后用了付款提醒 / 物流通知，买家回复后的 2–3 轮短跟进 */
  toolFollowUp?: ToolFollowUp | null;
}

export interface ToolFollowUp {
  kind: ToolCardKind;
  orderId: string;
  sentAt: string;
  startedAt?: string | null;
  endedAt?: string | null;
  endReason?: string | null;
}

/** 订单页工具卡片（D-56）：付款提醒、物流通知 */
export type ToolCardKind = "payment_reminder" | "logistics_update";

/** 工具跟进是否进行中（买家已回复、还没结束） */
export function followUpActive(followUp: ToolFollowUp | null | undefined): boolean {
  return !!followUp?.startedAt && !followUp.endedAt;
}

export const sendToolCard = (session: Session, orderId: string, kind: ToolCardKind, text: string) =>
  apiPost<{ delivered: "live" | "closed"; conversationId: string }>(`/v1/orders/${orderId}/tool-cards`, session, { kind, text });

/** 邮件任务（D-58）：开始任务里的邮件场景，返回这次的邮件会话（收件人、建议模板） */
export interface MailTaskConversation {
  id: string;
  taskId: string | null;
  channel: "mail";
  scenario: { id: string; name: string; objective: string };
  buyer: BuyerPublicView;
  createdAt: string;
  mail: {
    to: string;
    toName: string;
    templateId: string;
    customerTags: CustomerTag[];
    orderStats: { count: number; total: number; lastPlacedAt: string | null };
  };
}

export const startMailTask = (session: Session, taskId: string, scenarioId: string) =>
  apiPost<MailTaskConversation>("/v1/conversations", session, { taskId, scenarioId });

export type CustomerTag = "粉丝" | "大订单客户" | "普通客户" | "沉睡客户" | "新客";

export interface ServiceMeta {
  followUp: boolean;
  buyerNote: string | null;
  buyerNoteAt: string | null;
}

export const saveServiceMeta = (
  session: Session,
  conversationId: string,
  patch: { followUp?: boolean; buyerNote?: string | null },
) => apiRequestPatch<ServiceMeta>(`/v1/conversations/${conversationId}/service-meta`, session, patch);

/** 店铺资料（全平台一份，老师在场景配置 → 店铺商品维护） */
export interface StoreProfile {
  name: string;
  logoUrl: string | null;
  market: "欧美" | "日韩" | "东南亚" | "中东";
  currency: string;
  supportEmail: string;
  signature: string;
  tiers: { bigOrderSingle: number; bigOrderYearly: number; dormantDays: number };
}

export const fetchStoreProfile = (session: Session) => apiGet<StoreProfile>("/v1/store/profile", session);
export const saveStoreProfile = (session: Session, patch: Partial<StoreProfile>) =>
  apiRequestPut<StoreProfile>("/v1/store/profile", session, patch);

/** C1 学生四项关键数字 */
export interface StudentSummary {
  tasks: { done: number; total: number };
  average: number | null;
  baseline: number | null;
  rank: { position: number | null; classSize: number; change: number | null };
  conversations: { total: number; practice: number; rounds: number };
  /** 任务接待达标次数 / 已评分次数 */
  pass: { assessed: number; passed: number };
  /** 本周接待次数（含自由练习） */
  weekConversations: number;
  /** 本周一到周日每天的接待次数 */
  weekDaily: number[];
  todayIndex?: number;
  /** 本周接待里的自由练习次数 */
  weekPractice: number;
  /** 平均响应时长（D-53）、3 分钟回复率（D-61，%）：全部聊天接待（含练习），和复盘“本次接待”同一套算法 */
  response?: { avgSeconds: number | null; turns: number; withinRate: number | null };
  /** 满意率（D-54）：服务评价 counts 依次是 5 星到 1 星的次数，rate = 4–5 星占比（%） */
  rating?: { counts: [number, number, number, number, number]; total: number; satisfied: number; rate: number | null; average: number | null };
}

export const fetchStudentSummary = (session: Session) => apiGet<StudentSummary>("/v1/student/summary", session);

export interface ConversationMessage {
  id: string;
  sender: "buyer" | "student" | "teacher";
  content: string;
  kind?: "text" | "product" | "coupon" | "voice" | "order" | "invite" | "image" | "video" | "file" | "payment_reminder" | "logistics_update" | "mail";
  payload?: Record<string, unknown> | null;
  createdAt: string;
  translation?: string;
  showTranslation?: boolean;
  /** 只在前端：学生这条没发到服务器（断网、登录失效），标红“发送失败”、可以重发 */
  failed?: boolean;
}

export interface StoreProduct {
  id: string;
  name: string;
  spec: string;
  price: number;
  sales: number;
  stock: number;
  tone: string;
  imageUrl?: string | null;
  enabled?: boolean;
  /** D-32 商品详情：多图（第一张是主图）、类目、规格矩阵、卖点、参数、尺码表、物流、售后、常见问题 */
  images?: string[];
  category?: string | null;
  details?: ProductDetails;
  source?: ProductSource;
  sourceUrl?: string | null;
  libraryId?: string | null;
}

/** 内置商品库的一条（教师端「从商品库挑选」） */
export interface LibraryItem {
  id: string;
  name: string;
  category: string;
  price: number;
  spec: string;
  imageUrl: string;
  inStore: boolean;
}

/** AI 整理出的商品草稿（链接采集 / 粘贴文字），老师核对后再上架 */
export interface ProductDraft {
  name: string;
  category: string | null;
  price: number | null;
  details: ProductDetails;
}

/** 上传头像（已在前端裁成正方形并压缩） */
export async function uploadMyAvatar(session: Session, image: Blob): Promise<{ avatarUrl: string }> {
  const form = new FormData();
  form.append("file", image, "avatar.jpg");
  const response = await authFetch(session, `${API_BASE}/v1/me/avatar`, { method: "POST", body: form });
  if (!response.ok) await parseError(response);
  return (await response.json()) as { avatarUrl: string };
}

/** 上传一张商品图（追加到末尾；main = 放到第一张作主图） */
export async function uploadProductImage(
  session: Session,
  productId: string,
  file: Blob,
  main = false,
): Promise<{ imageUrl: string; images: string[] }> {
  const form = new FormData();
  form.append("file", file, file instanceof File ? file.name : "image.jpg");
  const response = await authFetch(session, `${API_BASE}/v1/store/products/${productId}/images${main ? "?main=1" : ""}`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) await parseError(response);
  return (await response.json()) as { imageUrl: string; images: string[] };
}

/** 店铺优惠券（D-66）：字段由教师端配置，rule / scope / face 是服务端按字段生成的文字 */
export interface StoreCoupon {
  id: string;
  title: string;
  kind: CouponKind;
  amount: number;
  threshold: number;
  productIds: string[];
  customerTypes: string[];
  validDays: number;
  enabled: boolean;
  rule: string;
  scope: string;
  face: { value: string; gate: string };
}

export interface WorkbenchStats {
  todayConversations: number;
  unreplied: number;
  avgResponseSeconds: number | null;
  /** 3 分钟回复率（%）：今天开始的买家发言轮次（D-61） */
  replyWithinRate: number | null;
  satisfactionRate: number | null;
  inquiryPaidAmount: number;
  paidBuyers: number;
  conversionRate: number | null;
}

export interface GuidanceItem {
  id: string;
  conversationId: string;
  buyerName: string;
  content: string;
  createdAt: string;
}

export interface StreamMetrics {
  ttftMs: number | null;
  validChars: number;
  charsPerSecond: number;
  outcome: "success" | "timeout" | "error";
}

export const fetchConversations = (session: Session, status: "active" | "closed" = "active") =>
  apiGet<ConversationSummary[]>(`/v1/conversations?status=${status}`, session);
/** closedAt 是服务端记的结束时间（老服务端没有），结束提示按它画在消息流里 */
export const closeConversation = (session: Session, conversationId: string) =>
  apiPost<{ ok: boolean; closedAt?: string }>(`/v1/conversations/${conversationId}/close`, session);
export const translateMessage = (session: Session, conversationId: string, messageId: string) =>
  apiPost<{ translation: string }>(
    `/v1/conversations/${conversationId}/messages/${messageId}/translate`,
    session,
  );
/** 学生语音输入：上传整段 WAV，识别为文字 */
export async function recognizeAudio(
  session: Session,
  conversationId: string,
  audio: Blob,
): Promise<{ text: string; elapsedMs: number }> {
  const form = new FormData();
  form.append("file", audio, "speech.wav");
  const response = await authFetch(session, `${API_BASE}/v1/conversations/${conversationId}/asr`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) await parseError(response);
  return (await response.json()) as { text: string; elapsedMs: number };
}

export const requestMessageTts = (session: Session, conversationId: string, messageId: string) =>
  apiPost<{ audioUrl: string; cached: boolean; elapsedMs?: number }>(
    `/v1/conversations/${conversationId}/messages/${messageId}/tts`,
    session,
  );
export const fetchWorkbenchStats = (session: Session) =>
  apiGet<WorkbenchStats>("/v1/student/workbench-stats", session);
export const fetchPhrases = (session: Session) =>
  apiGet<string[]>("/v1/catalog/phrases", session);
export interface MyPhrase {
  id: string;
  text: string;
}
export const fetchMyPhrases = (session: Session) =>
  apiGet<MyPhrase[]>("/v1/catalog/my-phrases", session);
export const createMyPhrase = (session: Session, text: string) =>
  apiPost<MyPhrase>("/v1/catalog/my-phrases", session, { text });
export const deleteMyPhrase = (session: Session, phraseId: string) =>
  apiRequestDelete(`/v1/catalog/my-phrases/${phraseId}`, session);
export interface StudentOrder {
  id: string;
  conversationId: string;
  orderNo: string;
  status: string;
  conversationStatus: string;
  buyer: BuyerPublicView;
  detail: OrderInfo;
  createdAt: string;
}

export interface MailTemplate {
  id: string;
  name: string;
  subject: string;
  purpose: string;
  body: string;
}

export const fetchMailTemplates = (session: Session) =>
  apiGet<MailTemplate[]>("/v1/catalog/mail-templates", session);
export const fetchForbiddenTerms = (session: Session) =>
  apiGet<string[]>("/v1/catalog/forbidden-terms", session);
export const submitMail = (
  session: Session,
  payload: { templateId: string; subject: string; body: string; recipient?: string; orderId?: string; conversationId?: string },
) =>
  apiPost<{ id: string; violations: string[]; compliant: boolean; createdAt: string }>(
    "/v1/mail/submissions",
    session,
    payload,
  );

/** AI 辅助写信：实时生成 3 版邮件草稿（reply 模式 subject 为 null） */
export const assistMail = (
  session: Session,
  payload: {
    mode: "reply" | "compose";
    orderId?: string;
    templateId?: string;
    originalSubject?: string;
    originalBody?: string;
  },
) =>
  apiPost<{ versions: Array<{ subject: string | null; body: string }> }>(
    "/v1/mail/assist",
    session,
    payload,
  );

export interface MailReply {
  id: string;
  orderId: string | null;
  /** 回的是哪一封（邮件任务复盘按它找回信） */
  submissionId?: string | null;
  fromName: string;
  fromEmail: string;
  subject: string;
  body: string;
  createdAt: string;
}

export const fetchMailReplies = (session: Session) =>
  apiGet<MailReply[]>("/v1/mail/replies", session);

export interface MailSubmission {
  id: string;
  templateId: string;
  recipient: string | null;
  subject: string;
  body: string;
  violations: string[];
  compliant: boolean;
  createdAt: string;
}

export const fetchMailSubmissions = (session: Session) =>
  apiGet<MailSubmission[]>("/v1/mail/submissions", session);

export const fetchStudentOrders = (session: Session) =>
  apiGet<StudentOrder[]>("/v1/student/orders", session);

export interface StudentReview {
  orderId: string;
  conversationId: string;
  conversationStatus: string;
  orderNo: string;
  productName: string;
  productImage: string | null;
  buyer: BuyerPublicView;
  review: {
    rating: number;
    content: string;
    at: string;
    revised?: boolean;
    original?: { rating?: number; content?: string; at?: string };
  };
}

/** 全店评价累计（评价管理页数据源，按评价时间倒序，最多 500 条） */
export const fetchStudentReviews = (session: Session) =>
  apiGet<StudentReview[]>("/v1/student/reviews", session);
export const fetchOrderSuggestions = (
  session: Session,
  orderId: string,
  type: "payment_reminder" | "logistics_update" | "review_reply",
) => apiPost<{ suggestions: string[]; variants?: Array<{ angle: string; text: string; zh: string }> }>(`/v1/orders/${orderId}/suggestions`, session, { type });

export const fetchStoreProducts = (session: Session) =>
  apiGet<StoreProduct[]>("/v1/store/products", session);
export const fetchStoreCoupons = (session: Session) =>
  apiGet<StoreCoupon[]>("/v1/store/coupons", session);

/** 发送商品/优惠券/订单/邀请下单卡片，买家以 SSE 回应 */
export function streamCardMessage(
  session: Session,
  conversationId: string,
  type: "product" | "coupon" | "order" | "invite",
  refId: string,
  handlers: StreamHandlers,
): Promise<void> {
  return streamSse(
    session,
    `/v1/conversations/${conversationId}/cards`,
    { type, refId },
    handlers,
  );
}

/** 学生发消息（只落库不触发回复，配合批量窗口实现连发多条） */
export const postConversationMessage = (session: Session, conversationId: string, content: string) =>
  apiPost<{ ok: boolean }>(`/v1/conversations/${conversationId}/messages`, session, {
    content,
    defer: true,
  });

/** 批量窗口结束后触发买家回应（一次性回应连发的多条消息） */
export function streamConversationReply(
  session: Session,
  conversationId: string,
  handlers: StreamHandlers,
): Promise<void> {
  return streamSse(session, `/v1/conversations/${conversationId}/reply`, undefined, handlers);
}

/** 当前接待买家的全部订单（关联订单+历史订单） */
export const fetchConversationOrders = (session: Session, conversationId: string) =>
  apiGet<ConversationOrder[]>(`/v1/conversations/${conversationId}/orders`, session);

/** 订单操作：添加备注 / 修改地址 */
export const updateOrder = (
  session: Session,
  orderId: string,
  patch: { remark?: string; address?: OrderAddress },
) => apiRequestPatch<{ ok: boolean; detail: OrderInfo }>(`/v1/orders/${orderId}`, session, patch);

/** 教师指导通知（顶栏「消息」中心） */
export const fetchStudentGuidance = (session: Session) =>
  apiGet<GuidanceItem[]>("/v1/student/guidance", session);

/** 发送图片/视频/文件附件（multipart 上传，买家以 SSE 回应） */
export async function streamAttachmentMessage(
  session: Session,
  conversationId: string,
  file: File,
  kind: "image" | "video" | "file",
  handlers: StreamHandlers,
): Promise<void> {
  const form = new FormData();
  form.append("kind", kind);
  form.append("file", file, file.name);
  const response = await authFetch(
    session,
    `${API_BASE}/v1/conversations/${conversationId}/attachment-messages`,
    {
      method: "POST",
      body: form,
    },
  );
  await readSseResponse(response, handlers);
}
export const createConversation = (
  session: Session,
  body: { taskId?: string; scenarioId?: string },
) => apiPost<ConversationSummary>("/v1/conversations", session, body);
export const fetchConversationMessages = (session: Session, conversationId: string) =>
  apiGet<ConversationMessage[]>(`/v1/conversations/${conversationId}/messages`, session);

export interface StreamHandlers {
  onDelta: (text: string) => void;
  /** 买家连发：当前气泡结束，后续 delta 属于下一条消息 */
  onSplit?: () => void;
  /**
   * extra.closed=true 表示买家已结束会话（问题解决或失去耐心离开），extra.closedAt 是服务端记的结束时间；
   * extra.segments：服务端改写过（如去掉漏出的中文），以它为准替换刚流出的气泡
   */
  onDone: (metrics: StreamMetrics, extra?: { closed?: boolean; closedAt?: string; segments?: string[] }) => void;
  /** code：服务端错误码（如 NO_PENDING_MESSAGE），网络错误时为空 */
  onError: (message: string, code?: string) => void;
}

export function streamConversationMessage(
  session: Session,
  conversationId: string,
  content: string,
  handlers: StreamHandlers,
): Promise<void> {
  return streamSse(
    session,
    `/v1/conversations/${conversationId}/messages`,
    { content },
    handlers,
  );
}

/** 买家开场：会话尚无消息时由 AI 买家主动发出第一条消息 */
export function streamConversationOpening(
  session: Session,
  conversationId: string,
  handlers: StreamHandlers,
): Promise<void> {
  return streamSse(
    session,
    `/v1/conversations/${conversationId}/opening`,
    undefined,
    handlers,
  );
}

/** 直发语音消息（multipart 上传，买家以 SSE 回应） */
export async function streamVoiceMessage(
  session: Session,
  conversationId: string,
  audio: Blob,
  handlers: StreamHandlers,
): Promise<void> {
  const form = new FormData();
  form.append("file", audio, "voice.wav");
  const response = await authFetch(
    session,
    `${API_BASE}/v1/conversations/${conversationId}/voice-messages`,
    {
      method: "POST",
      body: form,
    },
  );
  await readSseResponse(response, handlers);
}

async function streamSse(
  session: Session,
  path: string,
  body: unknown,
  handlers: StreamHandlers,
): Promise<void> {
  const response = await authFetch(session, `${API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  await readSseResponse(response, handlers);
}

async function readSseResponse(
  response: Response,
  handlers: StreamHandlers,
): Promise<void> {
  if (!response.ok || !response.body) {
    try {
      await parseError(response);
    } catch (cause) {
      handlers.onError(cause instanceof ApiError ? cause.message : "发送失败，请稍后重试。", cause instanceof ApiError ? cause.code : undefined);
      return;
    }
  }
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      let event: { type: string; text?: string; metrics?: StreamMetrics; closed?: boolean; closedAt?: string; segments?: string[] };
      try {
        event = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
      if (event.type === "delta" && event.text) handlers.onDelta(event.text);
      else if (event.type === "split") handlers.onSplit?.();
      else if (event.type === "done" && event.metrics)
        handlers.onDone(event.metrics, { closed: event.closed === true, closedAt: event.closedAt, segments: event.segments });
      else if (event.type === "error") {
        handlers.onError("AI 回复失败，请重试或联系教师。");
        return;
      }
    }
  }
}
export const fetchTeacherTasks = (session: Session) =>
  apiGet<TeacherTask[]>("/v1/tasks", session);
export const createTask = (session: Session, payload: CreateTaskPayload) =>
  apiPost<TeacherTask>("/v1/tasks", session, payload);

/* ---------- 初始能力测评（独立评测引擎） ---------- */

export type BaselineQuestionKind = "single" | "multi" | "judge" | "practical";

export interface BaselineOption {
  id: string;
  text: string;
  translation?: string;
}

export interface BaselineQuestion {
  id: string;
  kind: BaselineQuestionKind;
  dimension: string;
  title: string;
  scenario?: string;
  scenarioTranslation?: string;
  options?: BaselineOption[];
}

export interface BaselineResult {
  scores: Record<string, number>;
  total: number;
  createdAt: string;
}

export interface BaselineStatus {
  completed: boolean;
  result: BaselineResult | null;
}

export const fetchBaselineStatus = (session: Session) =>
  apiGet<BaselineStatus>("/v1/student/baseline", session);
export const fetchBaselineQuestions = (session: Session) =>
  apiGet<{ questions: BaselineQuestion[] }>("/v1/student/baseline/questions", session);
export const submitBaseline = (session: Session, answers: Record<string, string | string[]>) =>
  apiPost<BaselineResult>("/v1/student/baseline/submit", session, { answers });

/* ---------- 公告（教师发布 → 学生端顶栏展示） ---------- */

export interface TeacherAnnouncement {
  id: string;
  title: string;
  content: string;
  className: string | null;
  createdAt: string;
  expiresAt: string | null;
  expired: boolean;
  /** 收到的学生数 / 其中看到过的（学生端顶栏显示过即算已读） */
  recipientCount?: number;
  readCount?: number;
}

export interface StudentAnnouncement {
  id: string;
  title: string;
  content: string;
  publisherName: string;
  createdAt: string;
}

export const fetchTeacherAnnouncements = (session: Session) =>
  apiGet<TeacherAnnouncement[]>("/v1/announcements", session);
export const publishAnnouncement = (
  session: Session,
  payload: { title: string; content: string; classIds?: string[]; days?: number | null },
) => apiPost<{ created: unknown[] }>("/v1/announcements", session, payload);
export const deleteAnnouncement = (session: Session, id: string) =>
  apiRequestDelete(`/v1/announcements/${id}`, session);
export const fetchStudentAnnouncements = (session: Session) =>
  apiGet<StudentAnnouncement[]>("/v1/student/announcements", session);

/* ---------- 教师端：任务/班级/学生管理、买家画像模板 ---------- */

export const updateTask = (
  session: Session,
  taskId: string,
  payload: { name?: string; startAt?: string | null; deadline?: string | null; timeLimitMinutes?: number | null; status?: "published" | "closed"; completionRule?: "all_scenarios" | "conversation_count"; requiredCount?: number | null; passScore?: number | null; arrivalMode?: "sequential" | "interval" | "all_at_once"; arrivalIntervalMinutes?: number | null },
) => apiRequestPatch(`/v1/tasks/${taskId}`, session, payload);
export const deleteTask = (session: Session, taskId: string) =>
  apiRequestDelete(`/v1/tasks/${taskId}`, session);
export const renameClass = (session: Session, classId: string, name: string) =>
  apiRequestPatch(`/v1/classes/${classId}`, session, { name });
/** 空班级直接删；还有学生的返回 CLASS_NOT_EMPTY，带上 confirm = 班级名才连学生一起删（D-86，删前服务端自动备份） */
export const deleteClass = (session: Session, classId: string, confirm?: string) =>
  apiRequestDelete(`/v1/classes/${classId}${confirm ? `?confirm=${encodeURIComponent(confirm)}` : ""}`, session);
export const setStudentStatus = (session: Session, studentId: string, status: "active" | "disabled") =>
  apiRequestPatch(`/v1/students/${studentId}`, session, { status });
/** 改姓名 / 转班（目标班需有授权） */
export const updateStudent = (session: Session, studentId: string, patch: { displayName?: string; classId?: string }) =>
  apiRequestPatch(`/v1/students/${studentId}`, session, patch);
/** 没练过的直接删；有记录的返回 STUDENT_HAS_DATA，带上 confirm = 学号才连记录一起删（D-86，删前服务端自动备份） */
export const deleteStudent = (session: Session, studentId: string, confirm?: string) =>
  apiRequestDelete(`/v1/students/${studentId}${confirm ? `?confirm=${encodeURIComponent(confirm)}` : ""}`, session);

export function apiRequestPut<T = { ok: boolean }>(
  path: string,
  session: Session,
  body?: unknown,
): Promise<T> {
  return apiRequest<T>("PUT", path, session, body);
}

// ---------- 管理端：教师与班级授权 ----------

export interface AdminTeacher {
  id: string;
  username: string;
  displayName: string;
  status: "active" | "disabled";
  mustChangePassword: boolean;
  /** 关联班级数（班主任 + 任课，去重） */
  classCount: number;
  headClassCount: number;
  createdAt: string;
}

export const fetchAdminTeachers = (session: Session) =>
  apiGet<AdminTeacher[]>("/v1/admin/teachers", session);
/** 名下有班级 / 任务 / 公告的返回 TEACHER_HAS_WORK，带上 successorId 才转交后删除（D-87） */
export const deleteTeacher = (session: Session, teacherId: string, successorId?: string) =>
  apiRequestDelete(`/v1/admin/teachers/${teacherId}${successorId ? `?successorId=${encodeURIComponent(successorId)}` : ""}`, session);
export const resetTeacherPassword = (session: Session, teacherId: string) =>
  apiPost<{ temporaryPassword: string }>(`/v1/admin/teachers/${teacherId}/reset-password`, session);
export const createClassAsAdmin = (session: Session, name: string, headTeacherId: string | null) =>
  apiPost<ClassSummary>("/v1/classes", session, { name, headTeacherId });
export const assignClassTeachers = (
  session: Session,
  classId: string,
  headTeacherId: string | null,
  teacherIds: string[],
) => apiRequestPut(`/v1/admin/classes/${classId}/teachers`, session, { headTeacherId, teacherIds });

// ---------- 学生端状态（云端保存，K1–K4） ----------

export interface ReviewReplyRecord {
  text: string;
  at: string;
}

export interface MailDraft {
  id: string;
  to: string;
  subject: string;
  body: string;
  templateId: string | null;
  savedAt: string;
}

export type ReadMarkKind = "mail" | "guidance" | "notice";

export const fetchReviewReplies = (session: Session) =>
  apiGet<Record<string, ReviewReplyRecord>>("/v1/student/review-replies", session);
export const saveReviewReplyRecord = (session: Session, orderId: string, text: string, at?: string) =>
  apiPost<{ orderId: string; text: string; at: string }>("/v1/student/review-replies", session, { orderId, text, at });
export const fetchStudentReviewReplies = (session: Session, studentId: string) =>
  apiGet<Array<{ orderId: string; orderNo: string; text: string; at: string }>>(
    `/v1/students/${studentId}/review-replies`,
    session,
  );
export const fetchMailDrafts = (session: Session) =>
  apiGet<MailDraft[]>("/v1/student/mail-drafts", session);
export const saveMailDraft = (session: Session, draft: MailDraft) =>
  apiRequestPut<MailDraft>(`/v1/student/mail-drafts/${encodeURIComponent(draft.id)}`, session, draft);
export const deleteMailDraft = (session: Session, draftId: string) =>
  apiRequestDelete(`/v1/student/mail-drafts/${encodeURIComponent(draftId)}`, session);
export const fetchReadMarks = (session: Session, kind: ReadMarkKind) =>
  apiGet<string[]>(`/v1/me/read-marks?kind=${kind}`, session);
export const saveReadMarks = (session: Session, kind: ReadMarkKind, ids: string[]) =>
  apiPost<{ ok: boolean }>("/v1/me/read-marks", session, { kind, ids });

/**
 * 旧版本存在 localStorage 的数据一次性迁到云端：有数据才上传，上传成功后删除本机副本；
 * 失败则保留，下次进入页面再试。
 */
export async function migrateLocalOnce<T>(key: string, upload: (value: T) => Promise<unknown>): Promise<void> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return;
  }
  if (!raw) return;
  let value: T;
  try {
    value = JSON.parse(raw) as T;
  } catch {
    localStorage.removeItem(key);
    return;
  }
  try {
    await upload(value);
    localStorage.removeItem(key);
  } catch {
    /* 留待下次 */
  }
}

/** 试抽出的示例买家（D-32） */
export interface PersonaSample {
  name: string;
  templateName?: string;
  gender: "male" | "female";
  avatarUrl: string;
  nationality: string;
  language: string;
  personality: string;
  emotion: string;
  customerType: string;
}

export const samplePersona = (session: Session, personaId: string, taskId?: string) =>
  apiPost<{ samples: PersonaSample[] }>(`/v1/catalog/personas/${personaId}/sample`, session, taskId ? { taskId } : {});

/** 新建任务的买家范围预览（D-33）：符合的画像和 3 个试抽结果 */
export const previewPersonaRule = (session: Session, rule: Record<string, unknown>) =>
  apiPost<{ matchCount: number; matched: Array<{ id: string; name: string; customerType: string }>; samples: PersonaSample[] }>("/v1/catalog/personas/preview", session, { rule });

export const generatePersonaDraft = (session: Session, description: string) =>
  apiPost<Omit<PersonaTemplate, "id" | "enabled" | "avatarUrl" | "conversationCount">>("/v1/catalog/personas/generate", session, { description });

export interface PersonaTemplate {
  id: string;
  name: string;
  nationality: string;
  identity: string;
  personality: string;
  emotion: string;
  language: string;
  preference: string;
  customerType: string;
  enabled: boolean;
  /** D-33 结构化字段 */
  buyerRole?: string | null;
  decisionStyle?: string | null;
  concerns?: string[];
  note?: string | null;
  /** 列表接口附带：画像卡片头像、被用来接待过几次 */
  avatarUrl?: string;
  conversationCount?: number;
}

export const fetchPersonas = (session: Session) =>
  apiGet<PersonaTemplate[]>("/v1/catalog/personas", session);
export const createPersona = (session: Session, payload: Partial<PersonaTemplate>) =>
  apiPost<PersonaTemplate>("/v1/catalog/personas", session, payload);
export const updatePersona = (session: Session, personaId: string, payload: Partial<PersonaTemplate>) =>
  apiRequestPatch<PersonaTemplate>(`/v1/catalog/personas/${personaId}`, session, payload);
export const deletePersona = (session: Session, personaId: string) =>
  apiRequestDelete(`/v1/catalog/personas/${personaId}`, session);

// ---------- 平台品牌（H6 / D-21） ----------

export interface BrandSettings {
  name: string;
  /** data URL；null 表示使用内置客服耳麦图标 */
  logo: string | null;
}

/** 登录前调用，不需要会话 */
export async function fetchPublicBrand(): Promise<BrandSettings> {
  const response = await fetch(`${API_BASE}/v1/public/brand`);
  if (!response.ok) await parseError(response);
  return (await response.json()) as BrandSettings;
}

export const saveBrand = (session: Session, patch: { name?: string; logo?: string | null }) =>
  apiRequestPut<BrandSettings>("/v1/admin/brand", session, patch);

// ---------- 管理端：系统总览、告警、内容库（E4–E6） ----------

export type ServiceStatus = "ok" | "warn" | "error" | "off";

export interface AdminAlert {
  level: "warn" | "danger";
  title: string;
  detail: string;
  /** 对应的管理端页面 id */
  page: "providers" | "backup" | "system";
  /** “AI 与语音服务”里要打开的页签 */
  tab?: "models" | "voice" | "usage";
  /** 告警里能直接做的事：重新测试出错的模型（通过后提醒自动消失）；评分失败的接待重新评分 */
  action?: { kind: "test-profile"; profileId: string } | { kind: "retry-assessments" };
}

export interface AdminSystemOverview {
  version: { server: string; schema: string; uptimeSeconds: number };
  services: Array<{ key: string; name: string; status: ServiceStatus; detail: string }>;
  alerts: AdminAlert[];
  counts: { students: number; teachers: number; conversations: number; messages: number; assessments: number };
}

export const fetchAdminSystem = (session: Session) => apiGet<AdminSystemOverview>("/v1/admin/system", session);
export const fetchAdminAlerts = (session: Session) => apiGet<AdminAlert[]>("/v1/admin/alerts", session);

export interface ContentTerm {
  id: number;
  text: string;
  enabled: boolean;
}

export type ContentKind = "forbidden" | "phrase";

export const fetchContentTerms = (session: Session, kind: ContentKind) =>
  apiGet<ContentTerm[]>(`/v1/admin/content?kind=${kind}`, session);
export const addContentTerm = (session: Session, kind: ContentKind, text: string) =>
  apiPost("/v1/admin/content", session, { kind, text });
export const setContentTermEnabled = (session: Session, id: number, enabled: boolean) =>
  apiRequestPatch(`/v1/admin/content/${id}`, session, { enabled });
export const importContentTerms = (session: Session, kind: ContentKind, texts: string[]) =>
  apiPost<{ added: number; skipped: number }>("/v1/admin/content/import", session, { kind, texts });
export const deleteContentTerm = (session: Session, id: number) => apiRequestDelete(`/v1/admin/content/${id}`, session);

export interface AuditEntry {
  id: number;
  action: string;
  target: string | null;
  actor: string | null;
  created_at: string;
}
export const fetchAudit = (session: Session, limit = 30) => apiGet<AuditEntry[]>(`/v1/admin/audit?limit=${limit}`, session);

export interface BackupFile {
  fileName: string;
  size: number;
  createdAt: string;
}
export const fetchBackups = (session: Session) => apiGet<BackupFile[]>("/v1/admin/backups", session);
export const createBackup = (session: Session) => apiPost<{ fileName: string; size: number; removed: number }>("/v1/admin/backups", session);
export interface BackupSchedule {
  enabled: boolean;
  hour: number;
  /** 保留最近几份 */
  keep: number;
  keepOptions: number[];
}
export const fetchBackupSchedule = (session: Session) => apiGet<BackupSchedule>("/v1/admin/backup-schedule", session);
export const saveBackupSchedule = (session: Session, schedule: Pick<BackupSchedule, "enabled" | "hour" | "keep">) =>
  apiRequestPut<BackupSchedule>("/v1/admin/backup-schedule", session, schedule);

/** 音色试听：返回可直接播放的 mp3 地址（用完需 revokeObjectURL） */
export async function previewVoice(session: Session, speaker: string, vendor = "doubao", language = "en"): Promise<string> {
  const response = await authFetch(session, `${API_BASE}/v1/admin/voice/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ speaker, vendor, language }),
  });
  if (!response.ok) await parseError(response);
  return URL.createObjectURL(await response.blob());
}

/** 带鉴权下载文件（备份、导出），浏览器另存 */
export async function downloadWithAuth(session: Session, path: string, fileName: string): Promise<void> {
  const response = await authFetch(session, `${API_BASE}${path}`);
  if (!response.ok) await parseError(response);
  const blob = await response.blob();
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(link.href);
}

/** 评价、邮件正文的中文译文（POST /v1/translate，服务端缓存） */
export const translateText = (session: Session, text: string, target?: string) =>
  apiPost<{ translation: string }>("/v1/translate", session, target ? { text, target } : { text }).then((result) => result.translation);
