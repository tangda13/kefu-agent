import { Maximize2 } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useBrand } from "../../brand";
import { resolveRef, useHelp } from "./model";
import { shotMarks, shotSize, shotUrl } from "./shots";

/** 正文里的平台名称：跟着管理端的品牌设置走 */
export function BrandName() {
  const { brand } = useBrand();
  return <>{brand.name}</>;
}

/** 截图 + 蓝色编号 + 编号说明；点截图放大看 */
export function Shot({ name, alt, caption, legend, single }: {
  name: string;
  alt: string;
  caption?: ReactNode;
  /** 第 n 条对应截图上的编号 n：[名称, 说明] */
  legend?: Array<[ReactNode, ReactNode]>;
  /** 说明比较长时一行一条 */
  single?: boolean;
}) {
  const { zoom, printing, audit } = useHelp();
  audit?.shot(name, legend?.length ?? 0);
  return (
    <figure className="help-fig">
      <ShotPicture name={name} alt={alt} eager={printing} onClick={printing ? undefined : () => zoom({ name, alt })} />
      {caption ? <figcaption>{caption}</figcaption> : null}
      {legend?.length ? (
        <ol className={single ? "help-legend is-single" : "help-legend"}>
          {legend.map(([title, desc], index) => (
            <li key={index}><i>{index + 1}</i><span><b>{title}</b>{desc}</span></li>
          ))}
        </ol>
      ) : null}
    </figure>
  );
}

export function ShotPicture({ name, alt, eager, onClick }: { name: string; alt: string; eager?: boolean; onClick?: () => void }) {
  const url = shotUrl(name);
  const marks = shotMarks(name);
  const size = shotSize(name);
  const style = size ? ({ "--shot-w": `${size[0]}px` } as CSSProperties) : undefined;
  const content = (
    <>
      {url ? <img src={url} alt={alt} width={size?.[0]} height={size?.[1]} loading={eager ? "eager" : "lazy"} decoding="async" /> : null}
      {marks.map(([x, y], index) => (
        <span key={index} className="help-mark" style={{ left: `${x}%`, top: `${y}%` }} aria-hidden="true">{index + 1}</span>
      ))}
    </>
  );
  if (!onClick) return <span className="help-pic" style={style}>{content}</span>;
  return (
    <button type="button" className="help-pic" style={style} onClick={onClick} aria-label={`放大看：${alt}`}>
      {content}
      <span className="zoom"><Maximize2 size={13} aria-hidden="true" />点击放大</span>
    </button>
  );
}

/** 图解（SVG）外面包一层，带图注 */
export function Figure({ caption, children }: { caption?: ReactNode; children: ReactNode }) {
  return (
    <figure className="help-fig">
      {children}
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}

export function Steps({ children }: { children: ReactNode }) {
  return <ol className="help-steps">{children}</ol>;
}

export function Dots({ children }: { children: ReactNode }) {
  return <ul className="help-dots">{children}</ul>;
}

export function Tip({ children, title = "提示" }: { children: ReactNode; title?: string }) {
  return <div className="help-tip"><b>{title}</b>{children}</div>;
}

export function Note({ children, title = "注意" }: { children: ReactNode; title?: string }) {
  return <div className="help-tip is-warn"><b>{title}</b>{children}</div>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="help-kbd">{children}</span>;
}

export function Chip({ tone, children }: { tone: "good" | "ok" | "bad" | "severe"; children: ReactNode }) {
  return <span className={`help-chip is-${tone}`}>{children}</span>;
}

/** 跨章引用：默认写成“8.6 客服不回复时”，点了跳过去；这本手册里没有那一节就只留文字 */
export function Ref({ to, children }: { to: string; children?: ReactNode }) {
  const { manual, goTo, printing, audit } = useHelp();
  const target = resolveRef(manual, to);
  if (!target) {
    audit?.missingRef(to);
    return <>{children ?? null}</>;
  }
  const label = children ?? `${target.number} ${target.title}`;
  if (printing) return <>{label}</>;
  return <button type="button" className="help-ref" onClick={() => goTo(to)}>{label}</button>;
}

/** 表格：第一列默认加粗不折行（名称列）；grid 时数字居中 */
export function Table({ head, rows, grid, plain }: { head: ReactNode[]; rows: ReactNode[][]; grid?: boolean; plain?: boolean }) {
  return (
    <table className={grid ? "help-table is-grid" : "help-table"}>
      <thead><tr>{head.map((cell, index) => <th key={index}>{cell}</th>)}</tr></thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr key={rowIndex}>{row.map((cell, index) => <td key={index} className={index === 0 && !grid && !plain ? "k" : undefined}>{cell}</td>)}</tr>
        ))}
      </tbody>
    </table>
  );
}

/** 常见问题：问 + 答 */
export function QA({ items }: { items: Array<[ReactNode, ReactNode]> }) {
  return (
    <dl className="help-qa">
      {items.map(([question, answer], index) => (
        <div key={index}><dt>{question}</dt><dd>{answer}</dd></div>
      ))}
    </dl>
  );
}
