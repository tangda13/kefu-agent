import { useId, type ReactNode } from "react";
import { BUSINESS_STAGES, BUSINESS_STAGE_LABELS, EMOTIONS, PERSONALITIES, type BusinessStage } from "@cecs/contracts";
import { PATIENCE_BASE_MINUTES, PATIENCE_MAX, patienceFactor, patienceStart, replyTurnScore, starsFromSatisfaction } from "@cecs/domain";
import { Table } from "./parts";

/*
 * AI 买家一章的图解（D-91）。能从规则算出来的数字（能忍几次、催促时间、星级分界、响应时效得分）
 * 直接调 domain 的规则函数，规则改了图跟着变；其余是示意。
 */

/** SVG marker 的 id：同一页里可能出现两份（屏幕上一份、导出 PDF 一份），用 useId 区分 */
function useMarkerId(): string {
  return `help-ah-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

function Arrowhead({ id, color = "#9aa3b0" }: { id: string; color?: string }) {
  return (
    <defs>
      <marker id={id} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0 0L10 5L0 10z" fill={color} />
      </marker>
    </defs>
  );
}

function Step({ x, y, w, no, title, sub, soft }: { x: number; y: number; w: number; no: number; title: string; sub: string; soft?: boolean }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={60} rx={8} className={soft ? "soft" : "box"} />
      <circle cx={x + 20} cy={y + 20} r={10} fill="#1d5fd1" />
      <text x={x + 20} y={y + 24} className="w b" textAnchor="middle" style={{ fontSize: 11 }}>{no}</text>
      <text x={x + 38} y={y + 25} className="b">{title}</text>
      <text x={x + 38} y={y + 46} className="sm">{sub}</text>
    </g>
  );
}

/** 一次接待里 AI 做的事：开始前 → 接待中（循环）→ 结束后 */
export function JourneyFigure() {
  const ah = useMarkerId();
  const arrow = `url(#${ah})`;
  return (
    <svg className="help-dg" viewBox="0 0 780 352" role="img" aria-label="一次接待的全过程">
      <Arrowhead id={ah} />
      <text x={0} y={55} className="sm b">开始前</text>
      <text x={0} y={171} className="sm b">接待中</text>
      <text x={0} y={303} className="sm b">结束后</text>
      <Step x={70} y={20} w={208} no={1} title="现场生成一位买家" sub="画像、语言、订单、商品资料" />
      <Step x={300} y={20} w={208} no={2} title="定下两本账" sub="来办的事 · 还能忍几次" />
      <Step x={530} y={20} w={208} no={3} title="买家先开口" sub="说出来意" />
      <path d="M278 50H296" className="line" markerEnd={arrow} />
      <path d="M508 50H526" className="line" markerEnd={arrow} />
      <path d="M634 80V132" className="line" markerEnd={arrow} />
      <Step x={70} y={136} w={406} no={5} title="买家先判断客服的回复、记账，再回复" sub="后台观察员同时评估满意度和情绪" soft />
      <Step x={530} y={136} w={208} no={4} title="客服回复" sub="文字、语音、卡片" />
      <path d="M530 156H480" className="line" markerEnd={arrow} />
      <path d="M476 178H526" className="line" markerEnd={arrow} />
      <text x={738} y={216} className="sm" textAnchor="end">客服不回复时</text>
      <text x={738} y={234} className="sm" textAnchor="end">约 2、5 分钟各催一次，约 10 分钟离开</text>
      <path d="M151 196V264" className="line" markerEnd={arrow} />
      <text x={162} y={235} className="sm">买家离开，或接待结束</text>
      <Step x={70} y={268} w={162} no={6} title="接待结束" sub="买家走或到时" />
      <Step x={248} y={268} w={162} no={7} title="买家打星" sub="1–5 星" />
      <Step x={426} y={268} w={162} no={8} title="AI 评分和评语" sub="八项能力" />
      <Step x={604} y={268} w={162} no={9} title="买家给订单留评" sub="已送达的订单" />
      <path d="M232 298H244" className="line" markerEnd={arrow} />
      <path d="M410 298H422" className="line" markerEnd={arrow} />
      <path d="M588 298H600" className="line" markerEnd={arrow} />
    </svg>
  );
}

function Chips({ x, y, items }: { x: number; y: number; items: Array<[string, number]> }) {
  let cursor = x;
  return (
    <g>
      {items.map(([label, width]) => {
        const left = cursor;
        cursor += width + 8;
        return (
          <g key={label}>
            <rect x={left} y={y} width={width} height={24} rx={4} className="box" />
            <text x={left + width / 2} y={y + 16} textAnchor="middle" style={{ fontSize: 12 }}>{label}</text>
          </g>
        );
      })}
    </g>
  );
}

/** 一位买家由三部分拼成（示例） */
export function PersonaFigure() {
  const ah = useMarkerId();
  const arrow = `url(#${ah})`;
  const rows: Array<[string, string]> = [
    ["哪一类", "品质导向型个人消费者"],
    ["客户类型", "复购老客"],
    ["脾气", "理性谨慎 · 进店时平静"],
    ["来意", "包裹到哪了、哪天能到"],
    ["顺带", "要发票；不合适怎么退"],
    ["能忍", `${patienceStart("in_sale", { personality: "理性谨慎", emotion: "平静" })} 次答得差的回复`],
  ];
  return (
    <svg className="help-dg" viewBox="0 0 780 312" role="img" aria-label="一位买家由三部分拼成">
      <Arrowhead id={ah} />
      <rect x={0} y={0} width={470} height={80} rx={8} className="pane" />
      <text x={16} y={26} className="b">画像模板 · 这是哪一类买家</text>
      <Chips x={16} y={40} items={[["个人消费者", 76], ["品质导向型", 76], ["复购老客", 64], ["看重：发票交期、退换政策", 172]]} />
      <rect x={0} y={100} width={470} height={80} rx={8} className="pane" />
      <text x={16} y={126} className="b">每次随机 · 这一位是谁</text>
      <Chips x={16} y={140} items={[["Emma Wilson", 96], ["女", 30], ["英国", 44], ["理性谨慎", 68], ["平静", 44], ["说英语（英式）", 104]]} />
      <rect x={0} y={200} width={470} height={80} rx={8} className="pane" />
      <text x={16} y={226} className="b">场景 · 这次为什么来</text>
      <Chips x={16} y={240} items={[["订单进度跟进", 92], ["剧本", 48], ["关联订单（已发货）", 126], ["历史订单", 64], ["商品资料", 64]]} />
      <path d="M470 40C496 40 494 128 516 128" className="line" markerEnd={arrow} />
      <path d="M470 140H516" className="line" markerEnd={arrow} />
      <path d="M470 240C496 240 494 152 516 152" className="line" markerEnd={arrow} />
      <rect x={520} y={12} width={260} height={256} rx={10} className="box" />
      <circle cx={550} cy={50} r={18} fill="#e8effc" />
      <text x={550} y={55} textAnchor="middle" className="bi b" style={{ fontSize: 15 }}>E</text>
      <text x={578} y={46} className="b" style={{ fontSize: 14 }}>Emma Wilson</text>
      <text x={578} y={66} className="sm">英国 · 说英语（英式）</text>
      <path d="M536 86H764" stroke="#e3e7ee" />
      {rows.map(([label, value], index) => (
        <g key={label}>
          <text x={536} y={110 + index * 24} className="sm">{label}</text>
          <text x={596} y={110 + index * 24}>{value}</text>
        </g>
      ))}
      <text x={520} y={288} className="sm">工作台里只看得到头像、姓名、国籍</text>
      <text x={520} y={306} className="sm">和客户标签，其余都在买家“心里”</text>
    </svg>
  );
}

/** 两本账（示例：上面那位 Emma） */
export function LedgerFigure() {
  const start = patienceStart("in_sale", { personality: "理性谨慎", emotion: "平静" });
  const left = Math.max(1, start - 2);
  const items: Array<{ tag: string; main?: boolean; text: string; status: string; tone: string }> = [
    { tag: "主要", main: true, text: "包裹现在到哪了、哪天能到", status: "办成", tone: "okc" },
    { tag: "顺带", text: "要一张发票", status: "等客服回复", tone: "bi" },
    { tag: "顺带", text: "不合适的话怎么退", status: "还没办 · 没答上 1 次", tone: "wn" },
    { tag: "临时", text: "客服推荐的同款杯盖", status: "放弃", tone: "mu" },
  ];
  return (
    <svg className="help-dg" viewBox="0 0 780 248" role="img" aria-label="买家的两本账">
      <text x={0} y={16} className="b" style={{ fontSize: 14 }}>事情账 · 来办的事</text>
      {items.map((item, index) => (
        <g key={item.text} transform={`translate(0 ${32 + index * 46})`}>
          <rect width={500} height={38} rx={6} className="pane" />
          <circle cx={20} cy={19} r={10} fill="#fff" stroke="#c8cfda" />
          <text x={20} y={23} textAnchor="middle" className="sm b">{index + 1}</text>
          <rect x={38} y={9} width={40} height={20} rx={4} fill={item.main ? "#e8effc" : "#eef0f3"} />
          <text x={58} y={23} textAnchor="middle" className={item.main ? "bi" : undefined} style={{ fontSize: 12, fill: item.main ? undefined : "#465163" }}>{item.tag}</text>
          <text x={90} y={24}>{item.text}</text>
          <text x={486} y={24} textAnchor="end" className={`${item.tone} b`}>{item.status}</text>
        </g>
      ))}
      <text x={0} y={236} className="sm">主要的事 1 件 · 顺带的事 0–3 件 · 临时冒出来的最多 2 件，只能由客服引出</text>
      <text x={540} y={16} className="b" style={{ fontSize: 14 }}>耐心账 · 还能忍几次</text>
      {Array.from({ length: PATIENCE_MAX }, (_, index) => (
        <rect key={index} x={540 + index * 58} y={34} width={50} height={62} rx={6} fill={index < left ? "#1d5fd1" : index < start ? "#e3e7ee" : "#f4f6f9"} stroke={index < start ? "none" : "#e3e7ee"} strokeDasharray={index < start ? undefined : "3 3"} />
      ))}
      <text x={540} y={128} className="b" style={{ fontSize: 16 }}>还能忍 {left} 次</text>
      <text x={540} y={150} className="sm">开始时 {start} 次，已经被扣了 {start - left} 次</text>
      <text x={540} y={186} className="sm">售中 {patienceStart("in_sale", {})} × 理性谨慎 {patienceFactor({ personality: "理性谨慎" })} × 平静 {patienceFactor({ emotion: "平静" }).toFixed(1)}</text>
      <text x={540} y={206} className="sm">四舍五入，开始时能忍 {start} 次</text>
    </svg>
  );
}

type Verdict = "good" | "ok" | "bad" | "severe";
const VERDICT_DELTA: Record<Verdict, number> = { good: 1, ok: 0, bad: -1, severe: -2 };
const VERDICT_STYLE: Record<Verdict, { fill: string; text: string; cls?: string }> = {
  good: { fill: "#e3f4ea", text: "okc", cls: "okc" },
  ok: { fill: "#eef0f3", text: "" },
  bad: { fill: "#fdf0dc", text: "wn", cls: "wn" },
  severe: { fill: "#fbe8e6", text: "bd", cls: "bd" },
};

/** 耐心怎么变（示例：售后、平静、犹豫保守），能忍几次按规则算 */
export function PatienceStepsFigure() {
  const persona = { personality: "犹豫保守", emotion: "平静" };
  const start = patienceStart("after_sale", persona);
  const rounds: Array<{ verdict: Verdict; label: string }> = [
    { verdict: "ok", label: "一般" },
    { verdict: "bad", label: "差 · 敷衍含糊" },
    { verdict: "good", label: "好" },
    { verdict: "severe", label: "很差 · 推卸责任" },
    { verdict: "bad", label: "差 · 问了不答" },
  ];
  const columns: Array<{ head: string; left: number; chip?: { verdict: Verdict; label: string }; note: string[]; after?: string }> = [
    { head: "开始", left: start, note: ["说出来意"], after: `能忍 ${start} 次` },
  ];
  let left = start;
  for (const [index, round] of rounds.entries()) {
    if (left <= 0) break;
    const before = left;
    left = Math.min(start, Math.max(0, left + VERDICT_DELTA[round.verdict]));
    const note = left === 0 ? ["这一条就告别", "失望离开"] : left === 1 ? ["直接说出不满"] : left > before ? ["语气缓和"] : index === 0 ? ["接着问"] : ["追问细节"];
    const after = left > before ? `${left} 次（加回 1）` : `${left} 次`;
    columns.push({ head: `第 ${index + 1} 轮`, left, chip: round, note, after });
  }
  const width = 780 / columns.length;
  return (
    <svg className="help-dg" viewBox="0 0 780 196" role="img" aria-label="耐心怎么变">
      {columns.map((column, index) => {
        const cx = width * index + width / 2;
        const danger = column.left <= 1 && index > 0;
        const chipWidth = column.chip ? Math.max(40, column.chip.label.length * 12 + 16) : 0;
        return (
          <g key={column.head}>
            <text x={cx} y={14} textAnchor="middle" className="sm b">{column.head}</text>
            {column.chip ? (
              <g>
                <rect x={cx - chipWidth / 2} y={28} width={chipWidth} height={24} rx={4} fill={VERDICT_STYLE[column.chip.verdict].fill} />
                <text x={cx} y={45} textAnchor="middle" className={VERDICT_STYLE[column.chip.verdict].cls} style={{ fontSize: 12, fill: VERDICT_STYLE[column.chip.verdict].cls ? undefined : "#465163" }}>{column.chip.label}</text>
              </g>
            ) : <text x={cx} y={45} textAnchor="middle" className="mu">—</text>}
            {Array.from({ length: start }, (_, pip) => (
              <rect key={pip} x={cx - (start * 24 - 4) / 2 + pip * 24} y={70} width={20} height={12} rx={2} fill={pip < column.left ? "#1d5fd1" : "#e3e7ee"} />
            ))}
            <text x={cx} y={106} textAnchor="middle" className={danger ? "bd" : undefined} style={{ fontSize: 12 }}>{column.after}</text>
            {column.note.map((line, lineIndex) => (
              <text key={line} x={cx} y={146 + lineIndex * 18} textAnchor="middle" className={column.left === 0 ? "bd" : "sm"} style={column.left === 0 ? { fontSize: 12 } : undefined}>{line}</text>
            ))}
          </g>
        );
      })}
      <path d="M0 122H780" stroke="#edf0f4" />
      <text x={0} y={190} className="sm">示例：售后处理、平静、犹豫保守的买家，开始时能忍 {start} 次（{patienceStart("after_sale", {})} × {patienceFactor({ personality: "犹豫保守" })} × {patienceFactor({ emotion: "平静" }).toFixed(1)}，四舍五入）</text>
    </svg>
  );
}

/** 一条回复是怎么生成的 */
export function ReplyFlowFigure() {
  const ah = useMarkerId();
  const arrow = `url(#${ah})`;
  return (
    <svg className="help-dg" viewBox="0 0 780 300" role="img" aria-label="一条回复是怎么生成的">
      <Arrowhead id={ah} color="#465163" />
      <rect x={40} y={0} width={140} height={34} rx={6} className="box" />
      <text x={110} y={22} textAnchor="middle" className="b">客服（工作台）</text>
      <rect x={320} y={0} width={140} height={34} rx={6} className="soft" />
      <text x={390} y={22} textAnchor="middle" className="b">平台</text>
      <rect x={600} y={0} width={140} height={34} rx={6} className="box" />
      <text x={670} y={22} textAnchor="middle" className="b">AI 买家</text>
      <path d="M110 34V296M390 34V296M670 34V296" className="dash" />
      <path d="M110 66H384" stroke="#465163" strokeWidth={1.5} markerEnd={arrow} />
      <text x={122} y={58} style={{ fontSize: 12 }}>① 发出一条消息</text>
      <path d="M390 116H664" stroke="#465163" strokeWidth={1.5} markerEnd={arrow} />
      <text x={402} y={96} style={{ fontSize: 12 }}>② 买家资料、剧本、订单、完整聊天</text>
      <text x={402} y={110} style={{ fontSize: 12 }}>+ 还有哪几件事、还能忍几次</text>
      <path d="M670 166H396" stroke="#465163" strokeWidth={1.5} markerEnd={arrow} />
      <text x={658} y={146} textAnchor="end" style={{ fontSize: 12 }}>③ 先写一段判断，再写回复</text>
      <text x={658} y={160} textAnchor="end" className="sm">〔好 · 第 1 件办成 · 不走〕Great, that's a relief…</text>
      <rect x={300} y={186} width={180} height={40} rx={6} className="soft" />
      <text x={390} y={203} textAnchor="middle" style={{ fontSize: 12 }}>④ 截下判断，记账、数次数</text>
      <text x={390} y={219} textAnchor="middle" className="sm">这段判断客服看不到</text>
      <path d="M390 262H116" stroke="#465163" strokeWidth={1.5} markerEnd={arrow} />
      <text x={378} y={254} textAnchor="end" style={{ fontSize: 12 }}>⑤ 只推回复正文，一个字一个字地出现</text>
      <text x={378} y={282} textAnchor="end" className="sm">一般 1 秒内出第一个字（要求 3 秒内）</text>
    </svg>
  );
}

/** 买家最后一条消息之后，多久催、多久走：基准时间 × 耐心倍率 */
export function WaitFigure() {
  const rows: Array<{ label: string; persona: { personality?: string; emotion?: string } }> = [
    { label: "一般买家", persona: { emotion: "平静" } },
    { label: "焦虑、直接高效", persona: { personality: "直接高效", emotion: "焦虑" } },
    { label: "期待、友好健谈", persona: { personality: "友好健谈", emotion: "期待" } },
  ];
  const data = rows.map((row) => {
    const factor = patienceFactor(row.persona);
    return { ...row, factor, points: PATIENCE_BASE_MINUTES.map((minutes) => minutes * factor) };
  });
  const maxMinutes = Math.max(10, Math.ceil(Math.max(...data.map((row) => row.points[row.points.length - 1] ?? 0)) / 2) * 2);
  const x0 = 150;
  const x1 = 760;
  const x = (minutes: number) => x0 + ((x1 - x0) * minutes) / maxMinutes;
  const ticks = Array.from({ length: maxMinutes / 2 + 1 }, (_, index) => index * 2);
  return (
    <svg className="help-dg" viewBox="0 0 780 206" role="img" aria-label="催促和离开的时间">
      {ticks.map((minute, index) => (
        <g key={minute}>
          <text x={x(minute)} y={16} textAnchor={index === ticks.length - 1 ? "end" : "middle"} className="sm">{index === ticks.length - 1 ? `${minute} 分钟` : minute}</text>
          <path d={`M${x(minute)} 24V166`} stroke="#f0f2f5" />
        </g>
      ))}
      {data.map((row, index) => {
        const y = 62 + index * 50;
        const [first = 0, second = 0, leave = 0] = row.points;
        return (
          <g key={row.label}>
            <text x={0} y={y - 6} style={{ fontSize: 12 }}>{row.label}</text>
            <text x={0} y={y + 10} className="sm">倍率 {row.factor}</text>
            <path d={`M${x0} ${y}H${x(leave)}`} stroke="#c8cfda" strokeWidth={2} />
            <circle cx={x(first)} cy={y} r={6} fill="#e0a54a" />
            <circle cx={x(second)} cy={y} r={6} fill="#c77a12" />
            <rect x={x(leave) - 6} y={y - 6} width={12} height={12} rx={2} fill="#b8302a" />
          </g>
        );
      })}
      <circle cx={156} cy={196} r={5} fill="#e0a54a" />
      <text x={166} y={200} className="sm">催一次，耐心 −1</text>
      <circle cx={296} cy={196} r={5} fill="#c77a12" />
      <text x={306} y={200} className="sm">再催一次，耐心 −1，情绪转为不满</text>
      <rect x={514} y={191} width={10} height={10} rx={2} fill="#b8302a" />
      <text x={530} y={200} className="sm">留一句话离开，算失望离开</text>
    </svg>
  );
}

/** 满意度 → 星级的分界：按规则函数扫一遍 0–100 得出 */
export function starBands(): Array<{ stars: number; from: number; to: number }> {
  const bands: Array<{ stars: number; from: number; to: number }> = [];
  for (let value = 0; value <= 100; value += 1) {
    const stars = starsFromSatisfaction(value);
    const last = bands[bands.length - 1];
    if (last && last.stars === stars) last.to = value + 1;
    else bands.push({ stars, from: value, to: value + 1 });
  }
  const top = bands[bands.length - 1];
  if (top) top.to = 100;
  return bands;
}

/** 星级怎么定：先按满意度换算，再按买家走的原因限定区间 */
export function StarsFigure() {
  const bands = starBands();
  const x0 = 220;
  const x1 = 760;
  const x = (value: number) => x0 + ((x1 - x0) * value) / 100;
  const xStar = (stars: number, edge: "from" | "to") => {
    const band = bands.find((item) => item.stars === stars);
    return x(band ? band[edge] : stars === 1 ? 0 : 100);
  };
  const fills = ["#eef1f6", "#e1e7f1", "#cfdaee", "#a9c0ea", "#1d5fd1"];
  const limits: Array<{ title: string; sub?: string; from: number; to: number; label: string; fill: string; cls: string }> = [
    { title: "失望离开", sub: "耐心用完 · 主要的事没办成 · 等不到回复", from: 1, to: 2, label: "最多 2 星", fill: "#fbe8e6", cls: "bd" },
    { title: "主要的办成，顺带的没谈妥", from: 3, to: 4, label: "3–4 星", fill: "#fdf0dc", cls: "wn" },
    { title: "来办的事都办成", from: 4, to: 5, label: "至少 4 星", fill: "#e3f4ea", cls: "okc" },
  ];
  const marks = [0, ...bands.slice(1).map((band) => band.from), 100];
  return (
    <svg className="help-dg" viewBox="0 0 780 238" role="img" aria-label="星级怎么定">
      {marks.map((value) => <text key={value} x={x(value)} y={14} textAnchor="middle" className="sm">{value}</text>)}
      <text x={0} y={39} style={{ fontSize: 12 }}>满意度换算</text>
      {bands.map((band) => (
        <g key={band.stars}>
          <rect x={x(band.from)} y={22} width={x(band.to) - x(band.from)} height={26} fill={fills[band.stars - 1]} />
          <text x={(x(band.from) + x(band.to)) / 2} y={40} textAnchor="middle" className={band.stars === 5 ? "w b" : undefined} style={{ fontSize: 12 }}>{band.stars} 星</text>
        </g>
      ))}
      {limits.map((limit, index) => {
        const y = 72 + index * 46;
        const left = xStar(limit.from, "from");
        const right = xStar(limit.to, "to");
        return (
          <g key={limit.title}>
            <text x={0} y={y + 12} className="b" style={{ fontSize: 12 }}>{limit.title}</text>
            {limit.sub ? <text x={0} y={y + 28} className="sm">{limit.sub}</text> : null}
            <rect x={left} y={y} width={right - left} height={24} rx={12} fill={limit.fill} />
            <text x={(left + right) / 2} y={y + 17} textAnchor="middle" className={limit.cls} style={{ fontSize: 12 }}>{limit.label}</text>
          </g>
        );
      })}
      <text x={0} y={226} className="b" style={{ fontSize: 12 }}>其他（在等回复、提前结束）</text>
      <rect x={x0} y={214} width={x1 - x0} height={24} rx={12} fill="#f4f6f9" stroke="#e3e7ee" />
      <text x={(x0 + x1) / 2} y={231} textAnchor="middle" className="sm">按满意度，1–5 星</text>
    </svg>
  );
}

/** 消息响应时效：每一轮等了多久 → 这一轮得几分（按规则函数取点画线） */
export function ResponseCurveFigure() {
  const maxSec = 660;
  const x = (sec: number) => 60 + (680 * sec) / maxSec;
  const y = (score: number) => 180 - (160 * score) / 100;
  const points = Array.from({ length: maxSec / 5 + 1 }, (_, index) => index * 5).map((sec) => `${x(sec).toFixed(1)},${y(replyTurnScore(sec)).toFixed(1)}`).join(" ");
  const labels: Array<[number, string]> = [[45, "45 秒"], [90, "1.5 分"], [180, "3 分"], [360, "6 分"], [600, "10 分钟"]];
  return (
    <svg className="help-dg" viewBox="0 0 780 214" role="img" aria-label="响应时效得分">
      <path d="M60 20V180H760" stroke="#c8cfda" fill="none" />
      <text x={52} y={24} textAnchor="end" className="sm">100</text>
      <text x={52} y={y(60) + 4} textAnchor="end" className="sm">60</text>
      <text x={52} y={184} textAnchor="end" className="sm">0</text>
      <text x={60} y={200} textAnchor="middle" className="sm">0</text>
      {labels.map(([sec, label]) => <text key={sec} x={x(sec)} y={200} textAnchor="middle" className="sm">{label}</text>)}
      <path d={`M60 ${y(60)}H760`} className="dash" />
      <path d={`M${x(120)} 20V180`} stroke="#e0a54a" strokeDasharray="3 3" />
      <text x={x(120) + 6} y={34} className="wn" style={{ fontSize: 12 }}>2 分钟：买家开始催</text>
      <polyline points={points} fill="none" stroke="#1d5fd1" strokeWidth={2.5} strokeLinejoin="round" />
      {labels.map(([sec]) => {
        const score = Math.round(replyTurnScore(sec));
        return (
          <g key={sec}>
            <circle cx={x(sec)} cy={y(score)} r={4} fill="#1d5fd1" />
            <text x={x(sec) + 8} y={y(score) - 6} style={{ fontSize: 12 }}>{score === 100 ? "满分" : score}</text>
          </g>
        );
      })}
    </svg>
  );
}

/** 性格、情绪倍率按从大到小排 */
function byFactor<T extends string>(values: readonly T[], key: "personality" | "emotion"): Array<{ value: T; factor: number }> {
  return values.map((value) => ({ value, factor: patienceFactor({ [key]: value }) })).sort((a, b) => b.factor - a.factor);
}

export function factorText(key: "personality" | "emotion"): string {
  return byFactor(key === "personality" ? PERSONALITIES : EMOTIONS, key).map((item) => `${item.value} ${item.factor.toFixed(1)}`).join("、");
}

/** 环节基数：售前、维护 / 售中、售后 */
export function stageBaseText(): string {
  const groups = new Map<number, BusinessStage[]>();
  for (const stage of BUSINESS_STAGES) {
    const base = patienceStart(stage, {});
    groups.set(base, [...(groups.get(base) ?? []), stage]);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([base, stages]) => `${stages.map((stage) => BUSINESS_STAGE_LABELS[stage]).join("、")} ${base} 次`).join("；");
}

/** 能忍几次：性格 × 情绪，两个数分别是“售前、维护”和“售中、售后” */
export function PatienceTable() {
  const personalities = byFactor(PERSONALITIES, "personality");
  const emotions = byFactor(EMOTIONS, "emotion");
  const cell = (personality: string, emotion: string): ReactNode =>
    `${patienceStart("pre_sale", { personality, emotion })} / ${patienceStart("in_sale", { personality, emotion })}`;
  return (
    <Table
      grid
      head={["能忍几次　售前、维护 / 售中、售后", ...emotions.map((item) => item.value)]}
      rows={personalities.map((item) => [item.value, ...emotions.map((emotion) => cell(item.value, emotion.value))])}
    />
  );
}

/** Windows SmartScreen 拦截未签名安装包时的两步（示意） */
export function SmartScreenFigure() {
  const dialog = (x: number, step: 1 | 2) => (
    <g transform={`translate(${x} 0)`}>
      <rect width={360} height={220} rx={4} fill="#0f5ba8" />
      <text x={24} y={40} className="w" style={{ fontSize: 18 }}>Windows 已保护你的电脑</text>
      <text x={24} y={72} className="w" style={{ fontSize: 12, opacity: 0.9 }}>Microsoft Defender SmartScreen 阻止了无法识别</text>
      <text x={24} y={90} className="w" style={{ fontSize: 12, opacity: 0.9 }}>的应用启动。运行此应用可能会导致你的电脑存在风险。</text>
      {step === 1 ? (
        <g>
          <text x={24} y={118} className="w" style={{ fontSize: 12, textDecoration: "underline" }}>更多信息</text>
          <rect x={18} y={102} width={64} height={24} rx={3} fill="none" stroke="#ffd24d" strokeWidth={2} />
        </g>
      ) : (
        <g>
          <text x={24} y={118} className="w" style={{ fontSize: 12, opacity: 0.9 }}>应用：cecs-client-setup-1.0.0.exe</text>
          <text x={24} y={136} className="w" style={{ fontSize: 12, opacity: 0.9 }}>发布者：未知发布者</text>
        </g>
      )}
      {step === 2 ? (
        <g>
          <rect x={150} y={176} width={92} height={28} rx={2} fill="#fff" stroke="#ffd24d" strokeWidth={3} />
          <text x={196} y={195} textAnchor="middle" style={{ fontSize: 12 }}>仍要运行</text>
        </g>
      ) : null}
      <rect x={252} y={176} width={92} height={28} rx={2} fill="#fff" />
      <text x={298} y={195} textAnchor="middle" style={{ fontSize: 12 }}>不运行</text>
    </g>
  );
  const ah = useMarkerId();
  return (
    <svg className="help-dg" viewBox="0 0 780 236" role="img" aria-label="Windows SmartScreen 放行步骤（示意）">
      <Arrowhead id={ah} />
      {dialog(0, 1)}
      <path d="M370 110H404" className="line" markerEnd={`url(#${ah})`} />
      {dialog(420, 2)}
      <text x={0} y={234} className="sm">① 点“更多信息”</text>
      <text x={420} y={234} className="sm">② 点“仍要运行”</text>
    </svg>
  );
}
