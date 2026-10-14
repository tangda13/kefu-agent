/**
 * 时间锚点：模型不知道“今天”，也算不准星期几，买家会把“下周五”“三天后”说乱。
 * 每轮把当前时间和一张三周日历写进提示词，日期、星期、截止时间一律对着日历说。
 * 统一按北京时间：学生在订单、物流里看到的时间也是北京时间，双方对着同一本日历。
 */
export const TRAINING_TIME_ZONE = "Asia/Shanghai";

const WEEKDAYS_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS_FULL_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const DAY_MS = 86_400_000;

/** 某一时刻在实训时区里的日期（用 UTC 零点表示，便于加减天数）和时分 */
function localDay(at: Date): { day: Date; time: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TRAINING_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const day = new Date(Date.UTC(get("year"), get("month") - 1, get("day")));
  return { day, time: `${String(get("hour")).padStart(2, "0")}:${String(get("minute")).padStart(2, "0")}` };
}

const addDays = (day: Date, days: number) => new Date(day.getTime() + days * DAY_MS);
const shortEn = (day: Date) => `${WEEKDAYS_EN[day.getUTCDay()]} ${day.getUTCDate()} ${MONTHS_EN[day.getUTCMonth()]}`;
const shortZh = (day: Date) => `${day.getUTCMonth() + 1}月${day.getUTCDate()}日${WEEKDAYS_ZH[day.getUTCDay()]}`;

/** 本周一（周一为一周第一天）起的三周 */
function weeksFrom(today: Date): Date[][] {
  const monday = addDays(today, -((today.getUTCDay() + 6) % 7));
  return [0, 1, 2].map((week) => Array.from({ length: 7 }, (_, index) => addDays(monday, week * 7 + index)));
}

function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / DAY_MS);
}

/** 买家提示词用（英文）：现在时间 + 三周日历；会话不是今天开始的，注明剧本里的相对日期从哪天算 */
export function buyerTimeLines(now: Date, startedAt?: Date | string | null): string[] {
  const { day: today, time } = localDay(now);
  const tag = (day: Date) => {
    const offset = daysBetween(today, day);
    return offset === 0 ? " (today)" : offset === 1 ? " (tomorrow)" : offset === -1 ? " (yesterday)" : "";
  };
  const labels = ["this week", "next week", "the week after"];
  const lines = [
    `Right now it is ${WEEKDAYS_FULL_EN[today.getUTCDay()]}, ${today.getUTCDate()} ${MONTHS_EN[today.getUTCMonth()]} ${today.getUTCFullYear()}, ${time}. The store's order and tracking dates use the same calendar.`,
    "Calendar (weeks start on Monday). Use it for EVERY day, date and deadline you mention; never work out weekdays or dates on your own:",
    ...weeksFrom(today).map((week, index) => `- ${labels[index]}: ${week.map((day) => shortEn(day) + tag(day)).join(", ")}`),
  ];
  if (startedAt) {
    const started = localDay(new Date(startedAt)).day;
    if (daysBetween(started, today) !== 0) {
      lines.push(`This conversation started on ${shortEn(started)}. Relative dates in your script and in earlier messages (like "next Friday") count from that day.`);
    }
  }
  return lines;
}

/** 导演提示词用（中文）：备忘录要把相对日期落成具体日期，买家才不会前后说岔 */
export function directorTimeLine(now: Date): string {
  const { day: today, time } = localDay(now);
  const labels = ["本周", "下周", "下下周"];
  const weeks = weeksFrom(today).map((week, index) => `${labels[index]}：${week.map(shortZh).join("、")}`);
  return `现在是 ${today.getUTCFullYear()}年${shortZh(today)} ${time}（北京时间）。日历（周一为一周第一天）：${weeks.join("；")}`;
}

/** 订单里的 ISO 时间 → “Fri 9 Oct (4 days ago)”，模型直接读得懂、算得对 */
export function describeDate(value: string, now: Date): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  const day = localDay(at).day;
  const offset = daysBetween(day, localDay(now).day);
  const relative = offset === 0 ? "today" : offset === 1 ? "yesterday" : offset > 1 ? `${offset} days ago` : `in ${-offset} days`;
  return `${shortEn(day)} ${day.getUTCFullYear()} (${relative})`;
}
