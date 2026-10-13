import { nativeLanguageOf } from "./language";
import {
  CUSTOMER_TYPES,
  EMOTIONS,
  NATIONALITIES,
  PERSONALITIES,
  SUPPORTED_LANGUAGES,
  type BusinessStage,
  type BuyerRole,
  type DecisionStyle,
  personaDisplayName,
  type OrderKind,
  type ProductDetails,
  type PersonaTemplate,
  type TrainingScenario,
} from "@cecs/contracts";

export const trainingScenarios = [
  { id: "PRE-001", name: "新品咨询与卖点介绍", stage: "pre_sale", objective: "识别需求，用合规英文介绍新品卖点", channel: "chat", orderKind: "none" },
  { id: "PRE-003", name: "尺码与适配咨询", stage: "pre_sale", objective: "根据身材数据推荐尺码，说明尺码表差异", channel: "chat", orderKind: "none" },
  { id: "PRE-004", name: "运费、关税与时效咨询", stage: "pre_sale", objective: "讲清运费、关税由谁承担和各地区时效", channel: "chat", orderKind: "none" },
  { id: "PRE-005", name: "议价与批量询价", stage: "pre_sale", objective: "守住价格底线，给出阶梯价或赠品方案", channel: "chat", orderKind: "none" },
  { id: "PRE-006", name: "新品推广邮件", stage: "pre_sale", objective: "写一封不夸大、有行动号召的新品推广邮件", channel: "mail", orderKind: "none" },
  { id: "PRE-002", name: "新客开发邮件", stage: "pre_sale", objective: "完成新客开发邮件并修正违规宣传用语", channel: "mail", orderKind: "none" },
  { id: "IN-001", name: "未付款订单催付", stage: "in_sale", objective: "不施压地说明库存保留与付款安排", channel: "chat", orderKind: "pending_payment" },
  { id: "IN-003", name: "修改地址或规格", stage: "in_sale", objective: "确认是否已发货，给出能改和不能改的方案", channel: "chat", orderKind: "paid" },
  { id: "IN-004", name: "取消订单挽留", stage: "in_sale", objective: "了解取消原因，不强留，给出替代方案", channel: "chat", orderKind: "paid" },
  { id: "IN-005", name: "发货延迟说明", stage: "in_sale", objective: "主动告知延迟原因和新的发货时间", channel: "chat", orderKind: "paid" },
  { id: "IN-007", name: "订单进度跟进", stage: "in_sale", objective: "查清物流节点，给出预计到达时间并主动跟进", channel: "chat", orderKind: "in_transit" },
  { id: "IN-002", name: "清关延误安抚", stage: "in_sale", objective: "同步物流节点并安抚焦虑客户", channel: "chat", orderKind: "customs" },
  { id: "IN-006", name: "丢件与派送失败", stage: "in_sale", objective: "核实轨迹，协调重派、补发或退款", channel: "chat", orderKind: "delivery_failed" },
  { id: "AFTER-001", name: "货损退款协商", stage: "after_sale", objective: "核实证据并提出退款、补发或补偿方案", channel: "chat", orderKind: "delivered" },
  { id: "AFTER-003", name: "错发漏发处理", stage: "after_sale", objective: "确认错发事实，安排补发与退回", channel: "chat", orderKind: "delivered" },
  { id: "AFTER-004", name: "质量争议处理", stage: "after_sale", objective: "区分质量问题和使用不当，给出合理方案", channel: "chat", orderKind: "delivered" },
  { id: "AFTER-005", name: "退换货申请", stage: "after_sale", objective: "按政策办理换尺码或退货，说明流程和运费", channel: "chat", orderKind: "delivered" },
  { id: "AFTER-006", name: "平台纠纷协商", stage: "after_sale", objective: "买家已开纠纷，协商撤诉并留下证据", channel: "chat", orderKind: "delivered" },
  { id: "AFTER-007", name: "好评维系", stage: "after_sale", objective: "感谢好评，自然引导复购和晒单", channel: "chat", orderKind: "delivered_positive" },
  { id: "AFTER-002", name: "差评挽回", stage: "after_sale", objective: "回应负面评价并推动问题闭环", channel: "chat", orderKind: "delivered_negative" },
  { id: "CARE-003", name: "潜在意向客信任建立", stage: "customer_care", objective: "解答顾虑、展示口碑，促成首单", channel: "chat", orderKind: "none", customerTypes: ["潜在意向客"] },
  { id: "CARE-001", name: "复购老客优惠推送", stage: "customer_care", objective: "结合历史偏好推送合适的优惠", channel: "chat", orderKind: "completed", customerTypes: ["复购老客"] },
  { id: "CARE-004", name: "粉丝客节日关怀", stage: "customer_care", objective: "节日问候与新品内测邀请，不硬推销", channel: "mail", orderKind: "completed", customerTypes: ["粉丝客"] },
  { id: "CARE-002", name: "沉睡客户唤醒", stage: "customer_care", objective: "以关怀和新品信息重新建立联系", channel: "chat", orderKind: "completed", customerTypes: ["沉睡客"] },
].map((item) => ({ ...item, defaultLanguage: "en-US", enabled: true })) as TrainingScenario[];

/**
 * 内置买家画像模板（D-33）：每条是“一类买家”，按 买家角色 × 决策风格 × 客户价值层 铺开，再补关注点和沟通方式。
 * 名称 = 决策风格 + 买家角色；一次性的购买情境写在场景剧本里，不放进画像。
 * 姓名、性别、头像在每次会话时随机生成；国籍、语言、性格、情绪是默认值，任务的随机规则可以改掉。
 */
const PERSONA_ROWS: Array<[string, BuyerRole, DecisionStyle, (typeof CUSTOMER_TYPES)[number], string[], string, (typeof NATIONALITIES)[number], (typeof SUPPORTED_LANGUAGES)[number], (typeof PERSONALITIES)[number], (typeof EMOTIONS)[number]]> = [
  // 潜在意向客
  ["P-001", "个人消费者", "价格敏感型", "潜在意向客", ["价格优惠", "物流时效"], "习惯先在几家店比价，喜欢问有没有优惠码", "美国", "en-US", "直接高效", "期待"],
  ["P-002", "个人消费者", "选择困难型", "潜在意向客", ["尺码合身", "退换政策"], "常在两个规格之间拿不定主意", "日本", "en-US", "犹豫保守", "焦虑"],
  ["P-003", "个人消费者", "品质导向型", "潜在意向客", ["材质参数", "售后保修"], "第一次在这家店买，先问清楚再下单", "德国", "en-US", "理性谨慎", "平静"],
  ["P-004", "个人消费者", "品牌口碑型", "潜在意向客", ["正品资质", "退换政策"], "被网购坑过，特别在意店铺靠不靠谱", "西班牙", "es-ES", "敏感挑剔", "焦虑"],
  ["P-005", "礼品购买者", "选择困难型", "潜在意向客", ["包装礼盒", "物流时效"], "不确定对方喜欢哪款，希望客服推荐", "英国", "en-US", "犹豫保守", "焦虑"],
  ["P-006", "礼品购买者", "冲动下单型", "潜在意向客", ["物流时效", "包装礼盒"], "临时想起要送礼，时间很紧", "加拿大", "en-US", "直接高效", "焦虑"],
  ["P-007", "小B店主", "价格敏感型", "潜在意向客", ["批量价格", "物流时效"], "开小店，想先小批量试单", "意大利", "en-US", "理性谨慎", "平静"],
  ["P-008", "批发采购商", "品质导向型", "潜在意向客", ["材质参数", "正品资质", "批量价格"], "要求质量稳定，会问质检报告", "德国", "en-US", "敏感挑剔", "平静"],
  ["P-009", "企业采购", "品牌口碑型", "潜在意向客", ["发票交期", "正品资质"], "替公司采购，要发票和确定的交期", "加拿大", "en-US", "直接高效", "平静"],
  ["P-010", "代购转售", "价格敏感型", "潜在意向客", ["批量价格", "包装礼盒"], "要留出转卖利润，包装要能直接转售", "美国", "en-US", "直接高效", "平静"],
  ["P-011", "个人消费者", "享受逛买型", "潜在意向客", ["新品", "价格优惠"], "随便逛逛，聊得投机就多买几件", "巴西", "en-US", "友好健谈", "期待"],
  ["P-012", "个人消费者", "冲动下单型", "潜在意向客", ["价格优惠", "物流时效"], "看到限时优惠就想马上下单", "澳大利亚", "en-US", "友好健谈", "期待"],
  // 复购老客
  ["P-013", "个人消费者", "习惯忠诚型", "复购老客", ["尺码合身", "价格优惠"], "上次买的很合身，想再买同款别的颜色", "美国", "en-US", "友好健谈", "平静"],
  ["P-014", "个人消费者", "品质导向型", "复购老客", ["材质参数", "售后保修"], "上次用着不错，但对一个小问题有意见", "法国", "fr-FR", "敏感挑剔", "不满"],
  ["P-015", "小B店主", "习惯忠诚型", "复购老客", ["批量价格", "物流时效"], "固定在这家补货，关心补货节奏和老客价", "法国", "fr-FR", "理性谨慎", "平静"],
  ["P-016", "批发采购商", "价格敏感型", "复购老客", ["批量价格", "发票交期"], "量大，每次都要谈阶梯价和账期", "意大利", "en-US", "直接高效", "平静"],
  ["P-017", "批发采购商", "品质导向型", "复购老客", ["材质参数", "批量价格"], "上一批有少量瑕疵，这次要求更严", "德国", "en-US", "敏感挑剔", "不满"],
  ["P-018", "企业采购", "习惯忠诚型", "复购老客", ["发票交期", "批量价格"], "每季度给员工采购一次", "英国", "en-US", "理性谨慎", "平静"],
  ["P-019", "代购转售", "价格敏感型", "复购老客", ["批量价格", "物流时效"], "帮家人朋友代买，常要求合并发货", "加拿大", "en-US", "直接高效", "期待"],
  ["P-020", "礼品购买者", "品牌口碑型", "复购老客", ["包装礼盒", "正品资质"], "上次送的礼物对方很喜欢，又来买", "日本", "en-US", "友好健谈", "期待"],
  ["P-021", "个人消费者", "价格敏感型", "复购老客", ["价格优惠", "退换政策"], "觉得老客户应该有专属优惠", "西班牙", "es-ES", "敏感挑剔", "期待"],
  ["P-022", "小B店主", "新奇尝鲜型", "复购老客", ["新品", "批量价格"], "店里要不断上新，常问有没有新款", "澳大利亚", "en-US", "友好健谈", "期待"],
  ["P-023", "个人消费者", "选择困难型", "复购老客", ["尺码合身", "材质参数"], "想换新款，但拿不准和旧款的差别", "英国", "en-US", "犹豫保守", "平静"],
  ["P-024", "企业采购", "品质导向型", "复购老客", ["正品资质", "售后保修", "发票交期"], "公司对供应商有审核要求", "日本", "en-US", "敏感挑剔", "平静"],
  // 粉丝客
  ["P-025", "个人消费者", "新奇尝鲜型", "粉丝客", ["新品", "包装礼盒"], "会在社媒晒单，很想参加新品试用", "英国", "en-US", "友好健谈", "期待"],
  ["P-026", "个人消费者", "享受逛买型", "粉丝客", ["新品", "价格优惠"], "店铺的忠实粉丝，喜欢和客服聊天", "美国", "en-US", "友好健谈", "期待"],
  ["P-027", "个人消费者", "品牌口碑型", "粉丝客", ["正品资质", "新品"], "经常给店铺写好评，在意店铺口碑", "巴西", "en-US", "友好健谈", "平静"],
  ["P-028", "个人消费者", "冲动下单型", "粉丝客", ["新品", "物流时效"], "新品一上架就想第一个拿到", "澳大利亚", "en-US", "直接高效", "期待"],
  ["P-029", "个人消费者", "品质导向型", "粉丝客", ["材质参数", "新品"], "懂行的老粉，会认真提改进建议", "德国", "en-US", "敏感挑剔", "平静"],
  ["P-030", "小B店主", "习惯忠诚型", "粉丝客", ["新品", "批量价格"], "合作很久，愿意帮店铺试推新品", "法国", "fr-FR", "友好健谈", "期待"],
  ["P-031", "代购转售", "新奇尝鲜型", "粉丝客", ["新品", "批量价格"], "在社群里转卖，追爆款", "西班牙", "es-ES", "直接高效", "期待"],
  ["P-032", "礼品购买者", "享受逛买型", "粉丝客", ["包装礼盒", "新品"], "每逢节日都会来挑礼物", "加拿大", "en-US", "友好健谈", "期待"],
  // 沉睡客
  ["P-033", "个人消费者", "价格敏感型", "沉睡客", ["价格优惠", "物流时效"], "半年没下单，被别家的优惠吸引走了", "美国", "en-US", "直接高效", "平静"],
  ["P-034", "个人消费者", "品质导向型", "沉睡客", ["售后保修", "退换政策"], "上次售后体验一般，之后没再来", "法国", "fr-FR", "敏感挑剔", "不满"],
  ["P-035", "个人消费者", "习惯忠诚型", "沉睡客", ["尺码合身", "新品"], "以前常买，后来慢慢忘了这家店", "加拿大", "en-US", "友好健谈", "平静"],
  ["P-036", "个人消费者", "选择困难型", "沉睡客", ["退换政策", "价格优惠"], "收到过推送，但一直没找到下单的理由", "日本", "en-US", "犹豫保守", "平静"],
  ["P-037", "小B店主", "价格敏感型", "沉睡客", ["批量价格", "物流时效"], "生意淡了，暂停了补货", "意大利", "en-US", "理性谨慎", "平静"],
  ["P-038", "批发采购商", "品牌口碑型", "沉睡客", ["正品资质", "批量价格"], "换了别的供应商，正在观望", "德国", "en-US", "理性谨慎", "平静"],
  ["P-039", "礼品购买者", "冲动下单型", "沉睡客", ["包装礼盒", "价格优惠"], "只在节日前才会想起来买", "英国", "en-US", "友好健谈", "平静"],
  ["P-040", "个人消费者", "新奇尝鲜型", "沉睡客", ["新品", "价格优惠"], "早期粉丝，觉得店里很久没有新东西了", "巴西", "en-US", "友好健谈", "平静"],
];

/** 由结构化字段派生旧字段：identity = 买家角色；preference = 关注点 + 补充说明（旧提示词和旧会话快照仍读这两个字段） */
export function derivePersonaLegacy(input: { buyerRole?: string | null; concerns?: string[]; note?: string | null; identity?: string; preference?: string }) {
  const concerns = (input.concerns ?? []).filter(Boolean);
  return {
    identity: input.buyerRole || input.identity || "",
    preference: [concerns.length ? `看重${concerns.join("、")}` : "", input.note?.trim() ?? ""].filter(Boolean).join("；") || input.preference || "",
  };
}

export const personaTemplates = PERSONA_ROWS.map(([id, buyerRole, decisionStyle, customerType, concerns, note, nationality, language, personality, emotion]) => ({
  id,
  name: personaDisplayName(decisionStyle, buyerRole),
  gender: "female" as const,
  nationality,
  personality,
  emotion,
  language,
  customerType,
  buyerRole,
  decisionStyle,
  concerns,
  note,
  ...derivePersonaLegacy({ buyerRole, concerns, note }),
  enabled: true,
})) as Array<PersonaTemplate & { buyerRole: BuyerRole; decisionStyle: DecisionStyle; concerns: string[]; note: string }>;

/** D-33 之前的内置模板（人名）：只用来给很早的会话快照回填性别和头像 */
const LEGACY_TEMPLATE_GENDER: Record<string, { name: string; gender: "male" | "female" }> = Object.fromEntries(
  ([
    ["P-001", "Jessica Miller", "female"], ["P-002", "Lukas Schneider", "male"], ["P-003", "Camille Bernard", "female"], ["P-004", "Yuki Tanaka", "female"],
    ["P-005", "Daniel Johnson", "male"], ["P-006", "Olivia Brown", "female"], ["P-007", "Sophie Martin", "female"], ["P-008", "Mateo Garcia", "male"],
    ["P-009", "Emma Wilson", "female"], ["P-010", "Marco Rossi", "male"], ["P-011", "Ana Souza", "female"], ["P-012", "Noah Williams", "male"],
    ["P-013", "Charlotte Taylor", "female"], ["P-014", "Felix Weber", "male"], ["P-015", "Mia Thompson", "female"], ["P-016", "Hana Sato", "female"],
    ["P-017", "Isabella Romano", "female"], ["P-018", "Lucas Silva", "male"], ["P-019", "Amelia Clark", "female"], ["P-020", "Diego Fernandez", "male"],
  ] as const).map(([id, name, gender]) => [id, { name, gender }]),
);

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
  "zero risk", "number one brand", "guaranteed to cure", "100% natural cure", "no customs fees guaranteed",
  "fake reviews", "review for refund", "delete your review", "undervalue the parcel", "mark it as a gift",
  "brand replica", "1:1 copy", "差评就退款", "好评返现", "刷单",
  "代写好评", "包过海关", "礼品申报", "改低申报价", "正品授权（无证明）",
  "绝对不会坏", "最好的产品", "第一品牌", "全球销量冠军",
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
  "I have noted your request and will follow up shortly.",
  "Could you tell me the size you usually wear?",
  "This item ships from our overseas warehouse.",
  "Import duties are determined by your local customs office.",
  "I have attached the size chart for your reference.",
  "We can update the shipping address before the parcel is dispatched.",
  "The return label has been sent to your email.",
  "Once we receive the returned item, the refund will be processed.",
  "I apologize for the inconvenience caused by the delay.",
  "Your satisfaction is important to us, so please let me know if anything is unclear.",
  "Thank you for shopping with us, and have a great day.",
  "I will stay on this case until it is fully resolved.",
  "As a returning customer, you can use this coupon on your next order.",
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

export interface PersonaSnapshot extends Omit<PersonaTemplate, "language"> {
  /** 买家母语代码（de-DE 等），语音做不到时由 API 层改为英语（D-43） */
  language: string;
  sourceTemplateId: string;
  /** 抽中的画像模板名称（如“价格敏感型个人消费者”），只给老师看 */
  templateName?: string;
  generatedAt: string;
  avatarUrl: string;
  /** 头像类型；老快照缺省视为 photo（有 avatarUrl）或回填 */
  avatarKind?: AvatarKind;
}

/** 头像类型：default=平台默认灰色剪影；initial=首字母+底色；photo=生活照；object=非人脸（宠物/风景/动漫等） */
export type AvatarKind = "default" | "initial" | "photo" | "object";

/** 头像大区：eu 欧美白人 / la 拉丁 / ea 东亚 / sea 东南亚 / sa 南亚 / me 中东 / af 非洲裔 */
export type AvatarRegion = "eu" | "la" | "ea" | "sea" | "sa" | "me" | "af";

export const AVATAR_REGIONS: readonly AvatarRegion[] = ["eu", "la", "ea", "sea", "sa", "me", "af"];

/**
 * 头像库（apps/portal/public/avatars）：
 * - portraits：a-<区>-<f|m>-NN.jpg 生活化人像，按大区和性别给出数量（序号从 01 连续）；
 * - object：o-NN 非人脸（宠物/风景/物件等，不分性别）。
 * 旧的 f-NN / m-NN / pf-NN / pm-NN 文件保留（老会话快照引用），但不再进抽取池。
 */
export const AVATAR_LIBRARY = {
  portraits: {
    eu: { female: 95, male: 95 },
    la: { female: 28, male: 27 },
    ea: { female: 28, male: 28 },
    sea: { female: 24, male: 24 },
    sa: { female: 24, male: 24 },
    me: { female: 24, male: 24 },
    af: { female: 24, male: 24 },
  } as Record<AvatarRegion, Record<"male" | "female", number>>,
  object: 30,
};

/** 头像类型占比（累计阈值）：默认剪影 10% / 首字母 10% / 人像 75% / 非人脸 5% */
export const AVATAR_KIND_WEIGHTS: ReadonlyArray<readonly [AvatarKind, number]> = [
  ["default", 0.1],
  ["initial", 0.2],
  ["photo", 0.95],
  ["object", 1],
];

/** 抽人像时优先选买家国籍所在大区的概率（其余 15% 在其他大区抽，模拟移民混居） */
export const AVATAR_SAME_REGION_RATE = 0.85;

const NATIONALITY_REGION: Record<string, AvatarRegion> = {
  美国: "eu", 英国: "eu", 加拿大: "eu", 澳大利亚: "eu", 新西兰: "eu", 德国: "eu", 法国: "eu", 西班牙: "eu", 意大利: "eu",
  荷兰: "eu", 瑞典: "eu", 俄罗斯: "eu", 波兰: "eu", 爱尔兰: "eu", 葡萄牙: "eu", 瑞士: "eu",
  巴西: "la", 墨西哥: "la", 阿根廷: "la", 智利: "la", 哥伦比亚: "la", 秘鲁: "la",
  日本: "ea", 韩国: "ea", 中国: "ea", 中国台湾: "ea", 中国香港: "ea",
  泰国: "sea", 越南: "sea", 菲律宾: "sea", 印度尼西亚: "sea", 印尼: "sea", 马来西亚: "sea", 新加坡: "sea",
  印度: "sa", 巴基斯坦: "sa", 孟加拉国: "sa", 斯里兰卡: "sa",
  沙特阿拉伯: "me", 沙特: "me", 阿联酋: "me", 土耳其: "me", 伊朗: "me", 埃及: "me", 以色列: "me",
  尼日利亚: "af", 南非: "af", 肯尼亚: "af", 加纳: "af",
};

/** 国籍 → 头像大区；未知国籍按 eu 处理 */
export function avatarRegionOf(nationality?: string): AvatarRegion {
  return NATIONALITY_REGION[nationality ?? ""] ?? "eu";
}

function padIndex(n: number): string {
  return String(n).padStart(2, "0");
}

/** 按类型抽头像：先抽类型，再抽图。default/initial 的 avatarUrl 为空字符串；人像按国籍所在大区优先（85%）+性别抽 */
export function pickAvatar(
  gender: "male" | "female",
  random: () => number = Math.random,
  nationality?: string,
): { avatarKind: AvatarKind; avatarUrl: string } {
  const roll = random();
  const kind = (AVATAR_KIND_WEIGHTS.find(([, limit]) => roll < limit) ?? AVATAR_KIND_WEIGHTS[AVATAR_KIND_WEIGHTS.length - 1]!)[0];
  if (kind === "default" || kind === "initial") return { avatarKind: kind, avatarUrl: "" };
  if (kind === "object") {
    const index = 1 + Math.min(AVATAR_LIBRARY.object - 1, Math.floor(random() * AVATAR_LIBRARY.object));
    return { avatarKind: kind, avatarUrl: `avatars/o-${padIndex(index)}.jpg` };
  }
  const home = avatarRegionOf(nationality);
  const others = AVATAR_REGIONS.filter((region) => region !== home && AVATAR_LIBRARY.portraits[region][gender] > 0);
  let region: AvatarRegion = home;
  if (AVATAR_LIBRARY.portraits[home][gender] === 0 || (others.length > 0 && random() >= AVATAR_SAME_REGION_RATE)) {
    // 其他大区按库存量加权
    const total = others.reduce((sum, item) => sum + AVATAR_LIBRARY.portraits[item][gender], 0);
    let target = random() * total;
    region = others[others.length - 1] ?? home;
    for (const item of others) {
      target -= AVATAR_LIBRARY.portraits[item][gender];
      if (target < 0) { region = item; break; }
    }
  } else {
    random(); // 保持两条分支消耗的随机数一致，便于推演
  }
  const count = Math.max(1, AVATAR_LIBRARY.portraits[region][gender]);
  const index = 1 + Math.min(count - 1, Math.floor(random() * count));
  return { avatarKind: kind, avatarUrl: `avatars/a-${region}-${gender === "female" ? "f" : "m"}-${padIndex(index)}.jpg` };
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
  const nationality = pick(NATIONALITIES, random);
  return {
    ...template,
    sourceTemplateId: template.id,
    id: `SNAP-${Date.now()}-${Math.floor(random() * 10000)}`,
    nationality,
    personality: pick(PERSONALITIES, random),
    emotion: pick(EMOTIONS, random),
    language: "en-US",
    customerType: pick(CUSTOMER_TYPES, random),
    ...pickAvatar(template.gender, random, nationality),
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

/**
 * 会话画像随机规则（来自教师任务配置，D-33 两步）：
 * 第一步“从哪些人群里抽”——customerTypes / buyerRoles / decisionStyles / templateIds 只筛选模板，不改模板的身份；
 * 第二步“每次随机变化的”——nationalityPool / personalityPool / emotionPool / languages 覆盖模板的默认值，不选就用默认值。
 */
export interface PersonaRule {
  nationalityPool?: string[];
  personalityPool?: string[];
  emotionPool?: string[];
  languages?: string[];
  customerTypes?: string[];
  buyerRoles?: string[];
  decisionStyles?: string[];
  templateIds?: string[];
}

/** 可参与抽取的画像模板最小形状（来自 DB persona_templates，教师可维护） */
export interface PersonaTemplateBase {
  id: string;
  name?: string;
  identity: string;
  preference: string;
  customerType: string;
  buyerRole?: string | null;
  decisionStyle?: string | null;
  concerns?: string[];
  note?: string | null;
  /** D3：模板上的这些字段在任务规则没约束时生效 */
  nationality?: string;
  personality?: string;
  emotion?: string;
  language?: string;
}

/** 第一步：按任务规则筛出可以抽的模板（指定了画像就只用指定的） */
export function filterPersonaTemplates<T extends PersonaTemplateBase>(templates: readonly T[], rule: PersonaRule = {}): T[] {
  if (rule.templateIds?.length) return templates.filter((item) => rule.templateIds!.includes(item.id));
  return templates.filter((item) =>
    (!rule.customerTypes?.length || rule.customerTypes.includes(item.customerType))
    && (!rule.buyerRoles?.length || rule.buyerRoles.includes(item.buyerRole ?? ""))
    && (!rule.decisionStyles?.length || rule.decisionStyles.includes(item.decisionStyle ?? "")));
}

export class NoMatchingPersonaError extends Error {
  constructor() {
    super("NO_MATCHING_PERSONA");
  }
}

function pickConstrained<T extends string>(
  all: readonly T[],
  pool: string[] | undefined,
  random: () => number,
  fallback?: string,
): T {
  // 规则没约束时沿用模板值（D3），模板值不合法才完全随机
  if (!pool?.length && fallback && all.includes(fallback as T)) return fallback as T;
  const allowed = pool?.length ? all.filter((item) => pool.includes(item)) : all;
  return pick(allowed.length ? allowed : all, random);
}

/**
 * 真随机画像合成：先按规则筛模板（身份、决策风格、关注点、客户价值层原样保留），
 * 姓名按国籍从姓名池生成（性别随机、姓名-国籍强绑定），国籍/性格/情绪/语言受规则约束。学生开始前不可预知。
 * 没有符合规则的模板时抛 NoMatchingPersonaError。
 */
export function composePersonaWithRule(
  templates: readonly PersonaTemplateBase[],
  rule: PersonaRule = {},
  random: () => number = Math.random,
): PersonaSnapshot {
  const pool = filterPersonaTemplates(templates.length ? templates : personaTemplates, rule);
  if (!pool.length) throw new NoMatchingPersonaError();
  const template = pick(pool, random);
  const nationality = pickConstrained(NATIONALITIES, rule.nationalityPool, random, template.nationality);
  const gender: "male" | "female" = random() < 0.5 ? "male" : "female";
  const namePool = NAME_POOLS[nationality] ?? EN_POOL;
  const name = `${pick(gender === "male" ? namePool.male : namePool.female, random)} ${pick(namePool.surnames, random)}`;
  // 语言：任务规则指定了就按规则；否则说国籍的母语（D-43，模板语言不再参与；语音做不到时 API 层再改成英语）
  const language: string = rule.languages?.length
    ? pickConstrained(SUPPORTED_LANGUAGES, rule.languages, random)
    : nativeLanguageOf(nationality);
  return {
    id: `SNAP-${Date.now()}-${Math.floor(random() * 10000)}`,
    sourceTemplateId: template.id,
    templateName: template.name ?? personaDisplayName(template.decisionStyle, template.buyerRole),
    name,
    gender,
    nationality,
    identity: template.identity || template.buyerRole || pick(IDENTITY_POOL, random),
    buyerRole: template.buyerRole ?? null,
    decisionStyle: template.decisionStyle ?? null,
    concerns: template.concerns ?? [],
    note: template.note ?? null,
    personality: pickConstrained(PERSONALITIES, rule.personalityPool, random, template.personality),
    emotion: pickConstrained(EMOTIONS, rule.emotionPool, random, template.emotion),
    language,
    preference: template.preference || pick(PREFERENCE_POOL, random),
    customerType: CUSTOMER_TYPES.includes(template.customerType as never)
      ? (template.customerType as (typeof CUSTOMER_TYPES)[number])
      : pick(CUSTOMER_TYPES, random),
    enabled: true,
    ...pickAvatar(gender, random, nationality),
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
  const legacy =
    (snapshot.sourceTemplateId ? LEGACY_TEMPLATE_GENDER[snapshot.sourceTemplateId] : undefined) ??
    Object.values(LEGACY_TEMPLATE_GENDER).find((item) => item.name === snapshot.name);
  return legacy?.gender ?? "female";
}

/** 历史画像快照缺头像时，按来源模板性别 + 稳定种子补齐（同一会话头像恒定） */
export function ensurePersonaAvatar<
  T extends { avatarUrl?: string; avatarKind?: AvatarKind; sourceTemplateId?: string; name?: string; nationality?: string },
>(snapshot: T, seed: string): T & { avatarUrl: string; avatarKind: AvatarKind } {
  // 老快照已有头像（或已抽到 default/initial）保持不变
  if (snapshot.avatarUrl) return { ...snapshot, avatarKind: snapshot.avatarKind ?? "photo" } as T & { avatarUrl: string; avatarKind: AvatarKind };
  if (snapshot.avatarKind) return snapshot as T & { avatarUrl: string; avatarKind: AvatarKind };
  const gender = resolvePersonaGender(snapshot);
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const random = () => {
    hash = (hash * 1103515245 + 12345) >>> 0;
    return ((hash >>> 8) % 1000) / 1000;
  };
  return { ...snapshot, ...pickAvatar(gender, random, snapshot.nationality) };
}

export function toStudentPersonaView(snapshot: PersonaSnapshot) {
  return {
    id: snapshot.id,
    name: snapshot.name,
    nationality: snapshot.nationality,
    identity: snapshot.identity,
    language: snapshot.language,
    customerType: snapshot.customerType,
    avatarUrl: snapshot.avatarUrl || null,
    avatarKind: snapshot.avatarKind ?? (snapshot.avatarUrl ? "photo" : "initial"),
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
/** 业务环节的默认订单状态（场景没指定 orderKind 时用，保持旧行为：售中/售后各一半随机） */
function defaultOrderKind(stage: BusinessStage, random: () => number): OrderKind {
  if (stage === "pre_sale") return "none";
  if (stage === "in_sale") return random() < 0.5 ? "pending_payment" : "customs";
  if (stage === "after_sale") return random() < 0.5 ? "delivered_negative" : "delivered";
  return "completed";
}

export function generateOrderForScenario(
  stage: BusinessStage,
  random: () => number = Math.random,
  now: Date = new Date(),
  products: OrderProductPool = PRODUCTS,
  persona?: { name?: string; nationality?: string },
  orderKind?: OrderKind | null,
): OrderInfo | null {
  const kind = orderKind ?? defaultOrderKind(stage, random);
  if (kind === "none") return null;
  const base = orderBase(random, now, products, persona);
  switch (kind) {
    case "pending_payment":
      return { ...base, status: "pending_payment", statusLabel: "待付款", placedAt: daysAgo(now, 2), logistics: null, review: null };
    case "paid":
      return { ...base, status: "paid", statusLabel: "待发货", placedAt: daysAgo(now, 3), logistics: null, review: null };
    case "in_transit":
      return { ...base, status: "in_transit", statusLabel: "国际运输中", placedAt: daysAgo(now, 8), logistics: buildLogistics(now, random, 2, 6), review: null };
    case "customs":
      return { ...base, status: "in_transit", statusLabel: "国际运输中（清关）", placedAt: daysAgo(now, 12), logistics: buildLogistics(now, random, 3, 10), review: null };
    case "delivery_failed":
      return { ...base, status: "in_transit", statusLabel: "派送异常", placedAt: daysAgo(now, 18), logistics: buildLogistics(now, random, 4, 15), review: null };
    case "delivered":
    case "delivered_negative":
    case "delivered_positive":
      return {
        ...base,
        status: "delivered",
        statusLabel: "已送达",
        placedAt: daysAgo(now, 20),
        logistics: buildLogistics(now, random, 5, 18),
        review: kind === "delivered_negative"
          ? { rating: 1 + Math.floor(random() * 2), content: pick(NEGATIVE_REVIEW_POOL, random), at: daysAgo(now, 1) }
          : kind === "delivered_positive"
            ? { rating: 5, content: pick(POSITIVE_REVIEW_POOL, random), at: daysAgo(now, 1) }
            : null,
      };
    default:
      // completed：客户维护场景的历史已完成订单
      return {
        ...base,
        status: "completed",
        statusLabel: "已完成",
        placedAt: daysAgo(now, 45 + Math.floor(random() * 60)),
        logistics: buildLogistics(now, random, 5, 40),
        review: { rating: 4 + Math.floor(random() * 2), content: pick(POSITIVE_REVIEW_POOL, random), at: daysAgo(now, 40) },
      };
  }
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

export { scenarioScripts } from "./scenario-scripts";
export { productLibrary } from "./product-library";
export * from "./store";
export * from "./patience";
export * from "./language";

/**
 * 商品资料卡（D-32）：给买家 AI 的“店铺真实信息”，用来判断客服说得对不对、让追问有依据。
 * 只取学生在商品详情里也能查到的内容，控制在一千来字以内。
 */
export function productFactSheet(product: {
  name: string;
  spec?: string | null;
  price: number;
  category?: string | null;
  details?: ProductDetails | null;
}): string {
  const d = product.details ?? {};
  const lines = [`Product: ${product.name} · USD ${product.price}${product.spec ? ` · ${product.spec}` : ""}${product.category ? ` · ${product.category}` : ""}`];
  if (d.options?.length) lines.push(`Options: ${d.options.map((o) => `${o.name} ${o.values.join("/")}`).join("; ")}`);
  const outOfStock = d.skus?.filter((sku) => sku.stock <= 0).map((sku) => Object.values(sku.values).join(" ")) ?? [];
  const lowStock = d.skus?.filter((sku) => sku.stock > 0 && sku.stock < 10).map((sku) => Object.values(sku.values).join(" ")) ?? [];
  if (outOfStock.length) lines.push(`Out of stock: ${outOfStock.slice(0, 8).join(", ")}`);
  if (lowStock.length) lines.push(`Low stock (<10): ${lowStock.slice(0, 8).join(", ")}`);
  if (d.bullets?.length) lines.push(`Selling points: ${d.bullets.slice(0, 5).join(" | ")}`);
  if (d.specs?.length) lines.push(`Specs: ${d.specs.slice(0, 8).map((row) => `${row.name}=${row.value}`).join("; ")}`);
  if (d.sizeChart?.rows.length) {
    lines.push(`Size chart (${d.sizeChart.headers.join(", ")}): ${d.sizeChart.rows.slice(0, 8).map((row) => row.join(" ")).join(" | ")}`);
  }
  if (d.shipping) {
    const methods = d.shipping.methods?.map((m) => `${m.region} ${m.method} ${m.days} ${m.fee > 0 ? `USD ${m.fee}` : "free"}`).join("; ");
    lines.push(`Shipping: from ${d.shipping.shipsFrom ?? "?"}, handling ${d.shipping.handlingDays ?? "?"} business days${methods ? `; ${methods}` : ""}`);
  }
  if (d.afterSale?.returnPolicy) lines.push(`Return policy: ${d.afterSale.returnPolicy}`);
  if (d.afterSale?.warranty) lines.push(`Warranty: ${d.afterSale.warranty}`);
  if (d.faq?.length) lines.push(`FAQ: ${d.faq.slice(0, 4).map((item) => `Q ${item.q} A ${item.a}`).join(" | ")}`);
  return lines.join("\n").slice(0, 1600);
}
