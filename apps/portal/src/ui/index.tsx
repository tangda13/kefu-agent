import { Check, CircleHelp, Ellipsis, KeyRound, LoaderCircle, Search, X, type LucideIcon } from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { BUSINESS_STAGE_LABELS, type BusinessStage } from "@cecs/contracts";

/* 三端共用组件（H3）。规格见根目录 DESIGN.md 第 6 节，样式在 styles/ui.css，全部消费 tokens.css。 */

const cx = (...names: Array<string | false | null | undefined>) => names.filter(Boolean).join(" ");

// ---------- 按钮 ----------

export type ButtonVariant = "primary" | "secondary" | "text" | "ghost" | "danger";

export function Button({
  variant = "secondary",
  size = "md",
  icon: Icon,
  loading = false,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "md" | "sm"; icon?: LucideIcon; loading?: boolean }) {
  return (
    <button
      type={type}
      className={cx("ui-btn", `ui-btn-${variant}`, size === "sm" && "ui-btn-sm", loading && "is-loading", className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <LoaderCircle className="ui-spin" size={14} /> : Icon ? <Icon size={14} /> : null}
      {children}
    </button>
  );
}

export function IconButton({ icon: Icon, label, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string }) {
  return (
    <button type="button" className={cx("ui-icon-btn", className)} aria-label={label} title={label} {...rest}>
      <Icon size={16} />
    </button>
  );
}

// ---------- 表单 ----------

export function Field({ label, hint, error, children, className }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx("ui-field", error ? "has-error" : null, className)}>
      <span className="ui-field-label">{label}</span>
      {children}
      {error ? <span className="ui-field-error">{error}</span> : hint ? <span className="ui-field-hint">{hint}</span> : null}
    </label>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx("ui-input", className)} {...rest} />;
}

/**
 * 密钥输入：已保存时只显示服务端给的打码值（如 sk-w****z7gW），点“更换”才出现空输入框；
 * 明文从不回传前端，打码值也不放进输入框（免得被当成新密钥提交）。value 为空表示不改。
 */
export function SecretInput({ masked, value, onChange, placeholder = "粘贴密钥" }: { masked?: string; value: string; onChange: (next: string) => void; placeholder?: string }) {
  const [editing, setEditing] = useState(false);
  // 保存后服务端打码值变了：回到“已设置”显示
  useEffect(() => setEditing(false), [masked]);
  if (masked && !editing && !value) {
    return (
      <div className="ui-secret">
        <KeyRound size={15} aria-hidden="true" />
        <span className="ui-secret-value">{masked}</span>
        <span className="ui-secret-state">已设置</span>
        <button type="button" onClick={() => setEditing(true)}>更换</button>
      </div>
    );
  }
  return (
    <div className="ui-secret-edit">
      <input
        className="ui-input"
        type="password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={masked ? "粘贴新的密钥" : placeholder}
        autoComplete="new-password"
        spellCheck={false}
        autoFocus={editing}
      />
      {masked ? <button type="button" onClick={() => { onChange(""); setEditing(false); }}>取消</button> : null}
    </div>
  );
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx("ui-select", className)} {...rest}>
      {children}
    </select>
  );
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx("ui-textarea", className)} {...rest} />;
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      className={cx("ui-switch", checked && "is-on")}
      onClick={() => onChange(!checked)}
    />
  );
}

// ---------- 切换 ----------

export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
  count?: number;
}

export function Tabs<T extends string>({ items, value, onChange, className }: { items: TabItem<T>[]; value: T; onChange: (id: T) => void; className?: string }) {
  return (
    <div className={cx("ui-tabs", className)} role="tablist">
      {items.map((item) => (
        <button key={item.id} type="button" role="tab" aria-selected={item.id === value} className={cx("ui-tab", item.id === value && "is-active")} onClick={() => onChange(item.id)}>
          {item.label}
          {item.count !== undefined ? <span className="ui-count">{item.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({ items, value, onChange, className, disabled }: { items: TabItem<T>[]; value: T; onChange: (id: T) => void; className?: string; disabled?: boolean }) {
  return (
    <div className={cx("ui-seg", disabled && "is-disabled", className)} role="radiogroup" aria-disabled={disabled || undefined}>
      {items.map((item) => (
        <button key={item.id} type="button" role="radio" aria-checked={item.id === value} disabled={disabled} className={cx(item.id === value && "is-active")} onClick={() => onChange(item.id)}>
          {item.label}
          {item.count !== undefined ? <span className="ui-count">{item.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

// ---------- 状态 ----------

export type Tone = "neutral" | "ok" | "warn" | "danger" | "accent";

export function Tag({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={cx("ui-tag", `is-${tone}`)}>{children}</span>;
}

/** 业务环节标签，用织 UI 分类色：售中 1、售前 2、售后 3、客户分层 4 */
const STAGE_CAT: Record<BusinessStage, number> = { in_sale: 1, pre_sale: 2, after_sale: 3, customer_care: 4 };
export function StageTag({ stage }: { stage: BusinessStage }) {
  return <span className={cx("ui-tag", `is-cat-${STAGE_CAT[stage] ?? 6}`)}>{BUSINESS_STAGE_LABELS[stage] ?? stage}</span>;
}

export function Status({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={cx("ui-status", `is-${tone}`)}>
      <i aria-hidden="true" />
      {children}
    </span>
  );
}

/** 口径说明浮层：14px 问号，悬停或聚焦时显示 */
/** 问号提示：口径、术语这类“看过一次就记住”的说明收在这里，不铺在页面上。
    浮层挂到 body 上（fixed 定位），不会被内容板的 overflow 裁掉；放不下时往上翻 */
export function HelpTip({ children, label = "说明" }: { children: ReactNode; label?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; up: boolean } | null>(null);
  const show = () => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const up = rect.bottom + 90 > window.innerHeight;
    const left = Math.min(Math.max(rect.left + rect.width / 2, 150), window.innerWidth - 150);
    setPos({ left, top: up ? rect.top - 6 : rect.bottom + 6, up });
  };
  return (
    <span ref={ref} className="ui-help" tabIndex={0} aria-label={label} onMouseEnter={show} onMouseLeave={() => setPos(null)} onFocus={show} onBlur={() => setPos(null)} onClick={(event) => event.stopPropagation()}>
      <CircleHelp size={14} aria-hidden="true" />
      {pos ? createPortal(
        <span className={pos.up ? "ui-help-pop is-up" : "ui-help-pop"} role="tooltip" style={{ left: pos.left, top: pos.top }}>{children}</span>,
        document.body,
      ) : null}
    </span>
  );
}

export interface StatItem {
  label: ReactNode;
  value: ReactNode;
  /** 数字后的补充，如“共 32 人” */
  extra?: ReactNode;
  tone?: "danger";
  help?: ReactNode;
}

export function StatBar({ items }: { items: StatItem[] }) {
  return (
    <div className="ui-statbar">
      {items.map((item, index) => (
        <div key={index} className="ui-stat">
          <span className="ui-stat-label">
            {item.label}
            {item.help ? <HelpTip>{item.help}</HelpTip> : null}
          </span>
          <span className="ui-stat-line">
            {item.value === null || item.value === undefined || item.value === "" ? <strong className="is-empty">暂无</strong> : <strong className={cx(item.tone === "danger" && "is-danger")}>{item.value}</strong>}
            {item.extra ? <small>{item.extra}</small> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------- 布局 ----------

export function Panel({ title, extra, children, flush, className }: { title?: ReactNode; extra?: ReactNode; children: ReactNode; flush?: boolean; className?: string }) {
  return (
    <section className={cx("ui-panel", flush && "is-flush", className)}>
      {title || extra ? (
        <header className="ui-panel-head">
          {title ? <h2>{title}</h2> : <span />}
          {extra ? <div className="ui-panel-extra">{extra}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function Toolbar({ children, actions }: { children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="ui-toolbar">
      <div className="ui-toolbar-main">{children}</div>
      {actions ? <div className="ui-toolbar-actions">{actions}</div> : null}
    </div>
  );
}

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="ui-empty">
      <span>{children}</span>
      {action}
    </div>
  );
}

// ---------- 表格 ----------

export interface Column<T> {
  key: string;
  title: ReactNode;
  render: (row: T) => ReactNode;
  align?: "left" | "right" | "center";
  width?: number | string;
}

export function DataTable<T>({ columns, rows, rowKey, empty = "暂无数据", loading }: { columns: Column<T>[]; rows: T[]; rowKey: (row: T) => string; empty?: ReactNode; loading?: boolean }) {
  return (
    <div className="ui-table-wrap">
      <table className="ui-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} style={{ width: column.width, textAlign: column.align }}>{column.title}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading
            ? [0, 1, 2].map((index) => (
                <tr key={index} className="ui-skeleton-row">
                  {columns.map((column) => <td key={column.key}><i /></td>)}
                </tr>
              ))
            : rows.map((row) => (
                <tr key={rowKey(row)}>
                  {columns.map((column) => (
                    <td key={column.key} style={{ textAlign: column.align }} className={column.align === "right" ? "is-num" : undefined}>{column.render(row)}</td>
                  ))}
                </tr>
              ))}
          {!loading && rows.length === 0 ? (
            <tr className="ui-table-empty">
              <td colSpan={columns.length}>{empty}</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

/** 「更多」菜单：收纳次要和危险操作 */
export function MoreMenu({ items, label = "更多操作", trigger, triggerClassName }: { items: Array<{ label: string; onClick: () => void; danger?: boolean; disabled?: boolean; icon?: LucideIcon; separated?: boolean }>; label?: string; /** 自定义触发按钮的内容（默认是“…”图标按钮） */ trigger?: ReactNode; triggerClassName?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <span className="ui-menu" ref={ref}>
      {trigger ? <button type="button" className={triggerClassName} aria-expanded={open} onClick={() => setOpen((value) => !value)}>{trigger}</button> : <IconButton icon={Ellipsis} label={label} onClick={() => setOpen((value) => !value)} aria-expanded={open} />}
      {open ? (
        <span className="ui-menu-pop" role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              className={cx(item.danger && "is-danger", item.separated && "is-separated")}
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
            >
              {item.icon ? <item.icon size={15} /> : null}
              {item.label}
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
}

// ---------- 浮层 ----------

/** Esc 只关最上面一层：弹窗里再开弹窗（如选择商品、选类目）时，不连带关掉下面的 */
const escapeLayers: Array<{ current: () => void }> = [];
function useEscape(onClose: () => void) {
  const layer = useRef(onClose);
  layer.current = onClose;
  useEffect(() => {
    escapeLayers.push(layer);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && escapeLayers[escapeLayers.length - 1] === layer) layer.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      escapeLayers.splice(escapeLayers.indexOf(layer), 1);
    };
  }, []);
}

export function Dialog({ title, width = 480, onClose, footer, children }: { title: ReactNode; width?: 480 | 640 | 760 | 900 | 1000; onClose: () => void; footer?: ReactNode; children: ReactNode }) {
  useEscape(onClose);
  return createPortal(
    <div className="ui-overlay" onMouseDown={onClose}>
      <div className="ui-dialog" style={{ width }} role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <header className="ui-dialog-head">
          <h2>{title}</h2>
          <IconButton icon={X} label="关闭" onClick={onClose} />
        </header>
        <div className="ui-dialog-body">{children}</div>
        {footer ? <footer className="ui-dialog-foot">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}

export function Drawer({ title, width = 480, onClose, footer, children, flush }: { title: ReactNode; width?: 480 | 720 | 880 | 1040; onClose: () => void; footer?: ReactNode; children: ReactNode; flush?: boolean }) {
  useEscape(onClose);
  return createPortal(
    <div className="ui-overlay is-drawer" onMouseDown={onClose}>
      <aside className="ui-drawer" style={{ width }} role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <header className="ui-dialog-head">
          <h2>{title}</h2>
          <IconButton icon={X} label="关闭" onClick={onClose} />
        </header>
        <div className={cx("ui-drawer-body", flush && "is-flush")}>{children}</div>
        {footer ? <footer className="ui-dialog-foot">{footer}</footer> : null}
      </aside>
    </div>,
    document.body,
  );
}

/** 二次确认：危险操作用 danger 实底按钮 */
export function Confirm({ title, children, confirmText = "确定", danger, busy, onConfirm, onClose }: { title: ReactNode; children: ReactNode; confirmText?: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant={danger ? "danger" : "primary"} loading={busy} onClick={onConfirm}>{confirmText}</Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}

// ---------- 轻提示 ----------

type ToastTone = "ok" | "danger";
let pushToast: ((text: string, tone: ToastTone) => void) | null = null;

/** 顶部居中的轻提示，3 秒后消失。App 根部放一个 <Toaster />。 */
export const toast = {
  ok: (text: string) => pushToast?.(text, "ok"),
  error: (text: string) => pushToast?.(text, "danger"),
};

export function Toaster() {
  const [items, setItems] = useState<Array<{ id: number; text: string; tone: ToastTone }>>([]);
  useEffect(() => {
    let seq = 0;
    pushToast = (text, tone) => {
      const id = ++seq;
      setItems((list) => [...list, { id, text, tone }]);
      window.setTimeout(() => setItems((list) => list.filter((item) => item.id !== id)), 3000);
    };
    return () => {
      pushToast = null;
    };
  }, []);
  return createPortal(
    <div className="ui-toaster" aria-live="polite">
      {items.map((item) => (
        <div key={item.id} className={cx("ui-toast", `is-${item.tone}`)}>{item.text}</div>
      ))}
    </div>,
    document.body,
  );
}

// ======================================================================
// “一张纸”版式（D-25）：页头页签、白底页面、分区、设置分区、数字、进度、列表行、提醒
// ======================================================================

/** 外壳顶栏里留给页面的位置（页签），AppShell 提供 */
export const ShellSlotContext = createContext<HTMLElement | null>(null);

/** 页签放进顶栏、紧跟页名；不在外壳里（如组件陈列页）时原地渲染 */
export function HeaderTabs<T extends string>(props: { items: TabItem<T>[]; value: T; onChange: (id: T) => void }) {
  const slot = useContext(ShellSlotContext);
  const tabs = <Tabs {...props} className="is-header" />;
  return slot ? createPortal(tabs, slot) : tabs;
}

/** 白底页面容器，替代“灰底 + 白面板” */
export function Sheet({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("sheet", className)}>{children}</div>;
}

/** 无边框分区：标题 + 一句说明 + 右侧操作 */
export function Section({ title, desc, actions, children, className }: { title?: ReactNode; desc?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("sec", className)}>
      {title || actions ? (
        <header className="sec-head">
          <div>
            {title ? <h2>{title}</h2> : null}
            {desc ? <p>{desc}</p> : null}
          </div>
          {actions ? <div className="sec-actions">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

/** 配置页的一节：左栏说明，右栏内容 */
export function SettingSection({ title, desc, actions, children }: { title: ReactNode; desc?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="setting-sec">
      <div className="setting-label">
        <h2>{title}</h2>
        {desc ? <p>{desc}</p> : null}
        {actions ? <div className="setting-label-actions">{actions}</div> : null}
      </div>
      <div className="setting-body">{children}</div>
    </section>
  );
}

/** 关键数字：大号数字一排，竖线分隔，不加方框 */
export function Figures({ items }: { items: Array<{ label: ReactNode; value: ReactNode; extra?: ReactNode; tone?: "danger" | "ok" }> }) {
  return (
    <div className="figures" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
      {items.map((item, index) => {
        const empty = item.value === null || item.value === undefined || item.value === "";
        return (
          <div key={index} className="figure">
            <span className="figure-label">{item.label}</span>
            <strong className={cx("figure-value", empty && "is-empty", item.tone && `is-${item.tone}`)}>{empty ? "暂无" : item.value}</strong>
            <span className="figure-extra">{item.extra ?? " "}</span>
          </div>
        );
      })}
    </div>
  );
}

/** 有“要求”的指标：进度条 + 要求线 */
export function Gauge({ label, requirement, value, percent, requirementAt, pass, note, diff }: {
  label: ReactNode;
  requirement: ReactNode;
  value: ReactNode;
  /** 0–100，进度条长度；null 表示暂无数据 */
  percent: number | null;
  /** 0–100，要求线的位置 */
  requirementAt?: number;
  pass: boolean | null;
  note?: ReactNode;
  diff?: ReactNode;
}) {
  return (
    <div className="gauge">
      <div className="gauge-row">
        <span className="gauge-label">{label}</span>
        <span className="gauge-req">要求 {requirement}</span>
        <strong className={cx("gauge-value", pass === true && "is-ok", pass === false && "is-danger")}>{percent === null ? "暂无数据" : value}</strong>
      </div>
      <div className="gauge-bar">
        {percent !== null ? <i className={cx(pass === false && "is-danger")} style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} /> : null}
        {requirementAt !== undefined ? <span className="gauge-line" style={{ left: `${Math.max(0, Math.min(100, requirementAt))}%` }} /> : null}
      </div>
      {note || diff ? <div className="gauge-sub"><span>{note}</span><span>{diff}</span></div> : null}
    </div>
  );
}

/** 条目少的列表的一行：图标 + 名称/说明 + 状态 + 操作，没有表头 */
export function ListRow({ leading, title, meta, status, actions, muted }: { leading?: ReactNode; title: ReactNode; meta?: ReactNode; status?: ReactNode; actions?: ReactNode; muted?: boolean }) {
  return (
    <div className={cx("list-row", muted && "is-muted")}>
      {leading ? <span className="list-lead">{leading}</span> : null}
      <div className="list-main">
        <div className="list-title">{title}</div>
        {meta ? <div className="list-meta">{meta}</div> : null}
      </div>
      {status ? <div className="list-status">{status}</div> : null}
      {actions ? <div className="list-actions">{actions}</div> : null}
    </div>
  );
}

/** 名称首字母方块，用作列表行的图标 */
export function Monogram({ text, tone = 0 }: { text: string; tone?: number }) {
  return <span className={cx("monogram", `tone-${tone % 4}`)}>{text.trim().slice(0, 1).toUpperCase()}</span>;
}

/** 需要处理的事：一行提醒条 */
export function Callout({ tone = "warn", icon: Icon, title, children, actions }: { tone?: "warn" | "danger" | "ok" | "info"; icon?: LucideIcon; title: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className={cx("callout", `is-${tone}`)} role={tone === "danger" ? "alert" : "status"}>
      {Icon ? <Icon size={16} /> : null}
      <strong>{title}</strong>
      {children ? <span className="callout-text">{children}</span> : null}
      {actions ? <span className="callout-actions">{actions}</span> : null}
    </div>
  );
}

/** 页面状态总述：一句结论 + 一句说明，右侧放元信息 */
export function StatusHero({ tone, icon: Icon, title, desc, meta }: { tone: "ok" | "warn" | "danger"; icon: LucideIcon; title: ReactNode; desc?: ReactNode; meta?: ReactNode }) {
  return (
    <div className="status-hero">
      <span className={cx("status-hero-icon", `is-${tone}`)}><Icon size={22} /></span>
      <div>
        <h2>{title}</h2>
        {desc ? <p>{desc}</p> : null}
      </div>
      {meta ? <div className="status-hero-meta">{meta}</div> : null}
    </div>
  );
}

/** 搜索框：放大镜 + 输入框 */
export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <span className="search-input">
      <Search size={14} />
      <Input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
    </span>
  );
}

/** 多选标签：点一下选中/取消。用于班级、场景、画像规则这类“从一小组里挑几个” */
export function ChipSelect<T extends string>({ options, value, onChange, disabled, empty }: {
  options: Array<{ id: T; label: ReactNode; meta?: ReactNode }>;
  value: T[];
  onChange: (next: T[]) => void;
  disabled?: boolean;
  empty?: ReactNode;
}) {
  if (options.length === 0) return <span className="chip-select-empty">{empty ?? "没有可选项"}</span>;
  return (
    <div className={cx("chip-select", disabled && "is-disabled")}>
      {options.map((option) => {
        const on = value.includes(option.id);
        return (
          <button
            key={option.id}
            type="button"
            className={cx("chip", on && "is-on")}
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onChange(on ? value.filter((item) => item !== option.id) : [...value, option.id])}
          >
            {on ? <Check size={13} /> : null}
            {option.label}
            {option.meta ? <small>{option.meta}</small> : null}
          </button>
        );
      })}
    </div>
  );
}

/** 只读的“名称：值”清单，用于详情抽屉 */
export function KeyValues({ items }: { items: Array<{ label: ReactNode; value: ReactNode }> }) {
  return (
    <dl className="kv">
      {items.map((item, index) => (
        <div key={index}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ======================================================================
// “工作台”版式（D-27，教师端）：浅灰底 + 少量白色内容板 + 内容限宽
// ======================================================================

/** 工作台页面容器：浅灰底，内容限宽 1120 */
export function Bench({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("bench", className)}><div className="bench-wrap">{children}</div></div>;
}

/** 白色内容板：一页一到两块，标题行可带数量和右侧操作 */
export function Board({ title, count, extra, children, className }: {
  title?: ReactNode; count?: ReactNode; extra?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={cx("board", className)}>
      {title || extra ? (
        <header className="board-head">
          {title ? <h3>{title}</h3> : null}
          {count != null ? <span className="board-count">{count}</span> : null}
          {extra ? <div className="board-extra">{extra}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

/** 板子里的“更多”文字链接（带右箭头） */
export function BoardLink({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return <button type="button" className="board-link" onClick={onClick}>{children}<span aria-hidden="true">›</span></button>;
}

/** 筛选标签：单选，带数量 */
export function FilterChips<T extends string>({ items, value, onChange }: { items: Array<{ id: T; label: ReactNode; count?: number }>; value: T; onChange: (id: T) => void }) {
  return (
    <div className="filter-chips" role="tablist">
      {items.map((item) => (
        <button key={item.id} type="button" role="tab" aria-selected={value === item.id} className={value === item.id ? "is-on" : undefined} onClick={() => onChange(item.id)}>
          {item.label}{item.count != null ? <i>{item.count}</i> : null}
        </button>
      ))}
    </div>
  );
}

/** 强调色小标签：红 = 低分/逾期，橙 = 快到期/多日没练 */
export function Flag({ tone, children }: { tone: "bad" | "warn" | "plain"; children: ReactNode }) {
  return <span className={cx("flag", `is-${tone}`)}>{children}</span>;
}
