import { Download, Plus, Search } from "lucide-react";
import { useState } from "react";
import { BrandMark } from "../../brand";
import {
  Button,
  Confirm,
  DataTable,
  Dialog,
  Drawer,
  Empty,
  Field,
  HelpTip,
  Input,
  MoreMenu,
  Panel,
  Segmented,
  Select,
  StatBar,
  Status,
  Switch,
  Tabs,
  Tag,
  Textarea,
  Toolbar,
  toast,
} from "../../ui";

/* 组件陈列页（H3 验收用，仅开发环境 ?gallery=1 打开）。 */

interface Product {
  id: string;
  name: string;
  spec: string;
  price: string;
  stock: number;
  onSale: boolean;
}

const products: Product[] = [
  { id: "1", name: "Wireless Noise-Cancelling Earbuds", spec: "Black / USB-C / with charging case", price: "USD 39.99", stock: 452, onSale: true },
  { id: "2", name: "Smart LED String Lights 10m", spec: "RGB / App control / IP65", price: "USD 21.50", stock: 1210, onSale: true },
  { id: "3", name: "Stainless Insulated Tumbler 600ml", spec: "Matte green / double wall", price: "USD 15.80", stock: 0, onSale: false },
];

export function UiGallery() {
  const [tab, setTab] = useState<"products" | "scenes" | "personas">("products");
  const [seg, setSeg] = useState<"pending" | "all" | "closed">("pending");
  const [sale, setSale] = useState<Record<string, boolean>>(Object.fromEntries(products.map((item) => [item.id, item.onSale])));
  const [dialog, setDialog] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [confirm, setConfirm] = useState(false);

  return (
    <div className="gallery">
      <header className="gallery-head"><BrandMark size={24} /><strong>组件陈列 · H3</strong><span>DESIGN.md 2.0 墨白</span></header>
      <div className="gallery-body">
        <Panel title="按钮">
          <div className="gallery-row">
            <Button variant="primary" icon={Plus}>新增商品</Button>
            <Button icon={Download}>导出 Excel</Button>
            <Button variant="text">查看详情</Button>
            <Button variant="ghost">取消</Button>
            <Button variant="primary" loading>保存中</Button>
            <Button variant="primary" disabled>不可用</Button>
            <Button size="sm">小按钮</Button>
            <Button variant="danger">删除</Button>
          </div>
        </Panel>

        <StatBar
          items={[
            { label: "正在接待", value: 4, extra: "共 32 人" },
            { label: "需要介入", value: 1, tone: "danger", extra: "买家等待超过 2 分钟", help: "买家等待超过 2 分钟，或情绪变为不满、愤怒。" },
            { label: "综合平均分", value: null, help: "按学生平均：每名学生先算各任务成绩的平均，再求全班平均。自由练习不计入。" },
            { label: "今日已完成", value: 18, extra: "平均 76 分" },
          ]}
        />

        <Panel title="表单" extra={<HelpTip>标签在上方，错误写在下方。</HelpTip>}>
          <div className="gallery-form">
            <Field label="商品名称"><Input placeholder="例如 Wireless Earbuds" /></Field>
            <Field label="业务环节"><Select defaultValue="after"><option value="pre">售前沟通</option><option value="mid">售中处理</option><option value="after">售后处理</option></Select></Field>
            <Field label="教师账号" error="账号已存在"><Input defaultValue="wang.teacher" /></Field>
            <Field label="规格说明" hint="最多 200 字"><Textarea placeholder="颜色 / 尺寸 / 材质" /></Field>
          </div>
        </Panel>

        <Panel flush>
          <div className="ui-panel-section is-tabs"><Tabs items={[{ id: "products", label: "商品库", count: 9 }, { id: "scenes", label: "场景库", count: 8 }, { id: "personas", label: "买家画像", count: 20 }]} value={tab} onChange={setTab} /></div>
          <div className="ui-panel-section">
            <Toolbar actions={<><Button icon={Download}>批量导入</Button><Button variant="primary" icon={Plus} onClick={() => setDrawer(true)}>新增商品</Button></>}>
              <span className="gallery-search"><Search size={14} /><Input placeholder="搜索商品名称" /></span>
              <Segmented items={[{ id: "pending", label: "在售", count: 2 }, { id: "all", label: "全部", count: 3 }, { id: "closed", label: "已下架", count: 1 }]} value={seg} onChange={setSeg} />
            </Toolbar>
          </div>
          <DataTable
            rows={products}
            rowKey={(row) => row.id}
            columns={[
              { key: "name", title: "商品", render: (row) => <>{row.name}<small>{row.spec}</small></> },
              { key: "price", title: "价格", align: "right", width: 120, render: (row) => row.price },
              { key: "stock", title: "库存", align: "right", width: 100, render: (row) => row.stock },
              { key: "status", title: "状态", width: 120, render: (row) => (row.stock === 0 ? <Status tone="warn">缺货</Status> : <Status tone="ok">正常</Status>) },
              { key: "sale", title: "在售", width: 80, render: (row) => <Switch checked={sale[row.id]!} label="在售" onChange={(next) => setSale((value) => ({ ...value, [row.id]: next }))} /> },
              {
                key: "ops", title: "操作", width: 120, render: () => (
                  <span className="ui-row-actions">
                    <Button variant="text" onClick={() => setDialog(true)}>编辑</Button>
                    <MoreMenu items={[{ label: "复制", onClick: () => toast.ok("已复制") }, { label: "删除", danger: true, onClick: () => setConfirm(true) }]} />
                  </span>
                ),
              },
            ]}
          />
        </Panel>

        <Panel title="标签与状态">
          <div className="gallery-row">
            <Tag>老客户</Tag><Tag tone="ok">已达标</Tag><Tag tone="warn">即将截止</Tag><Tag tone="danger">等待 2 分钟</Tag><Tag tone="accent">售后</Tag>
            <Status tone="ok">已启用</Status><Status tone="danger">已停用</Status><Status>未开始</Status>
          </div>
        </Panel>

        <Panel title="空状态与提示">
          <Empty action={<Button variant="text">去下发任务</Button>}>还没有进行中的会话</Empty>
          <div className="gallery-row">
            <Button onClick={() => toast.ok("已保存")}>成功提示</Button>
            <Button onClick={() => toast.error("保存失败：网络中断")}>失败提示</Button>
            <Button loading={false} onClick={() => setDialog(true)}>打开弹窗</Button>
          </div>
        </Panel>
      </div>

      {dialog ? (
        <Dialog title="编辑商品" onClose={() => setDialog(false)} footer={<><Button onClick={() => setDialog(false)}>取消</Button><Button variant="primary" onClick={() => setDialog(false)}>保存</Button></>}>
          <Field label="商品名称"><Input defaultValue="Wireless Noise-Cancelling Earbuds" /></Field>
          <Field label="价格"><Input defaultValue="39.99" /></Field>
        </Dialog>
      ) : null}
      {drawer ? (
        <Drawer title="新增商品" onClose={() => setDrawer(false)} footer={<><Button onClick={() => setDrawer(false)}>取消</Button><Button variant="primary" onClick={() => setDrawer(false)}>保存</Button></>}>
          <Field label="商品名称"><Input /></Field>
          <Field label="规格"><Textarea /></Field>
        </Drawer>
      ) : null}
      {confirm ? (
        <Confirm title="删除商品" danger confirmText="删除" onConfirm={() => { setConfirm(false); toast.ok("已删除"); }} onClose={() => setConfirm(false)}>
          删除后，学生端的商品页签和新订单里不再出现这个商品。已有订单不受影响。
        </Confirm>
      ) : null}
    </div>
  );
}
