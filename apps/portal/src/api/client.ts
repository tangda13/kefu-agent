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
  /** 场景 id→name 明细（与 scenarioIds 对应，用于工作台按场景接入） */
  scenarios: Array<{ id: string; name: string }>;
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
  const response = await fetch(`${API_BASE}/v1/auth/change-password`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${session.accessToken}`,
    },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  if (!response.ok) await parseError(response);
}

async function refreshSession(session: Session): Promise<Session | null> {
  const response = await fetch(`${API_BASE}/v1/auth/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: session.refreshToken }),
  });
  if (!response.ok) {
    clearSession();
    return null;
  }
  const next = (await response.json()) as Session;
  saveSession(next);
  return next;
}

async function apiRequest<T>(
  method: string,
  path: string,
  session: Session,
  body?: unknown,
): Promise<T> {
  const request = (token: string) =>
    fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  let response = await request(session.accessToken);
  if (response.status === 401) {
    const renewed = await refreshSession(session);
    if (!renewed) await parseError(response);
    response = await request(renewed!.accessToken);
  }
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
  createdAt: string;
}

export interface ClassStudent {
  id: string;
  username: string;
  displayName: string;
  status: "active" | "disabled";
  mustChangePassword: boolean;
  createdAt: string;
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
  /** 场景剧本（J5）：买家目标、隐藏信息、情绪触发点、让步底线、结束条件 */
  script: Partial<Record<"buyerGoal" | "hiddenInfo" | "emotionTriggers" | "bottomLine" | "endConditions", string>> | null;
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
  classes: Array<{ id: string; name: string }>;
  studentTotal: number;
  studentDone: number;
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
export const fetchClassStudents = (session: Session, classId: string) =>
  apiGet<ClassStudent[]>(`/v1/classes/${classId}/students`, session);
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
}

export interface ConversationMessage {
  id: string;
  sender: "buyer" | "student" | "teacher";
  content: string;
  kind?: "text" | "product" | "coupon" | "voice" | "order" | "invite" | "image" | "video" | "file";
  payload?: Record<string, unknown> | null;
  createdAt: string;
  translation?: string;
  showTranslation?: boolean;
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
}

export async function uploadProductImage(
  session: Session,
  productId: string,
  file: File,
): Promise<{ imageUrl: string }> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(`${API_BASE}/v1/store/products/${productId}/image`, {
    method: "POST",
    headers: { authorization: `Bearer ${session.accessToken}` },
    body: form,
  });
  if (!response.ok) await parseError(response);
  return (await response.json()) as { imageUrl: string };
}

export interface StoreCoupon {
  id: string;
  title: string;
  rule: string;
  scope: string;
  validDays: number;
}

export interface WorkbenchStats {
  todayConversations: number;
  unreplied: number;
  avgResponseSeconds: number | null;
  twelveHourResponseRate: number | null;
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
export const closeConversation = (session: Session, conversationId: string) =>
  apiPost<{ ok: boolean }>(`/v1/conversations/${conversationId}/close`, session);
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
  const response = await fetch(`${API_BASE}/v1/conversations/${conversationId}/asr`, {
    method: "POST",
    headers: { authorization: `Bearer ${session.accessToken}` },
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
  payload: { templateId: string; subject: string; body: string; recipient?: string; orderId?: string },
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
) => apiPost<{ suggestions: string[] }>(`/v1/orders/${orderId}/suggestions`, session, { type });

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
  const response = await fetch(
    `${API_BASE}/v1/conversations/${conversationId}/attachment-messages`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${session.accessToken}` },
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
  /** extra.closed=true 表示买家已结束会话（问题解决或失去耐心离开） */
  onDone: (metrics: StreamMetrics, extra?: { closed?: boolean }) => void;
  onError: (message: string) => void;
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
  const response = await fetch(
    `${API_BASE}/v1/conversations/${conversationId}/voice-messages`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${session.accessToken}` },
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
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${session.accessToken}`,
    },
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
      handlers.onError(cause instanceof ApiError ? cause.message : "发送失败，请稍后重试。");
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
      let event: { type: string; text?: string; metrics?: StreamMetrics; closed?: boolean };
      try {
        event = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
      if (event.type === "delta" && event.text) handlers.onDelta(event.text);
      else if (event.type === "split") handlers.onSplit?.();
      else if (event.type === "done" && event.metrics)
        handlers.onDone(event.metrics, { closed: event.closed === true });
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
export const deleteClass = (session: Session, classId: string) =>
  apiRequestDelete(`/v1/classes/${classId}`, session);
export const setStudentStatus = (session: Session, studentId: string, status: "active" | "disabled") =>
  apiRequestPatch(`/v1/students/${studentId}`, session, { status });
/** 改姓名 / 转班（目标班需有授权） */
export const updateStudent = (session: Session, studentId: string, patch: { displayName?: string; classId?: string }) =>
  apiRequestPatch(`/v1/students/${studentId}`, session, patch);
/** 仅无实训记录的学生可删除，否则返回 STUDENT_HAS_DATA */
export const deleteStudent = (session: Session, studentId: string) =>
  apiRequestDelete(`/v1/students/${studentId}`, session);

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

export type ReadMarkKind = "mail" | "guidance";

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
}

export const fetchPersonas = (session: Session) =>
  apiGet<PersonaTemplate[]>("/v1/catalog/personas", session);
export const createPersona = (session: Session, payload: Partial<PersonaTemplate>) =>
  apiPost<PersonaTemplate>("/v1/catalog/personas", session, payload);
export const updatePersona = (session: Session, personaId: string, payload: Partial<PersonaTemplate>) =>
  apiRequestPatch<PersonaTemplate>(`/v1/catalog/personas/${personaId}`, session, payload);
export const deletePersona = (session: Session, personaId: string) =>
  apiRequestDelete(`/v1/catalog/personas/${personaId}`, session);
