/**
 * 初始能力测评引擎（独立于会话评分链路）
 * - 10 道题：单选 5、多选 2、判断 2、实操 1，覆盖六个评估维度
 * - 题面英文内容附中文翻译（translation / scenarioTranslation），前端双语呈现
 * - 题目与答案定义在服务端，/questions 接口只下发去除答案的公开视图
 * - 判分为纯函数，便于单元测试；实操题按关键词量表判分（确定性、无 LLM 依赖）
 */

export type BaselineKind = "single" | "multi" | "judge" | "practical";

export type BaselineAnswer = string | string[];

export interface BaselineOption {
  id: string;
  text: string;
  translation?: string;
}

interface BaselineQuestionDef {
  id: string;
  kind: BaselineKind;
  dimension: string;
  points: number;
  title: string;
  scenario?: string;
  scenarioTranslation?: string;
  options?: BaselineOption[];
  correct?: string[];
}

export interface BaselinePublicQuestion {
  id: string;
  kind: BaselineKind;
  dimension: string;
  title: string;
  scenario?: string;
  scenarioTranslation?: string;
  options?: BaselineOption[];
}

const JUDGE_OPTIONS: BaselineOption[] = [
  { id: "yes", text: "正确" },
  { id: "no", text: "错误" },
];

const QUESTIONS: BaselineQuestionDef[] = [
  {
    id: "b01",
    kind: "judge",
    dimension: "compliance",
    points: 10,
    title: "客户询问产品质量时，回复下面这句话是合规的。",
    scenario: "\"This is the best quality, 100% no problem, I guarantee it!\"",
    scenarioTranslation: "「这是最好的品质，100% 没问题，我向你保证！」",
    options: JUDGE_OPTIONS,
    correct: ["no"],
  },
  {
    id: "b02",
    kind: "single",
    dimension: "compliance",
    points: 10,
    title: "客户问 \"How long will shipping take?\"（物流要多久？），以下哪种回复最合规？",
    options: [
      {
        id: "a",
        text: "\"Don't worry, it will definitely arrive within 5 days, guaranteed.\"",
        translation: "别担心，绝对 5 天内送达，我保证。",
      },
      {
        id: "b",
        text: "\"Standard shipping usually takes 7-15 business days. You can track it anytime with the tracking number.\"",
        translation: "标准物流通常需要 7-15 个工作日，您可以随时用运单号跟踪包裹。",
      },
      {
        id: "c",
        text: "\"It's super fast, the fastest in the whole market!\"",
        translation: "超级快，全市场最快！",
      },
      {
        id: "d",
        text: "\"I promise you will receive it tomorrow.\"",
        translation: "我保证你明天就能收到。",
      },
    ],
    correct: ["b"],
  },
  {
    id: "b03",
    kind: "single",
    dimension: "grammar",
    points: 10,
    title: "以下哪句英文语法正确？",
    scenarioTranslation: "四个选项想表达的意思相同：你的包裹已发出，很快就会送达。",
    options: [
      { id: "a", text: "\"Your package has been shipped and will arrive soon.\"" },
      { id: "b", text: "\"Your package have been shipped and arrive soon.\"" },
      { id: "c", text: "\"Your package is shipped yesterday already.\"" },
      { id: "d", text: "\"Your package been shipped, will arriving soon.\"" },
    ],
    correct: ["a"],
  },
  {
    id: "b04",
    kind: "judge",
    dimension: "grammar",
    points: 10,
    title: "下面这句话语法正确。",
    scenario: "\"We will refund you as soon as possible.\"",
    scenarioTranslation: "「我们会尽快为您退款。」",
    options: JUDGE_OPTIONS,
    correct: ["yes"],
  },
  {
    id: "b05",
    kind: "single",
    dimension: "professionalism",
    points: 10,
    title: "新客户进店咨询，最规范的开场白是？",
    options: [
      { id: "a", text: "\"What do you want?\"", translation: "你想要什么？" },
      {
        id: "b",
        text: "\"Hello! Welcome to our store. How may I help you today?\"",
        translation: "您好！欢迎光临本店，请问有什么可以帮您？",
      },
      { id: "c", text: "\"Buy now, big discount!\"", translation: "快买吧，大折扣！" },
      { id: "d", text: "\"Hi.\"", translation: "嗨。" },
    ],
    correct: ["b"],
  },
  {
    id: "b06",
    kind: "multi",
    dimension: "professionalism",
    points: 10,
    title: "一条完整、专业的客服回复通常应包含哪些要素？（多选）",
    options: [
      { id: "a", text: "礼貌问候与称呼" },
      { id: "b", text: "确认并复述客户的问题" },
      { id: "c", text: "给出明确的解决方案" },
      { id: "d", text: "约定下一步与处理时限" },
      { id: "e", text: "强调「这不是我们的责任」" },
    ],
    correct: ["a", "b", "c", "d"],
  },
  {
    id: "b07",
    kind: "single",
    dimension: "effectiveness",
    points: 10,
    title: "客户只问了一句 \"Where is my order?\"（我的订单到哪了？），最高效的回复是？",
    options: [
      { id: "a", text: "先介绍店铺新品，再慢慢帮客户查订单" },
      {
        id: "b",
        text: "\"Could you tell me more about yourself first?\"",
        translation: "能先介绍一下你自己吗？",
      },
      { id: "c", text: "直接给出物流状态与运单号，再补充预计送达时间" },
      { id: "d", text: "让客户自己去物流官网查询" },
    ],
    correct: ["c"],
  },
  {
    id: "b08",
    kind: "single",
    dimension: "empathy",
    points: 10,
    title: "客户很生气地发来下面这句话，你的第一句话应该是？",
    scenario: "\"This is ridiculous! The product broke after one day!\"",
    scenarioTranslation: "「太离谱了！产品用了一天就坏了！」",
    options: [
      { id: "a", text: "\"Please calm down first.\"", translation: "请先冷静一下。" },
      { id: "b", text: "\"Are you sure you used it correctly?\"", translation: "你确定你用对了吗？" },
      {
        id: "c",
        text: "\"I'm so sorry to hear that. I completely understand how frustrating this is.\"",
        translation: "非常抱歉听到这个消息，我完全理解这有多让人沮丧。",
      },
      {
        id: "d",
        text: "\"This has never happened before, it's very strange.\"",
        translation: "这从来没发生过，太奇怪了。",
      },
    ],
    correct: ["c"],
  },
  {
    id: "b09",
    kind: "multi",
    dimension: "resolution",
    points: 10,
    title: "客户收到破损商品要求处理，正确的做法有哪些？（多选）",
    options: [
      { id: "a", text: "核实订单信息与破损情况" },
      { id: "b", text: "主动提供补发或退款方案供客户选择" },
      { id: "c", text: "明确处理时限，并跟进直至客户确认" },
      { id: "d", text: "让客户自己联系物流公司索赔" },
      { id: "e", text: "解释破损是运输问题，与店铺无关" },
    ],
    correct: ["a", "b", "c"],
  },
  {
    id: "b10",
    kind: "practical",
    dimension: "resolution",
    points: 20,
    title: "实操题：请用英文写一条完整的客服回复（建议包含：称呼问候、致歉安抚、解决方案、处理时限；避免绝对化承诺）。",
    scenario: "客户 Emma 留言：\"I received my order today but the mug was broken into pieces. I'm really disappointed!\"",
    scenarioTranslation: "「我今天收到订单了，但马克杯碎成了好几片。我真的很失望！」",
  },
];

/* 实操题量表：每命中一项计入对应维度 5 分 */
const PRACTICAL_RUBRIC: { dimension: string; points: number; test: (text: string) => boolean }[] = [
  { dimension: "empathy", points: 5, test: (text) => /(sorry|apolog|understand|regret)/.test(text) },
  { dimension: "resolution", points: 5, test: (text) => /(refund|replace|resend|reship|return|send you (a )?new)/.test(text) },
  { dimension: "compliance", points: 5, test: (text) => !/(100\s*%|guarantee|\bbest\b)/.test(text) },
  {
    dimension: "professionalism",
    points: 5,
    test: (text) => /(dear|hello|hi\b|emma)/.test(text) && text.trim().split(/\s+/).length >= 15,
  },
];

const MIN_PRACTICAL_CHARS = 10;

export function baselinePublicQuestions(): BaselinePublicQuestion[] {
  return QUESTIONS.map(({ id, kind, dimension, title, scenario, scenarioTranslation, options }) => ({
    id,
    kind,
    dimension,
    title,
    ...(scenario ? { scenario } : {}),
    ...(scenarioTranslation ? { scenarioTranslation } : {}),
    ...(options ? { options } : {}),
  }));
}

export function validateBaselineAnswers(answers: Record<string, unknown>): string | null {
  for (const question of QUESTIONS) {
    const answer = answers[question.id];
    if (question.kind === "practical") {
      if (typeof answer !== "string" || answer.trim().length < MIN_PRACTICAL_CHARS) {
        return `第 ${question.id.slice(1)} 题（实操题）请写出完整的英文回复。`;
      }
      continue;
    }
    const validIds = new Set((question.options ?? []).map((option) => option.id));
    if (question.kind === "multi") {
      if (!Array.isArray(answer) || answer.length === 0 || answer.some((item) => !validIds.has(String(item)))) {
        return `第 ${question.id.slice(1)} 题尚未作答。`;
      }
      continue;
    }
    if (typeof answer !== "string" || !validIds.has(answer)) {
      return `第 ${question.id.slice(1)} 题尚未作答。`;
    }
  }
  return null;
}

export function gradeBaseline(answers: Record<string, BaselineAnswer>): {
  scores: Record<string, number>;
  total: number;
} {
  const earned: Record<string, number> = {};
  const max: Record<string, number> = {};
  const add = (target: Record<string, number>, dimension: string, points: number) => {
    target[dimension] = (target[dimension] ?? 0) + points;
  };

  for (const question of QUESTIONS) {
    const answer = answers[question.id];
    if (question.kind === "practical") {
      const text = typeof answer === "string" ? answer.toLowerCase() : "";
      const usable = text.trim().length >= MIN_PRACTICAL_CHARS;
      for (const rule of PRACTICAL_RUBRIC) {
        add(max, rule.dimension, rule.points);
        if (usable && rule.test(text)) add(earned, rule.dimension, rule.points);
      }
      continue;
    }
    add(max, question.dimension, question.points);
    const correct = question.correct ?? [];
    if (question.kind === "multi") {
      const chosen = Array.isArray(answer) ? answer.map(String) : [];
      const hit = chosen.filter((id) => correct.includes(id)).length;
      const wrong = chosen.length - hit;
      const ratio = Math.max(0, hit - wrong) / correct.length;
      add(earned, question.dimension, question.points * ratio);
      continue;
    }
    if (typeof answer === "string" && answer === correct[0]) {
      add(earned, question.dimension, question.points);
    }
  }

  const scores: Record<string, number> = {};
  for (const dimension of Object.keys(max)) {
    scores[dimension] = Math.round(((earned[dimension] ?? 0) / max[dimension]!) * 100);
  }
  const dims = Object.keys(scores);
  const total = Math.round(dims.reduce((sum, dimension) => sum + scores[dimension]!, 0) / dims.length);
  return { scores, total };
}
