import {
  CUSTOMER_TYPES,
  EMOTIONS,
  NATIONALITIES,
  PERSONALITIES,
  SUPPORTED_LANGUAGES,
  type BusinessStage,
  type PersonaTemplate,
  type TrainingScenario,
} from "@cecs/contracts";

export const trainingScenarios = [
  { id: "PRE-001", name: "新品咨询与卖点介绍", stage: "pre_sale", objective: "识别需求并以合规英文介绍新品卖点", defaultLanguage: "en-US", enabled: true },
  { id: "PRE-002", name: "新客开发邮件", stage: "pre_sale", objective: "完成新客开发邮件并修正违规宣传用语", defaultLanguage: "en-US", enabled: true },
  { id: "IN-001", name: "未付款订单催付", stage: "in_sale", objective: "在不施压的前提下说明库存与付款安排", defaultLanguage: "en-US", enabled: true },
  { id: "IN-002", name: "清关延误安抚", stage: "in_sale", objective: "同步物流节点并安抚焦虑客户", defaultLanguage: "en-US", enabled: true },
  { id: "AFTER-001", name: "货损退款协商", stage: "after_sale", objective: "核实证据并提出退款、补发或补偿方案", defaultLanguage: "en-US", enabled: true },
  { id: "AFTER-002", name: "差评挽回", stage: "after_sale", objective: "回应负面评价并推动问题闭环", defaultLanguage: "en-US", enabled: true },
  { id: "CARE-001", name: "复购老客优惠沟通", stage: "customer_care", objective: "结合历史偏好完成个性化复购推荐", defaultLanguage: "en-US", enabled: true },
  { id: "CARE-002", name: "沉睡客户唤醒", stage: "customer_care", objective: "以节日关怀和新品信息重新建立联系", defaultLanguage: "en-US", enabled: true },
] as const satisfies readonly TrainingScenario[];

export const personaTemplates = [
  ["P-001", "Jessica Miller", "female", "美国", "独立站零售买家", "友好健谈", "期待", "en-US", "重视到货速度", "粉丝客"],
  ["P-002", "Lukas Schneider", "male", "德国", "小型采购商", "理性谨慎", "平静", "en-US", "关注参数与合规", "复购老客"],
  ["P-003", "Camille Bernard", "female", "法国", "生活方式买手", "敏感挑剔", "不满", "fr-FR", "关注包装与设计", "潜在意向客"],
  ["P-004", "Yuki Tanaka", "female", "日本", "平台个人买家", "犹豫保守", "焦虑", "en-US", "重视细节与礼貌", "潜在意向客"],
  ["P-005", "Daniel Johnson", "male", "加拿大", "企业行政采购", "直接高效", "平静", "en-US", "关注交付确定性", "复购老客"],
  ["P-006", "Olivia Brown", "female", "英国", "社媒内容创作者", "友好健谈", "期待", "en-US", "喜欢新品试用", "粉丝客"],
  ["P-007", "Sophie Martin", "female", "法国", "精品店主", "理性谨慎", "平静", "fr-FR", "关注批量价格", "复购老客"],
  ["P-008", "Mateo Garcia", "male", "西班牙", "平台个人买家", "直接高效", "焦虑", "es-ES", "关注物流追踪", "潜在意向客"],
  ["P-009", "Emma Wilson", "female", "澳大利亚", "户外用品爱好者", "友好健谈", "期待", "en-US", "关注耐用性", "粉丝客"],
  ["P-010", "Marco Rossi", "male", "意大利", "小型批发商", "敏感挑剔", "不满", "en-US", "关注质量一致性", "复购老客"],
  ["P-011", "Ana Souza", "female", "巴西", "平台个人买家", "友好健谈", "期待", "es-ES", "偏好折扣活动", "潜在意向客"],
  ["P-012", "Noah Williams", "male", "美国", "独立站沉睡用户", "犹豫保守", "平静", "en-US", "需要明确购买理由", "沉睡客"],
  ["P-013", "Charlotte Taylor", "female", "英国", "礼品采购人", "理性谨慎", "焦虑", "en-US", "重视节日前到货", "潜在意向客"],
  ["P-014", "Felix Weber", "male", "德国", "技术产品评测者", "敏感挑剔", "平静", "en-US", "关注技术规格", "粉丝客"],
  ["P-015", "Mia Thompson", "female", "加拿大", "平台沉睡用户", "友好健谈", "平静", "en-US", "喜欢个性化推荐", "沉睡客"],
  ["P-016", "Hana Sato", "female", "日本", "生活家居买家", "犹豫保守", "期待", "en-US", "关注售后保障", "潜在意向客"],
  ["P-017", "Isabella Romano", "female", "意大利", "精品店主", "直接高效", "平静", "en-US", "关注新品供货", "复购老客"],
  ["P-018", "Lucas Silva", "male", "巴西", "社媒活跃买家", "友好健谈", "不满", "es-ES", "重视公开评价", "粉丝客"],
  ["P-019", "Amelia Clark", "female", "澳大利亚", "独立站沉睡用户", "理性谨慎", "平静", "en-US", "关注环保材料", "沉睡客"],
  ["P-020", "Diego Fernandez", "male", "西班牙", "小型零售商", "直接高效", "焦虑", "es-ES", "关注库存与补货", "复购老客"],
].map(([id, name, gender, nationality, identity, personality, emotion, language, preference, customerType]) => ({
  id,
  name,
  gender,
  nationality,
  identity,
  personality,
  emotion,
  language,
  preference,
  customerType,
  enabled: true,
})) as PersonaTemplate[];

export const emailTemplates = [
  {
    id: "MAIL-001", name: "新品推广", subject: "A new arrival selected for your store", purpose: "介绍新品并邀请了解",
    body: "Dear {customer},\n\nWe just launched a new product that matches what your customers usually look for. It features improved materials and a refreshed design, and early feedback has been encouraging.\n\nWould you like me to send more details or a sample quotation?\n\nBest regards,\n{agent}",
  },
  {
    id: "MAIL-002", name: "新客开发", subject: "A reliable supply option for your business", purpose: "建立首次商务联系",
    body: "Dear {customer},\n\nI am reaching out from our cross-border store. We supply quality products with stable stock and traceable logistics, and we support small trial orders for new partners.\n\nIf you are open to it, I can share our catalogue and current pricing.\n\nBest regards,\n{agent}",
  },
  {
    id: "MAIL-003", name: "节日关怀", subject: "Warm wishes and a small thank-you", purpose: "维护客户关系",
    body: "Dear {customer},\n\nWishing you a wonderful holiday season! As a small thank-you for your support this year, we prepared an exclusive offer valid for the next two weeks.\n\nWe look forward to serving you again.\n\nWarm regards,\n{agent}",
  },
  {
    id: "MAIL-004", name: "复购唤醒", subject: "An update based on your previous order", purpose: "基于历史偏好促进复购",
    body: "Dear {customer},\n\nIt has been a while since your last order. Based on what you purchased before, we selected a few updates you might like, and your previous size and preference records are still on file.\n\nWould you like me to share the latest options?\n\nBest regards,\n{agent}",
  },
] as const;

export const forbiddenTerms = [
  "100% guaranteed", "absolute best", "always works", "anti-cancer", "anti-inflammatory cure",
  "authentic replica", "best in the world", "brand identical", "clinically proven cure", "completely harmless",
  "cure-all", "definitely effective", "disease treatment", "doctor approved", "drug-like effect",
  "eliminates pain", "FDA approved", "free forever", "guaranteed income", "guaranteed results",
  "heals instantly", "highest quality ever", "instant cure", "lifetime guarantee", "lose weight fast",
  "lowest price worldwide", "medical grade", "miracle", "never breaks", "no side effects",
  "official authorization", "permanent result", "risk-free", "safest product", "secret formula",
  "top one", "treats disease", "unbeatable", "unlimited warranty", "works for everyone",
  "包治百病", "绝对安全", "绝对有效", "零风险", "全球第一",
  "国家级", "最高级", "最佳", "顶级", "极品",
  "万能", "永久有效", "无任何副作用", "百分百治愈", "立即见效",
  "医学认证", "官方唯一", "独家授权", "原厂同款", "高仿",
  "复刻正品", "假一赔十", "稳赚不赔", "保证收益", "全网最低",
  "史上最低", "永不损坏", "终身免费", "完全无害", "零添加",
  "根治", "治疗", "抗癌", "消炎", "止痛",
  "减肥特效", "快速瘦身", "增强免疫治疗", "替代药物", "医生推荐",
  "临床治愈", "FDA认证", "免检产品", "100%正品", "绝无仅有",
  "销量第一", "领导品牌", "王牌", "至尊", "国家领导人推荐",
  "点击中奖", "限时不买必涨", "最后一次机会", "强制好评返现", "删除差评退款",
  "绕过海关", "低报避税", "无条件清关", "仿牌", "侵权同款",
] as const;

export const standardPhrases = [
  "Thank you for reaching out to us.",
  "I understand why this situation is frustrating.",
  "Let me check the latest order status for you.",
  "Could you please confirm your order number?",
  "Thank you for your patience while I verify the details.",
  "I am sorry that the item did not arrive as expected.",
  "We can offer a replacement or a refund after verification.",
  "Please share a clear photo of the item and outer package.",
  "Your order has been collected by the carrier.",
  "The parcel is currently in international transit.",
  "The shipment is undergoing customs clearance.",
  "The local carrier is preparing the final delivery.",
  "We will keep you updated when the tracking status changes.",
  "Would you prefer a replacement or a refund?",
  "I appreciate the opportunity to resolve this for you.",
  "We have recorded your feedback for our quality team.",
  "Your payment has not yet been completed.",
  "The item is reserved for a limited period in your order.",
  "Please let me know if you need help with the payment process.",
  "The product is available in the following specifications.",
  "Based on your needs, this option may be a suitable choice.",
  "May I ask which feature matters most to you?",
  "The estimated delivery window is shown in your order details.",
  "Delivery times may vary during customs processing.",
  "We cannot promise an exact customs release time.",
  "I can explain the next available resolution steps.",
  "Thank you for bringing this issue to our attention.",
  "We value your experience and would like to make this right.",
  "Could you confirm whether the package seal was intact?",
  "We have escalated the case for further review.",
  "You will receive an update within the stated service window.",
  "The refund will be returned to your original payment method.",
  "Processing time depends on your payment provider.",
  "We have arranged a replacement shipment for you.",
  "Here is the new tracking reference for your replacement.",
  "Thank you for your continued support.",
  "We selected this update based on your previous purchase.",
  "You may edit your communication preferences at any time.",
  "This offer is subject to the terms shown on the product page.",
  "Stock availability may change before payment is completed.",
  "I will summarize the agreed solution before we close the case.",
  "Please confirm that this solution works for you.",
  "Is there anything else I can help you with today?",
  "Thank you for confirming the delivery address.",
  "For your security, please do not share payment passwords.",
  "We only need the information required to process this request.",
  "Your case reference is available in the conversation record.",
  "A teacher may review this training conversation for assessment.",
  "We appreciate your honest review and specific suggestions.",
  "I hope the proposed solution addresses your concern.",
] as const;

export interface PersonaSnapshot extends PersonaTemplate {
  sourceTemplateId: string;
  generatedAt: string;
  avatarUrl: string;
}

/** 本地真人头像库容量（apps/portal/public/avatars/{m,f}-NN.jpg） */
export const AVATAR_LIBRARY = { male: 20, female: 20 } as const;

export function pickAvatarUrl(
  gender: "male" | "female",
  random: () => number = Math.random,
): string {
  const count = AVATAR_LIBRARY[gender];
  const index = 1 + Math.min(count - 1, Math.floor(random() * count));
  return `avatars/${gender === "female" ? "f" : "m"}-${String(index).padStart(2, "0")}.jpg`;
}

/** 稳定散列：同一输入永远得到同一结果（前后端共用，勿改算法） */
export function stableHash(text: string): number {
  let value = 0;
  for (let index = 0; index < text.length; index += 1) {
    value = (value * 31 + text.charCodeAt(index)) | 0;
  }
  return Math.abs(value);
}

const BUYER_EMAIL_DOMAINS = ["gmail.com", "outlook.com", "hotmail.com", "yahoo.com"] as const;

/** 买家邮箱（展示/邮件往来用，按订单号稳定派生；与学生端邮箱展示同源） */
export function deriveBuyerEmail(name: string, orderNo: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/(^\.+|\.+$)/g, "") || "customer";
  return `${slug}@${BUYER_EMAIL_DOMAINS[stableHash(orderNo) % BUYER_EMAIL_DOMAINS.length]}`;
}

function pick<T>(items: readonly T[], random: () => number): T {
  const index = Math.min(items.length - 1, Math.floor(random() * items.length));
  const value = items[index];
  if (value === undefined) throw new Error("Cannot pick from an empty collection");
  return value;
}

export function composePersona(random: () => number = Math.random): PersonaSnapshot {
  const template = pick(personaTemplates.filter((item) => item.enabled), random);
  return {
    ...template,
    sourceTemplateId: template.id,
    id: `SNAP-${Date.now()}-${Math.floor(random() * 10000)}`,
    nationality: pick(NATIONALITIES, random),
    personality: pick(PERSONALITIES, random),
    emotion: pick(EMOTIONS, random),
    language: pick(SUPPORTED_LANGUAGES, random),
    customerType: pick(CUSTOMER_TYPES, random),
    avatarUrl: pickAvatarUrl(template.gender, random),
    generatedAt: new Date().toISOString(),
  };
}

// ---------- 真随机姓名池（按国籍分组，姓名与国籍强绑定，避免"日本名字澳洲人"穿帮） ----------

interface NamePool {
  male: readonly string[];
  female: readonly string[];
  surnames: readonly string[];
}

const EN_POOL: NamePool = {
  male: ["James", "Michael", "David", "Daniel", "Matthew", "Ryan", "Ethan", "Tyler", "Brandon", "Kevin"],
  female: ["Emily", "Sarah", "Ashley", "Megan", "Rachel", "Lauren", "Hannah", "Olivia", "Chloe", "Grace"],
  surnames: ["Smith", "Johnson", "Brown", "Davis", "Miller", "Wilson", "Taylor", "Anderson", "Moore", "Clark", "Walker", "Harris"],
};

const NAME_POOLS: Record<string, NamePool> = {
  美国: EN_POOL,
  英国: EN_POOL,
  加拿大: EN_POOL,
  澳大利亚: EN_POOL,
  德国: {
    male: ["Lukas", "Felix", "Jonas", "Maximilian", "Paul", "Leon", "Tobias", "Florian"],
    female: ["Anna", "Lena", "Laura", "Julia", "Katharina", "Sophie", "Marie", "Hannah"],
    surnames: ["Müller", "Schmidt", "Schneider", "Fischer", "Weber", "Wagner", "Becker", "Hoffmann", "Koch", "Richter"],
  },
  法国: {
    male: ["Lucas", "Hugo", "Louis", "Théo", "Antoine", "Julien", "Nicolas", "Pierre"],
    female: ["Camille", "Léa", "Chloé", "Manon", "Emma", "Juliette", "Claire", "Élise"],
    surnames: ["Martin", "Bernard", "Dubois", "Moreau", "Laurent", "Lefebvre", "Roux", "Fournier"],
  },
  西班牙: {
    male: ["Alejandro", "Javier", "Carlos", "Diego", "Pablo", "Miguel", "Sergio", "Adrián"],
    female: ["Lucía", "María", "Carmen", "Sofía", "Paula", "Elena", "Marta", "Alba"],
    surnames: ["García", "Rodríguez", "Fernández", "López", "Martínez", "Sánchez", "Pérez", "Torres"],
  },
  意大利: {
    male: ["Marco", "Luca", "Alessandro", "Matteo", "Andrea", "Francesco", "Davide", "Simone"],
    female: ["Giulia", "Chiara", "Francesca", "Alessia", "Martina", "Elena", "Sara", "Valentina"],
    surnames: ["Rossi", "Russo", "Ferrari", "Esposito", "Bianchi", "Romano", "Colombo", "Ricci"],
  },
  日本: {
    male: ["Haruto", "Yuto", "Sota", "Ren", "Kaito", "Daiki", "Takumi", "Riku"],
    female: ["Yui", "Hana", "Sakura", "Aoi", "Rin", "Mei", "Miyu", "Akari"],
    surnames: ["Sato", "Suzuki", "Takahashi", "Tanaka", "Watanabe", "Ito", "Yamamoto", "Nakamura"],
  },
  巴西: {
    male: ["João", "Gabriel", "Lucas", "Matheus", "Pedro", "Rafael", "Bruno", "Thiago"],
    female: ["Ana", "Beatriz", "Camila", "Fernanda", "Juliana", "Larissa", "Mariana", "Letícia"],
    surnames: ["Silva", "Santos", "Oliveira", "Souza", "Costa", "Pereira", "Almeida", "Ferreira"],
  },
};

/** 国籍→母语（不在支持列表内的国家用英语沟通） */
const NATIVE_LANGUAGE: Record<string, (typeof SUPPORTED_LANGUAGES)[number]> = {
  法国: "fr-FR",
  西班牙: "es-ES",
};

const IDENTITY_POOL = [
  "平台个人买家", "小型零售商", "精品店主", "企业采购专员", "社媒内容创作者",
  "独立站店主", "礼品采购人", "宝妈买家", "留学生", "健身教练",
  "产品评测博主", "咖啡馆经营者", "民宿主理人", "手作工作室主理人",
] as const;

const PREFERENCE_POOL = [
  "重视到货速度", "关注参数与合规", "关注包装与设计", "重视细节与礼貌", "关注交付确定性",
  "喜欢新品试用", "关注批量价格", "关注物流追踪", "关注耐用性", "关注质量一致性",
  "偏好折扣活动", "重视售后保障", "关注环保材料", "重视公开评价", "关注库存与补货",
] as const;

/** 会话画像随机规则（来自教师任务配置） */
export interface PersonaRule {
  nationalityPool?: string[];
  personalityPool?: string[];
  emotionPool?: string[];
  languages?: string[];
  customerTypes?: string[];
}

/** 可参与抽取的画像模板最小形状（来自 DB persona_templates，教师可维护） */
export interface PersonaTemplateBase {
  id: string;
  identity: string;
  preference: string;
  customerType: string;
}

function pickConstrained<T extends string>(
  all: readonly T[],
  pool: string[] | undefined,
  random: () => number,
): T {
  const allowed = pool?.length ? all.filter((item) => pool.includes(item)) : all;
  return pick(allowed.length ? allowed : all, random);
}

/**
 * 真随机画像合成：模板库（DB，教师可维护）提供身份/偏好/客户类型底子，
 * 姓名按国籍从姓名池生成（性别随机、姓名-国籍强绑定），
 * 国籍/性格/情绪/语言受任务随机规则约束。学生开始前不可预知。
 */
export function composePersonaWithRule(
  templates: readonly PersonaTemplateBase[],
  rule: PersonaRule = {},
  random: () => number = Math.random,
): PersonaSnapshot {
  const template = templates.length
    ? pick(templates, random)
    : pick(personaTemplates, random);
  const nationality = pickConstrained(NATIONALITIES, rule.nationalityPool, random);
  const gender: "male" | "female" = random() < 0.5 ? "male" : "female";
  const namePool = NAME_POOLS[nationality] ?? EN_POOL;
  const name = `${pick(gender === "male" ? namePool.male : namePool.female, random)} ${pick(namePool.surnames, random)}`;
  const language = rule.languages?.length
    ? pickConstrained(SUPPORTED_LANGUAGES, rule.languages, random)
    : NATIVE_LANGUAGE[nationality] ?? "en-US";
  return {
    id: `SNAP-${Date.now()}-${Math.floor(random() * 10000)}`,
    sourceTemplateId: template.id,
    name,
    gender,
    nationality,
    identity: template.identity || pick(IDENTITY_POOL, random),
    personality: pickConstrained(PERSONALITIES, rule.personalityPool, random),
    emotion: pickConstrained(EMOTIONS, rule.emotionPool, random),
    language,
    preference: template.preference || pick(PREFERENCE_POOL, random),
    customerType: rule.customerTypes?.length
      ? pickConstrained(CUSTOMER_TYPES, rule.customerTypes, random)
      : (CUSTOMER_TYPES.includes(template.customerType as never)
          ? (template.customerType as (typeof CUSTOMER_TYPES)[number])
          : pick(CUSTOMER_TYPES, random)),
    enabled: true,
    avatarUrl: pickAvatarUrl(gender, random),
    generatedAt: new Date().toISOString(),
  };
}

/** 解析画像性别：旧快照缺 gender 字段时按来源模板回查（与头像回填同一逻辑，保证音色与头像一致） */
export function resolvePersonaGender(snapshot: {
  gender?: string;
  sourceTemplateId?: string;
  name?: string;
}): "male" | "female" {
  if (snapshot.gender === "male" || snapshot.gender === "female") return snapshot.gender;
  const template =
    personaTemplates.find((item) => item.id === snapshot.sourceTemplateId) ??
    personaTemplates.find((item) => item.name === snapshot.name);
  return template?.gender ?? "female";
}

/** 历史画像快照缺头像时，按来源模板性别 + 稳定种子补齐（同一会话头像恒定） */
export function ensurePersonaAvatar<
  T extends { avatarUrl?: string; sourceTemplateId?: string; name?: string },
>(snapshot: T, seed: string): T & { avatarUrl: string } {
  if (snapshot.avatarUrl) return snapshot as T & { avatarUrl: string };
  const gender = resolvePersonaGender(snapshot);
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const random = () => {
    hash = (hash * 1103515245 + 12345) >>> 0;
    return (hash % 1000) / 1000;
  };
  return { ...snapshot, avatarUrl: pickAvatarUrl(gender, random) };
}

export function toStudentPersonaView(snapshot: PersonaSnapshot) {
  return {
    id: snapshot.id,
    name: snapshot.name,
    nationality: snapshot.nationality,
    identity: snapshot.identity,
    language: snapshot.language,
    customerType: snapshot.customerType,
    avatarUrl: snapshot.avatarUrl ?? null,
  };
}

// ---------- 订单/物流/评价模拟数据（按场景生成，供工作台信息面板与 LLM 上下文使用） ----------

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
  status: "pending_payment" | "paid" | "in_transit" | "delivered" | "completed";
  statusLabel: string;
  placedAt: string;
  logistics: { carrier: string; trackingNo: string; nodes: OrderLogisticsNode[] } | null;
  review: { rating: number; content: string; at: string } | null;
  address?: OrderAddress | null;
  remark?: string | null;
  /** 售后状态：requested=待客户退货 returning=退货运输中 refunded=已退款 */
  returnStatus?: "requested" | "returning" | "refunded" | null;
}

export const ORDER_STATUS_LABELS: Record<OrderInfo["status"], string> = {
  pending_payment: "待付款",
  paid: "待发货",
  in_transit: "已发货",
  delivered: "已送达",
  completed: "已完成",
};

export const RETURN_STATUS_LABELS = {
  requested: "待客户退货",
  returning: "退货运输中",
  refunded: "已退款",
} as const;

export const storeProducts = [
  { id: "SKU-001", name: "Wireless Noise-Cancelling Earbuds", spec: "Black / USB-C / with charging case", price: 39.99, sales: 1286, stock: 452, tone: "#2f6f8f" },
  { id: "SKU-002", name: "Smart LED String Lights 10m", spec: "RGB / App control / IP65", price: 21.5, sales: 903, stock: 1210, tone: "#8f6a2f" },
  { id: "SKU-003", name: "Stainless Insulated Tumbler 600ml", spec: "Matte green / double wall", price: 15.8, sales: 2140, stock: 866, tone: "#2f8f57" },
  { id: "SKU-004", name: "Foldable Yoga Mat", spec: "6mm / TPE / carry strap", price: 18.9, sales: 758, stock: 330, tone: "#7a4f8f" },
  { id: "SKU-005", name: "Pet Interactive Feeder Toy", spec: "Medium / food-grade ABS", price: 12.6, sales: 1028, stock: 940, tone: "#b3552e" },
  { id: "SKU-006", name: "Pro Makeup Brush Set 12pcs", spec: "Vegan fiber / travel pouch", price: 24.2, sales: 664, stock: 275, tone: "#8f2f55" },
] as const;

export const storeCoupons = [
  { id: "CPN-001", title: "New Customer $5 Off", rule: "满 $30 减 $5", scope: "新客专享", validDays: 7 },
  { id: "CPN-002", title: "10% Off Storewide", rule: "全店通用 9 折", scope: "无门槛", validDays: 3 },
  { id: "CPN-003", title: "Free Shipping", rule: "满 $20 免运费", scope: "标准运输", validDays: 15 },
  { id: "CPN-004", title: "Loyal Buyer $8 Off", rule: "满 $50 减 $8", scope: "复购客户", validDays: 30 },
] as const;

const PRODUCTS = storeProducts;

const CARRIERS = ["4PX Express", "Yanwen Logistics", "Cainiao Global", "YunExpress"] as const;

/** 按买家国籍生成本地化收货地址（电话打码，贴近真实客服系统展示） */
const ADDRESS_BOOK: Record<string, { country: string; cc: string; cities: readonly string[] }> = {
  美国: { country: "United States", cc: "1", cities: ["New York, NY", "Los Angeles, CA", "Chicago, IL", "Houston, TX"] },
  英国: { country: "United Kingdom", cc: "44", cities: ["London", "Manchester", "Birmingham"] },
  加拿大: { country: "Canada", cc: "1", cities: ["Toronto, ON", "Vancouver, BC", "Montreal, QC"] },
  澳大利亚: { country: "Australia", cc: "61", cities: ["Sydney, NSW", "Melbourne, VIC", "Brisbane, QLD"] },
  德国: { country: "Germany", cc: "49", cities: ["Berlin", "Munich", "Hamburg"] },
  法国: { country: "France", cc: "33", cities: ["Paris", "Lyon", "Marseille"] },
  西班牙: { country: "Spain", cc: "34", cities: ["Madrid", "Barcelona", "Valencia"] },
  意大利: { country: "Italy", cc: "39", cities: ["Milan", "Rome", "Turin"] },
  日本: { country: "Japan", cc: "81", cities: ["Tokyo", "Osaka", "Nagoya"] },
  巴西: { country: "Brazil", cc: "55", cities: ["São Paulo", "Rio de Janeiro", "Curitiba"] },
};

const STREETS = [
  "Maple Street", "Oak Avenue", "Cedar Lane", "Riverside Drive",
  "Hillcrest Road", "Park Boulevard", "Sunset Avenue", "Elm Street",
] as const;

export function buildOrderAddress(
  persona: { name?: string; nationality?: string } | undefined,
  random: () => number = Math.random,
): OrderAddress {
  const entry = ADDRESS_BOOK[persona?.nationality ?? ""] ?? ADDRESS_BOOK["美国"]!;
  const last4 = String(1000 + Math.floor(random() * 9000));
  return {
    recipient: persona?.name ?? "Customer",
    line1: `${100 + Math.floor(random() * 899)} ${pick(STREETS, random)}${random() < 0.4 ? `, Apt ${1 + Math.floor(random() * 30)}` : ""}`,
    city: pick(entry.cities, random),
    country: entry.country,
    phone: `+${entry.cc} ••• •••• ${last4}`,
  };
}

const LOGISTICS_STEPS = [
  { key: "pickup", label: "揽收" },
  { key: "domestic", label: "国内运输" },
  { key: "linehaul", label: "国际干线" },
  { key: "customs", label: "清关" },
  { key: "delivery", label: "派送" },
] as const;

function daysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

function buildLogistics(
  now: Date,
  random: () => number,
  reachedIndex: number,
  startDaysAgo: number,
): OrderInfo["logistics"] {
  const nodes: OrderLogisticsNode[] = LOGISTICS_STEPS.map((step, index) => {
    const done = index < reachedIndex;
    const current = index === reachedIndex;
    return {
      key: step.key,
      label: step.label,
      at: done || current ? daysAgo(now, Math.max(startDaysAgo - index * 2, 0)) : null,
      done,
      current,
    };
  });
  return {
    carrier: pick(CARRIERS, random),
    trackingNo: `LP${Math.floor(random() * 9_000_000_000 + 1_000_000_000)}`,
    nodes,
  };
}

export type OrderProductPool = ReadonlyArray<{ name: string; spec: string; price: number; imageUrl?: string | null }>;

function orderBase(
  random: () => number,
  now: Date,
  products: OrderProductPool,
  persona?: { name?: string; nationality?: string },
) {
  const product = pick(products.length > 0 ? products : PRODUCTS, random);
  const quantity = 1 + Math.floor(random() * 3);
  return {
    orderNo: `PO-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}-${Math.floor(random() * 900000 + 100000)}`,
    productName: product.name,
    productSpec: product.spec,
    productImage: ("imageUrl" in product ? (product.imageUrl as string | null | undefined) : null) ?? null,
    quantity,
    unitPrice: product.price,
    currency: "USD",
    totalAmount: Math.round(product.price * quantity * 100) / 100,
    address: buildOrderAddress(persona, random),
    remark: null,
    returnStatus: null,
  };
}

/** 差评文案池（订单生成期预设差评从中抽取；闭环评价 LLM 失败时也作兜底） */
export const NEGATIVE_REVIEW_POOL = [
  "Item arrived damaged and looks different from the listing. Very disappointed with this purchase.",
  "The color is completely different from the photos. Not what I ordered at all.",
  "Took almost a month to arrive and the box was crushed. The product inside has scratches.",
  "Quality feels much cheaper than described. The stitching started coming apart after two days.",
  "Wrong size was delivered even though I ordered according to the size chart. Very frustrating.",
  "The item stopped working after the first use. I expected much better for this price.",
  "Package arrived with a part missing. Now I can't use it at all until this is fixed.",
  "Smells strongly of chemicals and the material feels flimsy. Not as advertised.",
] as const;

/** 好评文案池 */
export const POSITIVE_REVIEW_POOL = [
  "Good quality and fast shipping. Would consider buying again.",
  "Exactly as described and nicely packaged. The seller answered my questions quickly.",
  "Arrived earlier than expected and works perfectly. Very happy with this purchase.",
  "Great value for the price. The material feels solid and well made.",
  "Second time ordering from this store, consistent quality every time. Recommended.",
  "Lovely product and the customer service was friendly and helpful. Five stars.",
  "Shipping to my country was smooth and tracking updated regularly. Item is great.",
  "Better than I expected from the photos. My family loves it too.",
] as const;

/** 根据业务环节生成当前咨询关联的订单；售前咨询返回 null */
export function generateOrderForScenario(
  stage: BusinessStage,
  random: () => number = Math.random,
  now: Date = new Date(),
  products: OrderProductPool = PRODUCTS,
  persona?: { name?: string; nationality?: string },
): OrderInfo | null {
  if (stage === "pre_sale") return null;
  const base = orderBase(random, now, products, persona);
  if (stage === "in_sale") {
    // 一半催付（待付款），一半物流跟进（卡在清关）
    if (random() < 0.5) {
      return {
        ...base,
        status: "pending_payment",
        statusLabel: "待付款",
        placedAt: daysAgo(now, 2),
        logistics: null,
        review: null,
      };
    }
    return {
      ...base,
      status: "in_transit",
      statusLabel: "国际运输中（清关）",
      placedAt: daysAgo(now, 12),
      logistics: buildLogistics(now, random, 3, 10),
      review: null,
    };
  }
  if (stage === "after_sale") {
    const negativeReview = random() < 0.5;
    return {
      ...base,
      status: "delivered",
      statusLabel: "已送达",
      placedAt: daysAgo(now, 20),
      logistics: buildLogistics(now, random, 5, 18),
      review: negativeReview
        ? {
            rating: 1 + Math.floor(random() * 2),
            content: pick(NEGATIVE_REVIEW_POOL, random),
            at: daysAgo(now, 1),
          }
        : null,
    };
  }
  // customer_care：历史已完成订单
  return {
    ...base,
    status: "completed",
    statusLabel: "已完成",
    placedAt: daysAgo(now, 45 + Math.floor(random() * 60)),
    logistics: buildLogistics(now, random, 5, 40),
    review: {
      rating: 4 + Math.floor(random() * 2),
      content: pick(POSITIVE_REVIEW_POOL, random),
      at: daysAgo(now, 40),
    },
  };
}

/** 买家历史订单数量：新客无历史，老客/粉丝有若干笔 */
export function buyerHistoryOrderCount(customerType: string | undefined, random: () => number = Math.random): number {
  if (!customerType || customerType === "潜在意向客") return 0;
  if (customerType === "复购老客") return 2 + Math.floor(random() * 2);
  return 1 + Math.floor(random() * 2); // 粉丝客 / 沉睡客
}

const HISTORY_KINDS = ["paid", "in_transit", "delivered", "after_sale", "completed"] as const;

/**
 * 生成买家历史订单（当前咨询订单之外的过往订单），
 * 覆盖 待发货/已发货/已送达/售后中/已完成 等状态，供订单页签查看与售前售后操作。
 */
export function generateBuyerOrderHistory(
  count: number,
  random: () => number = Math.random,
  now: Date = new Date(),
  products: OrderProductPool = PRODUCTS,
  persona?: { name?: string; nationality?: string },
): OrderInfo[] {
  const orders: OrderInfo[] = [];
  for (let index = 0; index < count; index += 1) {
    const base = orderBase(random, now, products, persona);
    const kind = pick(HISTORY_KINDS, random);
    if (kind === "paid") {
      orders.push({
        ...base,
        status: "paid",
        statusLabel: ORDER_STATUS_LABELS.paid,
        placedAt: daysAgo(now, 1 + Math.floor(random() * 3)),
        logistics: null,
        review: null,
      });
    } else if (kind === "in_transit") {
      orders.push({
        ...base,
        status: "in_transit",
        statusLabel: ORDER_STATUS_LABELS.in_transit,
        placedAt: daysAgo(now, 5 + Math.floor(random() * 10)),
        logistics: buildLogistics(now, random, 2 + Math.floor(random() * 2), 8),
        review: null,
      });
    } else if (kind === "delivered") {
      orders.push({
        ...base,
        status: "delivered",
        statusLabel: ORDER_STATUS_LABELS.delivered,
        placedAt: daysAgo(now, 15 + Math.floor(random() * 20)),
        logistics: buildLogistics(now, random, 5, 15),
        review: null,
      });
    } else if (kind === "after_sale") {
      const returnStatus = pick(["requested", "returning", "refunded"] as const, random);
      orders.push({
        ...base,
        status: "delivered",
        statusLabel: ORDER_STATUS_LABELS.delivered,
        placedAt: daysAgo(now, 20 + Math.floor(random() * 20)),
        logistics: buildLogistics(now, random, 5, 20),
        review: null,
        returnStatus,
      });
    } else {
      orders.push({
        ...base,
        status: "completed",
        statusLabel: ORDER_STATUS_LABELS.completed,
        placedAt: daysAgo(now, 40 + Math.floor(random() * 90)),
        logistics: buildLogistics(now, random, 5, 45),
        review:
          random() < 0.6
            ? {
                rating: 4 + Math.floor(random() * 2),
                content: pick(POSITIVE_REVIEW_POOL, random),
                at: daysAgo(now, 35 + Math.floor(random() * 30)),
              }
            : null,
      });
    }
  }
  // 按下单时间倒序，最近的在前
  return orders.sort((a, b) => (a.placedAt < b.placedAt ? 1 : -1));
}

