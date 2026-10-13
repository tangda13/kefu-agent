import { Download, FileUp, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError, createClass, deleteClass, deleteStudent, fetchClassStudents, fetchClasses, renameClass, resetStudentPassword,
  setStudentGroup, setStudentStatus, updateStudent,
  type ClassStudent, type ClassSummary, type Session,
} from "../../api/client";
import { ImportStudentsDialog, PasswordNotice } from "../../components/AccountDialogs";
import {
  Bench, Board, Button, Confirm, DataTable, Dialog, Field, FilterChips, Flag, HeaderTabs, Input, MoreMenu, SearchBox, Select, Tag, toast,
} from "../../ui";

const errorText = (cause: unknown) => (cause instanceof ApiError ? cause.message : "无法连接服务器，请稍后重试。");
const NO_GROUP = "__none";
const ATTENTION = "__attention";
const DAY = 86_400_000;

/** 需要老师关注的学生：低于 60 分（红）、7 天以上没练或还没开始（橙）；已停用的不算 */
function attention(row: ClassStudent): { kind: "low" | "idle" | "never"; text: string } | null {
  if (row.status !== "active") return null;
  if (row.averageScore != null && row.averageScore < 60) return { kind: "low", text: "低于 60 分" };
  if (!row.lastActiveAt) return row.tasksTotal ? { kind: "never", text: row.mustChangePassword ? "还没登录" : "还没练过" } : null;
  const days = Math.floor((Date.now() - new Date(row.lastActiveAt).getTime()) / DAY);
  return days >= 7 ? { kind: "idle", text: `${days} 天没练` } : null;
}

/** 最近活跃：今天显示时间，7 天内显示“N 天前”，更早显示日期 */
function activeText(iso: string | null): string {
  if (!iso) return "还没练过";
  const date = new Date(iso);
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days < 1 && new Date().getDate() === date.getDate()) return `今天 ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (days < 7) return `${Math.max(days, 1)} 天前`;
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

export function LiveClasses({ session }: { session: Session }) {
  const [classes, setClasses] = useState<ClassSummary[]>([]);
  const [classId, setClassId] = useState("");
  const [students, setStudents] = useState<ClassStudent[]>([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState("");
  const [group, setGroup] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [dialog, setDialog] = useState<
    | { kind: "newClass" | "rename" | "deleteClass" | "import" | "group" }
    | { kind: "edit" | "reset" | "disable" | "remove"; student: ClassStudent }
    | null
  >(null);
  const [passwords, setPasswords] = useState<{ title: string; rows: Array<{ name: string; account: string; password: string }> } | null>(null);

  const loadClasses = useCallback(async () => {
    try {
      const list = await fetchClasses(session);
      setClasses(list);
      setClassId((current) => (list.some((item) => item.id === current) ? current : list[0]?.id ?? ""));
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }, [session]);
  const loadStudents = useCallback(async () => {
    if (!classId) {
      setStudents([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setStudents(await fetchClassStudents(session, classId));
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setLoading(false);
    }
  }, [session, classId]);
  useEffect(() => { void loadClasses(); }, [loadClasses]);
  useEffect(() => { void loadStudents(); setSelected([]); setGroup(""); }, [loadStudents]);

  const current = classes.find((item) => item.id === classId) ?? null;
  const groups = useMemo(() => [...new Set(students.map((row) => row.groupName).filter(Boolean) as string[])].sort(), [students]);
  const visible = useMemo(() => {
    const word = keyword.trim().toLowerCase();
    return students.filter((row) => {
      if (group === NO_GROUP && row.groupName) return false;
      if (group === ATTENTION && !attention(row)) return false;
      if (group && group !== NO_GROUP && group !== ATTENTION && row.groupName !== group) return false;
      return !word || `${row.displayName} ${row.username}`.toLowerCase().includes(word);
    });
  }, [students, keyword, group]);
  const allChecked = visible.length > 0 && visible.every((row) => selected.includes(row.id));
  const scored = students.filter((row) => row.averageScore != null);
  const classAverage = scored.length ? Math.round(scored.reduce((sum, row) => sum + row.averageScore!, 0) / scored.length) : null;
  const weekActive = students.filter((row) => row.lastActiveAt && Date.now() - new Date(row.lastActiveAt).getTime() < 7 * DAY).length;
  const idleCount = students.filter((row) => attention(row)?.kind === "idle").length;

  async function run(action: () => Promise<unknown>, message: string, reloadClasses = false) {
    try {
      await action();
      toast.ok(message);
      setDialog(null);
      if (reloadClasses) await loadClasses();
      await loadStudents();
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }

  async function resetPassword(student: ClassStudent) {
    try {
      const { temporaryPassword } = await resetStudentPassword(session, student.id);
      setDialog(null);
      setPasswords({ title: "密码已重置", rows: [{ name: student.displayName, account: student.username, password: temporaryPassword }] });
      await loadStudents();
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }

  function exportRoster() {
    if (!current) return;
    const header = "学号,姓名,分组,完成任务,参训任务,平均分,最近活跃,状态\n";
    const body = students.map((row) => [
      row.username, row.displayName, row.groupName ?? "", row.tasksDone, row.tasksTotal, row.averageScore ?? "",
      row.lastActiveAt ? new Date(row.lastActiveAt).toLocaleString("zh-CN") : "", row.status === "active" ? "正常" : "已停用",
    ].join(",")).join("\n");
    const blob = new Blob(["﻿" + header + body], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${current.name}-名单.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  const classMenu = (
    <MoreMenu
      label="班级操作"
      items={[
        { label: "新建班级", onClick: () => setDialog({ kind: "newClass" }) },
        { label: "重命名班级", disabled: !current, onClick: () => setDialog({ kind: "rename" }) },
        { label: "删除班级", danger: true, disabled: !current, onClick: () => setDialog({ kind: "deleteClass" }) },
      ]}
    />
  );

  return (
    <>
      {classes.length > 0 && classes.length <= 6 ? (
        <HeaderTabs items={classes.map((item) => ({ id: item.id, label: item.name, count: item.studentCount }))} value={classId} onChange={setClassId} />
      ) : null}
      <Bench>
        {classes.length === 0 ? (
          <Board><p className="board-quiet">还没有班级。新建一个班级，再把学生名单导进来。 <Button variant="primary" icon={Plus} onClick={() => setDialog({ kind: "newClass" })}>新建班级</Button></p></Board>
        ) : (
          <>
            <Board>
              <div className="classbar">
                <div className="k"><small>学生</small><b>{students.length}</b></div>
                <span className="sep" />
                <div className="k"><small>本周练过</small><b>{weekActive}</b></div>
                <span className="sep" />
                <div className="k"><small>平均分</small><b className={classAverage == null ? "is-dash" : undefined}>{classAverage ?? "—"}</b></div>
                <span className="sep" />
                <div className="k"><small>7 天以上没练</small><b className={idleCount ? "is-warn" : undefined}>{idleCount}</b></div>
                <div className="end">
                  {classes.length > 6 ? (
                    <Select className="toolbar-select" value={classId} onChange={(event) => setClassId(event.target.value)}>
                      {classes.map((item) => <option key={item.id} value={item.id}>{item.name}（{item.studentCount} 人）</option>)}
                    </Select>
                  ) : null}
                  <Button variant="ghost" icon={Download} disabled={students.length === 0} onClick={exportRoster}>导出名单</Button>
                  <Button icon={FileUp} onClick={() => setDialog({ kind: "import" })}>导入学生</Button>
                  {classMenu}
                </div>
              </div>
            </Board>
            {selected.length > 0 ? (
              <div className="selection-bar">
                <strong>已选 {selected.length} 人</strong>
                <Button size="sm" onClick={() => setDialog({ kind: "group" })}>分到组…</Button>
                <Button size="sm" variant="ghost" onClick={() => void run(() => setStudentGroup(session, classId, selected, null), "已移出分组").then(() => setSelected([]))}>移出分组</Button>
                <Button size="sm" variant="ghost" onClick={() => setSelected([])}>取消选择</Button>
              </div>
            ) : (
              <div className="bench-bar">
                <SearchBox value={keyword} onChange={setKeyword} placeholder="搜索姓名或学号" />
                <FilterChips
                  items={[
                    { id: "", label: "全部", count: students.length },
                    ...groups.map((name) => ({ id: name, label: name, count: students.filter((row) => row.groupName === name).length })),
                    ...(groups.length ? [{ id: NO_GROUP, label: "未分组", count: students.filter((row) => !row.groupName).length }] : []),
                    { id: ATTENTION, label: "需要关注", count: students.filter((row) => attention(row)).length },
                  ]}
                  value={group}
                  onChange={setGroup}
                />
              </div>
            )}
            <Board>
              <DataTable
                loading={loading}
                rows={visible}
                rowKey={(row) => row.id}
                empty={keyword || group ? "没有符合条件的学生" : <>这个班还没有学生。<Button variant="text" onClick={() => setDialog({ kind: "import" })}>导入名单</Button></>}
                columns={[
                  {
                    key: "check", width: 36,
                    title: <input type="checkbox" aria-label="全选" checked={allChecked} onChange={() => setSelected(allChecked ? [] : visible.map((row) => row.id))} />,
                    render: (row) => (
                      <input
                        type="checkbox" aria-label={`选择 ${row.displayName}`} checked={selected.includes(row.id)}
                        onChange={() => setSelected((list) => (list.includes(row.id) ? list.filter((id) => id !== row.id) : [...list, row.id]))}
                      />
                    ),
                  },
                  {
                    key: "name", title: "学生",
                    render: (row) => (
                      <span className={row.status === "active" ? undefined : "is-muted-cell"}>
                        <span className="cell-title">{row.displayName}{row.status !== "active" ? <Tag>已停用</Tag> : null}</span>
                        <span className="cell-meta">{row.username}</span>
                      </span>
                    ),
                  },
                  { key: "group", title: "分组", width: 110, render: (row) => (row.groupName ? <Flag tone="plain">{row.groupName}</Flag> : <span className="faint">—</span>) },
                  {
                    key: "tasks", title: "完成任务", width: 160,
                    render: (row) => (row.tasksTotal
                      ? <span className="cell-bar"><span><i style={{ width: `${(row.tasksDone / row.tasksTotal) * 100}%` }} /></span>{row.tasksDone} / {row.tasksTotal}</span>
                      : <span className="faint">还没有任务</span>),
                  },
                  { key: "score", title: "平均分", width: 80, align: "right", render: (row) => (row.averageScore == null ? <span className="faint">—</span> : <span className={row.averageScore < 60 ? "strong-num is-bad" : "strong-num"}>{row.averageScore}</span>) },
                  {
                    key: "active", title: "最近练习", width: 130,
                    render: (row) => {
                      const flag = attention(row);
                      if (!flag) return <span>{activeText(row.lastActiveAt)}</span>;
                      return <Flag tone={flag.kind === "low" ? "bad" : "warn"}>{flag.text}</Flag>;
                    },
                  },
                  {
                    key: "ops", title: "", width: 48, align: "right",
                    render: (row) => (
                      <MoreMenu items={[
                        { label: "编辑 / 转班", onClick: () => setDialog({ kind: "edit", student: row }) },
                        { label: "重置密码", onClick: () => setDialog({ kind: "reset", student: row }) },
                        row.status === "active"
                          ? { label: "停用账号", onClick: () => setDialog({ kind: "disable", student: row }) }
                          : { label: "恢复账号", onClick: () => void run(() => setStudentStatus(session, row.id, "active"), `${row.displayName} 已恢复`) },
                        { label: "删除", danger: true, onClick: () => setDialog({ kind: "remove", student: row }) },
                      ]} />
                    ),
                  },
                ]}
              />
            </Board>
          </>
        )}
      </Bench>

      {dialog?.kind === "newClass" ? (
        <NameDialog title="新建班级" label="班级名称" placeholder="例如：跨境电商2602班" confirmText="新建" onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            try {
              const created = await createClass(session, name);
              toast.ok(`已新建「${created.name}」，接着导入学生名单`);
              setDialog(null);
              await loadClasses();
              setClassId(created.id);
            } catch (cause) {
              toast.error(errorText(cause));
            }
          }}
        />
      ) : null}
      {dialog?.kind === "rename" && current ? (
        <NameDialog title="重命名班级" label="班级名称" initial={current.name} confirmText="保存" onClose={() => setDialog(null)}
          onSubmit={(name) => run(() => renameClass(session, current.id, name), "已重命名", true)} />
      ) : null}
      {dialog?.kind === "deleteClass" && current ? (
        students.length > 0 ? (
          <Confirm title="不能删除" confirmText="知道了" onConfirm={() => setDialog(null)} onClose={() => setDialog(null)}>
            「{current.name}」还有 {students.length} 名学生。先把学生转到别的班或删除，才能删除班级。
          </Confirm>
        ) : (
          <Confirm title="删除班级" danger confirmText="删除" onConfirm={() => void run(() => deleteClass(session, current.id), `已删除「${current.name}」`, true)} onClose={() => setDialog(null)}>
            确定删除「{current.name}」吗？
          </Confirm>
        )
      ) : null}
      {dialog?.kind === "import" && current ? (
        <ImportStudentsDialog session={session} classId={current.id} className={current.name} onClose={() => setDialog(null)}
          onImported={() => { void loadClasses(); void loadStudents(); }} />
      ) : null}
      {dialog?.kind === "group" ? (
        <NameDialog
          title={`把 ${selected.length} 人分到组`}
          label="组名"
          hint={groups.length ? `已有：${groups.join("、")}。输入已有组名就是加入，输入新名字就是建新组。` : "例如：第一组。之后可以按组筛选、导出。"}
          suggestions={groups}
          confirmText="确定"
          onClose={() => setDialog(null)}
          onSubmit={(name) => run(() => setStudentGroup(session, classId, selected, name), `已分到「${name}」`).then(() => setSelected([]))}
        />
      ) : null}
      {dialog?.kind === "edit" ? (
        <EditStudentDialog student={dialog.student} classes={classes} classId={classId} onClose={() => setDialog(null)}
          onSubmit={(patch, message) => run(() => updateStudent(session, dialog.student.id, patch), message, Boolean(patch.classId))} />
      ) : null}
      {dialog?.kind === "reset" ? (
        <Confirm title="重置密码" confirmText="重置" onConfirm={() => void resetPassword(dialog.student)} onClose={() => setDialog(null)}>
          重置 {dialog.student.displayName}（{dialog.student.username}）的密码后，原密码立即失效。
        </Confirm>
      ) : null}
      {dialog?.kind === "disable" ? (
        <Confirm title="停用账号" danger confirmText="停用" onConfirm={() => void run(() => setStudentStatus(session, dialog.student.id, "disabled"), `${dialog.student.displayName} 已停用`)} onClose={() => setDialog(null)}>
          停用后 {dialog.student.displayName} 不能登录，练习记录和成绩都保留，之后可以恢复。
        </Confirm>
      ) : null}
      {dialog?.kind === "remove" ? (
        <Confirm title="删除学生" danger confirmText="删除" onConfirm={() => void run(() => deleteStudent(session, dialog.student.id), `已删除 ${dialog.student.displayName}`, true)} onClose={() => setDialog(null)}>
          只有还没练过的账号能删除，删除后不能恢复。已经有记录的学生请用「停用账号」。
        </Confirm>
      ) : null}
      {passwords ? <PasswordNotice title={passwords.title} rows={passwords.rows} onClose={() => setPasswords(null)} /> : null}
    </>
  );
}

function NameDialog({ title, label, hint, placeholder, initial = "", suggestions, confirmText, onClose, onSubmit }: {
  title: string; label: string; hint?: string; placeholder?: string; initial?: string; suggestions?: string[]; confirmText: string;
  onClose: () => void; onSubmit: (name: string) => Promise<unknown> | void;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!value.trim()) return;
    setBusy(true);
    try {
      await onSubmit(value.trim());
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" loading={busy} disabled={!value.trim()} onClick={() => void submit()}>{confirmText}</Button></>}
    >
      <Field label={label} hint={hint}>
        <Input autoFocus value={value} placeholder={placeholder} list={suggestions?.length ? "name-dialog-options" : undefined}
          onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void submit(); }} />
      </Field>
      {suggestions?.length ? <datalist id="name-dialog-options">{suggestions.map((item) => <option key={item} value={item} />)}</datalist> : null}
    </Dialog>
  );
}

function EditStudentDialog({ student, classes, classId, onClose, onSubmit }: {
  student: ClassStudent; classes: ClassSummary[]; classId: string; onClose: () => void;
  onSubmit: (patch: { displayName?: string; classId?: string }, message: string) => Promise<unknown>;
}) {
  const [name, setName] = useState(student.displayName);
  const [target, setTarget] = useState(classId);
  const [busy, setBusy] = useState(false);
  async function submit() {
    const patch: { displayName?: string; classId?: string } = {};
    if (name.trim() && name.trim() !== student.displayName) patch.displayName = name.trim();
    if (target !== classId) patch.classId = target;
    if (!patch.displayName && !patch.classId) return onClose();
    setBusy(true);
    const moved = classes.find((item) => item.id === patch.classId);
    await onSubmit(patch, moved ? `${name.trim()} 已转到「${moved.name}」` : "已保存");
    setBusy(false);
  }
  return (
    <Dialog
      title={`编辑 · ${student.username}`}
      onClose={onClose}
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" loading={busy} onClick={() => void submit()}>保存</Button></>}
    >
      <div className="form-stack">
        <Field label="姓名"><Input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></Field>
        <Field label="所在班级" hint="转班后会自动收到新班级已下发的任务，原来的分组会清空">
          <Select value={target} onChange={(event) => setTarget(event.target.value)}>
            {classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </Select>
        </Field>
      </div>
    </Dialog>
  );
}
