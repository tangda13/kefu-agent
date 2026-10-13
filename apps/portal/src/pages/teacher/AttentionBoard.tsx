import { ArrowDownRight, ArrowRight, Check, CircleCheck, Download, Hourglass, TrendingDown, type LucideIcon } from "lucide-react";
import { useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { ASSESSMENT_DIMENSIONS } from "@cecs/contracts";
import type { ClassStudent } from "../../api/client";
import { Board, Button, Drawer, FilterChips, HelpTip, SearchBox } from "../../ui";
import { openReplayFor } from "./widgets";

/** 考核报表接口里一行排名（和 LiveReports 的 ReportData.ranking 同形） */
export interface RankingRow {
  name: string;
  username: string;
  average: number;
  baseline: number | null;
  dims: Record<string, number | null>;
}

type Reason = "low" | "down" | "none";

interface AttentionRow {
  key: string;
  reason: Reason;
  name: string;
  username: string;
  /** 情况：几分 · 最弱哪项 / 训前 → 现在 / 练没练过 */
  detail: { strong?: string; text: string };
  lastAt: string | null;
  neverLoggedIn: boolean;
  hasRecords: boolean;
  /** 越小越靠前：分数、退步幅度、从没练过 */
  severity: number;
}

const REASONS: Array<{ id: Reason; label: string; desc: string; tone: "bad" | "warn"; icon: LucideIcon }> = [
  { id: "low", label: "低于 60 分", desc: "综合成绩（各任务成绩的平均）不到 60 分", tone: "bad", icon: TrendingDown },
  { id: "down", label: "比训前退步", desc: "综合成绩比训前测评的分数低", tone: "bad", icon: ArrowDownRight },
  { id: "none", label: "还没有成绩", desc: "在班级名单里，但还没有一次接待出了评分", tone: "warn", icon: Hourglass },
];
const AVATAR_CAT = [1, 2, 3, 4];
const PREVIEW = 5;

function lastText(iso: string | null, neverLoggedIn: boolean): { text: string; warn: boolean } {
  if (!iso) return { text: neverLoggedIn ? "从没登录过" : "还没练过", warn: true };
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 86400000);
  if (days === 0) return { text: `今天 ${new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`, warn: false };
  if (days === 1) return { text: "昨天", warn: false };
  return { text: `${days} 天前`, warn: days >= 7 };
}

function weakest(dims: Record<string, number | null>): string {
  const worst = ASSESSMENT_DIMENSIONS.map((dim) => ({ label: dim.label, value: dims[dim.id] })).filter((dim) => dim.value != null).sort((a, b) => a.value! - b.value!)[0];
  return worst ? `最弱：${worst.label} ${worst.value}` : "";
}

/**
 * 需要关注的学生（D-30）：上面三格是原因（大数字，点一格筛选），下面一张统一名单。
 * 名单最多显示 5 人、按严重程度排序；其余在“查看全部”抽屉里看，人多时这块高度不变，不会把下面的图表压下去。
 */
export function AttentionBoard({ ranking, roster, hasBaseline, scopeName, onNavigate }: {
  ranking: RankingRow[];
  roster: ClassStudent[];
  hasBaseline: boolean;
  scopeName: string;
  onNavigate?: (page: string) => void;
}) {
  const rows = useMemo<AttentionRow[]>(() => {
    const byUser = new Map(roster.map((row) => [row.username, row]));
    const scored = new Set(ranking.map((row) => row.username));
    const base = (row: RankingRow, reason: Reason, detail: AttentionRow["detail"], severity: number): AttentionRow => ({
      key: `${reason}-${row.username}`, reason, name: row.name, username: row.username, detail,
      lastAt: byUser.get(row.username)?.lastActiveAt ?? null, neverLoggedIn: false, hasRecords: true, severity,
    });
    return [
      ...ranking.filter((row) => row.average < 60).map((row) => base(row, "low", { strong: `${row.average}`, text: ` 分 · ${weakest(row.dims)}` }, row.average)),
      ...ranking.filter((row) => row.baseline != null && row.average < row.baseline).map((row) => base(row, "down", { strong: `${row.baseline} → ${row.average}`, text: ` · 退步 ${row.baseline! - row.average} 分` }, row.average - row.baseline!)),
      ...roster.filter((row) => row.status === "active" && !scored.has(row.username)).map((row): AttentionRow => ({
        key: `none-${row.username}`, reason: "none", name: row.displayName, username: row.username,
        detail: { text: row.lastActiveAt ? "练过，还没有评分" : "还没开始练" },
        lastAt: row.lastActiveAt, neverLoggedIn: row.mustChangePassword && !row.lastActiveAt, hasRecords: false,
        severity: row.lastActiveAt ? 1 : 0,
      })),
    ];
  }, [ranking, roster]);

  const counts = { low: 0, down: 0, none: 0 } as Record<Reason, number>;
  rows.forEach((row) => { counts[row.reason] += 1; });
  const firstWith = REASONS.find((item) => counts[item.id] > 0)?.id ?? "low";
  const [picked, setPicked] = useState<Reason | null>(null);
  const reason = picked ?? firstWith;
  const [all, setAll] = useState(false);
  const people = new Set(rows.map((row) => row.username)).size;
  const sorted = (list: AttentionRow[]) => [...list].sort((a, b) => a.severity - b.severity);
  const current = sorted(rows.filter((row) => row.reason === reason));

  function exportList(list: AttentionRow[], label: string) {
    const sheet = XLSX.utils.json_to_sheet(list.map((row) => ({
      姓名: row.name, 学号: row.username, 原因: REASONS.find((item) => item.id === row.reason)!.label,
      情况: `${row.detail.strong ?? ""}${row.detail.text}`, 最近练习: lastText(row.lastAt, row.neverLoggedIn).text,
    })));
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "需要关注的学生");
    XLSX.writeFile(book, `需要关注的学生-${scopeName}-${label}.xlsx`);
  }

  return (
    <Board
      title="需要关注的学生"
      count={`${people} 人`}
      extra={rows.length ? <Button size="sm" variant="ghost" icon={Download} onClick={() => exportList(sorted(rows), "全部")}>导出名单</Button> : undefined}
    >
      <div className="at-cells" role="tablist">
        {REASONS.map((item) => {
          const count = counts[item.id];
          return (
            <button key={item.id} type="button" role="tab" aria-selected={reason === item.id} className={reason === item.id ? "at-cell is-on" : "at-cell"} onClick={() => setPicked(item.id)}>
              {/* D-31：0 人时不写“没有”，图标块变灰并带绿色小勾 */}
              <span className={count ? `at-cell-icon is-${item.tone}` : "at-cell-icon"}>
                <item.icon size={19} />
                {count ? null : <span className="badge-ok"><Check size={10} strokeWidth={3} /></span>}
              </span>
              <span className="at-cell-text">
                <span className="at-cell-label">{item.label}<HelpTip>{item.desc}</HelpTip></span>
                <span className={count ? `at-cell-num is-${item.tone}` : "at-cell-num is-zero"}>{count}{count ? <small>人</small> : null}</span>
                {!count && item.id === "down" && !hasBaseline ? <span className="at-cell-note">做过训前测评后才能比较</span> : null}
              </span>
            </button>
          );
        })}
      </div>
      {current.length ? (
        <>
          <AttentionTable rows={current.slice(0, PREVIEW)} onNavigate={onNavigate} />
          {current.length > PREVIEW ? (
            <button type="button" className="at-more" onClick={() => setAll(true)}>
              <span>还有 {current.length - PREVIEW} 人没显示，按严重程度排在后面</span>
              <b>查看全部 {current.length} 人<ArrowRight size={14} /></b>
            </button>
          ) : null}
        </>
      ) : (
        <p className="at-clear"><CircleCheck size={16} />{rows.length ? `“${REASONS.find((item) => item.id === reason)!.label}”没有学生，点上面的格子看其他原因` : "全班都在正轨：没人低于 60 分、没人退步、都有成绩"}</p>
      )}
      {all ? <AttentionDrawer rows={rows} initial={reason} scopeName={scopeName} onExport={exportList} onNavigate={onNavigate} onClose={() => setAll(false)} sorted={sorted} /> : null}
    </Board>
  );
}

function AttentionTable({ rows, onNavigate }: { rows: AttentionRow[]; onNavigate?: (page: string) => void }) {
  return (
    <div className="at-table">
      <div className="at-row is-head"><span>学生</span><span>原因</span><span>情况</span><span>最近练习</span><span /></div>
      {rows.map((row, index) => {
        const last = lastText(row.lastAt, row.neverLoggedIn);
        const meta = REASONS.find((item) => item.id === row.reason)!;
        const cat = AVATAR_CAT[index % AVATAR_CAT.length];
        return (
          <div key={row.key} className="at-row">
            <span className="at-who">
              <span className="at-avatar" style={{ background: `var(--c-cat-${cat}-soft)`, color: `var(--c-cat-${cat})` }}>{row.name.slice(0, 1)}</span>
              <span><b>{row.name}</b><small>{row.username}</small></span>
            </span>
            <span><span className={`ui-tag is-${meta.tone === "bad" ? "danger" : "warn"}`}>{meta.label}</span></span>
            <span className="at-detail">{row.detail.strong ? <b className={row.reason === "none" ? undefined : "is-bad"}>{row.detail.strong}</b> : null}{row.detail.text}</span>
            <span className={last.warn ? "at-last is-warn" : "at-last"}>{last.text}</span>
            <span className="at-ops">
              {row.hasRecords
                ? <Button size="sm" onClick={() => { openReplayFor(row.name); onNavigate?.("tracking"); }}>看回放</Button>
                : <Button size="sm" variant="ghost" onClick={() => onNavigate?.("classes")}>去班级</Button>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function AttentionDrawer({ rows, initial, scopeName, onExport, onNavigate, onClose, sorted }: {
  rows: AttentionRow[];
  initial: Reason;
  scopeName: string;
  onExport: (list: AttentionRow[], label: string) => void;
  onNavigate?: (page: string) => void;
  onClose: () => void;
  sorted: (list: AttentionRow[]) => AttentionRow[];
}) {
  const [reason, setReason] = useState<Reason>(initial);
  const [keyword, setKeyword] = useState("");
  const word = keyword.trim().toLowerCase();
  const list = sorted(rows.filter((row) => row.reason === reason && (!word || `${row.name} ${row.username}`.toLowerCase().includes(word))));
  const label = REASONS.find((item) => item.id === reason)!.label;
  return (
    <Drawer
      title={`需要关注的学生 · ${scopeName}`}
      width={880}
      flush
      onClose={onClose}
      footer={<><Button variant="ghost" icon={Download} disabled={!list.length} onClick={() => onExport(list, label)}>导出这 {list.length} 人</Button><span className="drawer-spacer" /><Button onClick={onClose}>关闭</Button></>}
    >
      <div className="at-drawer-bar">
        <FilterChips
          items={REASONS.map((item) => ({ id: item.id, label: item.label, count: rows.filter((row) => row.reason === item.id).length }))}
          value={reason}
          onChange={setReason}
        />
        <SearchBox value={keyword} onChange={setKeyword} placeholder="搜索姓名或学号" />
      </div>
      {list.length ? <AttentionTable rows={list} onNavigate={(page) => { onClose(); onNavigate?.(page); }} /> : <p className="at-clear"><CircleCheck size={16} />没有符合条件的学生</p>}
    </Drawer>
  );
}
