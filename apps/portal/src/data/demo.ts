export const tasks = [
  { id: "TASK-20581", name: "售前新品咨询实训", stage: "售前沟通", due: "今天 23:59", status: "active", progress: 35, score: null },
  { id: "TASK-20582", name: "清关延误客户安抚", stage: "售中处理", due: "07-16 23:59", status: "pending", progress: 0, score: null },
  { id: "TASK-20583", name: "货损退款协商", stage: "售后处理", due: "07-18 23:59", status: "pending", progress: 0, score: null },
  { id: "TASK-20574", name: "沉睡客户复购唤醒", stage: "客户分层", due: "07-08", status: "completed", progress: 100, score: 86 },
  { id: "TASK-20569", name: "差评挽回英文回复", stage: "售后处理", due: "07-02", status: "completed", progress: 100, score: 79 },
] as const;

export const buyers = [
  { id: "BUY-001", name: "Jessica Miller", country: "美国", flag: "🇺🇸", tag: "粉丝客", status: "在线", unread: 2, avatar: "https://i.pravatar.cc/160?img=47", order: "#AMZ-20581", product: "Wireless Earbuds Pro", price: "$59.90" },
  { id: "BUY-002", name: "Lukas Schneider", country: "德国", flag: "🇩🇪", tag: "大订单客户", status: "3 分钟前", unread: 0, avatar: "https://i.pravatar.cc/160?img=12", order: "#AMZ-20580", product: "Smart Watch Series 8", price: "$129.99" },
  { id: "BUY-003", name: "Camille Bernard", country: "法国", flag: "🇫🇷", tag: "普通客户", status: "在线", unread: 1, avatar: "https://i.pravatar.cc/160?img=32", order: "#AMZ-20579", product: "Portable Charger", price: "$25.90" },
  { id: "BUY-004", name: "Noah Williams", country: "英国", flag: "🇬🇧", tag: "沉睡客户", status: "昨天", unread: 0, avatar: "https://i.pravatar.cc/160?img=14", order: "#AMZ-20575", product: "Wireless Charger", price: "$45.00" },
] as const;

export const initialMessages: Record<string, Array<{ id: string; side: "buyer" | "student"; text: string; time: string }>> = {
  "BUY-001": [
    { id: "m1", side: "buyer", text: "Hi, is this wireless earbud in stock? Can you ship to New York?", time: "10:24" },
    { id: "m2", side: "student", text: "Hello Jessica! Yes, it is in stock and we can ship to New York in 7–10 days.", time: "10:25" },
    { id: "m3", side: "buyer", text: "Great. Does it come with a warranty?", time: "10:26" },
  ],
  "BUY-002": [{ id: "m4", side: "buyer", text: "Could you confirm the unit price for an order of 30 pieces?", time: "09:16" }],
  "BUY-003": [{ id: "m5", side: "buyer", text: "My parcel looks delayed at customs. What should I do?", time: "11:02" }],
  "BUY-004": [{ id: "m6", side: "buyer", text: "I saw your latest product update. Is there a returning-customer offer?", time: "昨天" }],
};

export const orderTimeline = [
  { label: "订单创建", date: "2026-07-11 09:24", done: true },
  { label: "付款完成", date: "2026-07-11 09:31", done: true },
  { label: "仓库处理中", date: "2026-07-12 14:20", done: true },
  { label: "等待揽收", date: "预计 07-13", done: false },
] as const;

export const logisticsTimeline = [
  { label: "已揽收 · 深圳仓", detail: "承运商已接收包裹", time: "07-12 15:42", state: "done" },
  { label: "国内运输 · 已离港", detail: "包裹已到达国际转运中心", time: "07-13 09:18", state: "done" },
  { label: "国际干线 · 航班运输", detail: "预计 18 小时后到达目的国", time: "07-13 16:21", state: "active" },
  { label: "清关", detail: "等待上一节点完成", time: "—", state: "next" },
  { label: "本地派送", detail: "等待清关完成", time: "—", state: "next" },
] as const;

export const scoreHistory = [
  { name: "沉睡客户复购唤醒", stage: "客户分层", score: 86, comment: "需求探索充分，复购理由可更具体。", date: "07-08" },
  { name: "差评挽回英文回复", stage: "售后处理", score: 79, comment: "情绪安抚自然，解决方案缺少时间承诺。", date: "07-02" },
  { name: "物流延迟主动通知", stage: "售中处理", score: 83, comment: "信息清晰，注意避免绝对化到货承诺。", date: "06-28" },
  { name: "新品推广邮件", stage: "售前沟通", score: 91, comment: "结构完整，CTA 明确。", date: "06-20" },
] as const;

