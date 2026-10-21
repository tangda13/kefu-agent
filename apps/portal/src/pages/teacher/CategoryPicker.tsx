import { ChevronRight, Search } from "lucide-react";
import { useMemo, useState } from "react";
import {
  CATEGORY_SEP, CATEGORY_TREE, categoryLeaves, categoryNodes, categoryPathOf, categoryTemplate, isLeafCategory,
  type CategoryNode,
} from "@cecs/contracts";
import { Button, Dialog } from "../../ui";

/**
 * 选择类目（D-65，设计稿 docs/design/p17-params-teacher 第九节）：参照 1688、淘宝——顶部面包屑是已选路径，点哪一级回到哪一级；
 * 可以直接输入商品名搜类目；“最近使用”取店里最近上架商品的类目；三列级联，选到最末一级才能确定。右侧写出这个类目要填的规格、属性和尺码表
 */
export function CategoryPicker({ value, recent, onClose, onPick }: {
  value: string | null;
  recent: string[];
  onClose: () => void;
  onPick: (path: string) => void;
}) {
  const [names, setNames] = useState<string[]>(() => categoryNodes(value).map((node) => node.name));
  const [keyword, setKeyword] = useState("");
  const [filters, setFilters] = useState(["", "", ""]);
  const path = categoryPathOf(names);
  const leaf = isLeafCategory(path);
  const template = leaf ? categoryTemplate(path) : null;

  const columns = useMemo(() => {
    const nodes = categoryNodes(path);
    return [CATEGORY_TREE, nodes[0]?.children ?? [], nodes[1]?.children ?? []];
  }, [path]);
  const results = useMemo(() => {
    const word = keyword.trim();
    return word ? categoryLeaves().filter((item) => item.includes(word)).slice(0, 30) : [];
  }, [keyword]);

  const pickAt = (level: number, node: CategoryNode) => setNames([...names.slice(0, level), node.name]);
  const choose = (full: string) => { setNames(full.split(CATEGORY_SEP)); setKeyword(""); };
  const recentLeaves = recent.filter((item) => isLeafCategory(item)).slice(0, 6);

  return (
    <Dialog
      title="选择类目"
      width={1000}
      onClose={onClose}
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" disabled={!leaf} onClick={() => onPick(path)}>确定</Button></>}
    >
      <div className="cpk">
        <div className="cpk-crumb">
          已选类目：
          {names.length ? names.map((name, index) => (
            <span key={`${name}-${index}`}>
              {index ? <i>›</i> : null}
              <button type="button" onClick={() => setNames(names.slice(0, index + 1))}>{name}</button>
            </span>
          )) : <em>还没选</em>}
        </div>
        <div className="cpk-search">
          <Search size={15} />
          <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="类目搜索：可输入商品名称，如 托特包、蓝牙耳机" />
        </div>
        {recentLeaves.length && !keyword ? (
          <div className="cpk-hist">最近使用：{recentLeaves.map((item) => <button key={item} type="button" onClick={() => choose(item)}>{item.split(CATEGORY_SEP).pop()}</button>)}</div>
        ) : null}
        {keyword.trim() ? (
          <div className="cpk-results">
            {results.length ? results.map((item) => (
              <button key={item} type="button" onClick={() => choose(item)}>{item.split(CATEGORY_SEP).join(" › ")}</button>
            )) : <p>没找到“{keyword.trim()}”，换个说法，或者在下面一级一级选</p>}
          </div>
        ) : (
          <div className="cpk-cols">
            {columns.map((nodes, level) => (
              <div key={level} className="cpk-col">
                <input value={filters[level]} placeholder="名称搜索" disabled={!nodes.length}
                  onChange={(event) => setFilters(filters.map((item, i) => (i === level ? event.target.value : item)))} />
                <div className="cpk-list">
                  {nodes.filter((node) => !filters[level]!.trim() || node.name.includes(filters[level]!.trim())).map((node) => (
                    <button key={node.name} type="button" className={names[level] === node.name ? "is-on" : undefined} onClick={() => pickAt(level, node)}>
                      <span>{node.name}</span>{node.children?.length ? <ChevronRight size={14} /> : null}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <div className="cpk-info">
              {template ? (
                <>
                  <h6>这个类目要填</h6>
                  <b>{names.join(" › ")}</b>
                  <dl>
                    <dt>规格</dt>
                    <dd>{template.dims.map((dim) => `${dim.name}${dim.presets ? `（${dim.presets[0]}–${dim.presets[dim.presets.length - 1]}）` : ""}`).join(" × ")}</dd>
                    <dt>属性</dt>
                    <dd>{template.attributes.map((item) => item.name).join("、")}</dd>
                    <dt>尺码表</dt>
                    <dd className={template.sizeChart ? "is-sized" : undefined}>{template.sizeChart ? `需要：${template.sizeChart.join("、")}` : "不需要"}</dd>
                  </dl>
                </>
              ) : <p>选到最末一级，这里会写出要填的规格、属性和尺码表</p>}
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
