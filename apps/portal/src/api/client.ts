export const API_BASE =
  (import.meta as { env?: Record<string, string> }).env?.VITE_API_URL ??
  "http://127.0.0.1:8787";

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
  interactionMode: string;
  timeLimitMinutes: number | null;
  deadline: string | null;
  progressStatus: "todo" | "in_progress" | "done";
  score: number | null;
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
  ) {
    super(message);
  }
}

async function parseError(response: Response): Promise<never> {
  let code = "UNKNOWN";
  let message = `请求失败（${response.status}）`;
  try {
    const body = await response.json();
    if (body?.code) code = body.code;
    if (body?.message) message = body.message;
  } catch {
    /* keep defaults */
  }
  throw new ApiError(response.status, code, message);
}

export async function login(
  username: string,
  password: string,
): Promise<Session> {
  const response = await fetch(`${API_BASE}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
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
}

export interface TeacherTask {
  id: string;
  name: string;
  businessStage: "pre_sale" | "in_sale" | "after_sale" | "customer_care";
  scenarioIds: string[];
  interactionMode: string;
  timeLimitMinutes: number | null;
  deadline: string | null;
  scoringWeights: Record<string, number>;
  status: string;
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
  deadline?: string;
  scoringWeights: Record<string, number>;
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
  students: Array<{ username: string; displayName: string }>,
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
  review: { rating: number; content: string; at: string } | null;
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
