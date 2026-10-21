import { Download, FileUp, Pencil, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import {
  ApiError, createClass, deleteClass, deleteStudent, fetchClassStudents, fetchClasses, fetchStudentTaskList, renameClass, resetStudentPassword,
  setStudentGroup, setStudentStatus, updateStudent,
  type ClassStudent, type ClassSummary, type Session, type StudentTaskItem,
} from "../../api/client";
import { ImportStudentsDialog, PasswordNotice } from "../../components/AccountDialogs";
import {
  Bench, Board, Button, Confirm, DataTable, Dialog, Drawer, Field, FilterChips, Flag, HeaderTabs, Input, MoreMenu, SearchBox, Select, StageTag, Tag, toast,
} from "../../ui";
import { openReplayFor } from "./widgets";

const errorText = (cause: unknown) => (cause instanceof ApiError ? cause.message : "无法连接服务器，请稍后重试。");
const NO_GROUP = "__none";
const PENDING = "__pending";
const DISABLED = "__disabled";
const AVATAR_TONES = [1, 2, 3, 4, 5];

/** 账号状态（D-35：名单只管名单；练习数据在学生详情和导出里，D-63） */
function accountState(row: ClassStudent): "ok" | "pending" | "disabled" {
  if (row.status !== "active") return "disabled";
  return row.mustChangePassword ? "pending" : "ok";
}
const ACCOUNT_LABELS = { ok: "正常", pending: "待改密", disabled: "已停用" } as const;
const joinedText = (iso: string) => new Date(iso).toLocaleDateString("zh-CN", { year: new Date(iso).getFullYear() === new Date().getFullYear() ? undefined : "numeric", month: "long", day: "numeric" });
/**
 * 活跃状态（参数 2.2.3，D-63）：按最近一次接待算，含自由练习（服务类指标，D-61）。
 * 名单上不显示（D-35），在学生详情和导出里看
 */
export function activityOf(row: ClassStudent): { text: string; tone: "ok" | "warn" | ""; lastText: string; shortText: string } {
  if (!row.lastActiveAt) {
    const never = row.mustChangePassword;
    const text = never ? "从没登录过" : "还没练过";
    return { text, tone: never ? "warn" : "", lastText: text, shortText: text };
  }
  const last = new Date(row.lastActiveAt);
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(last).setHours(0, 0, 0, 0)) / 86_400_000);
  const lastText = last.toLocaleString("zh-CN", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const shortText = last.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  if (days <= 0) return { text: "今天练过", tone: "ok", lastText, shortText };
  if (days < 7) return { text: `${days} 天前`, tone: "", lastText, shortText };
  return { text: `${days} 天没练`, tone: "warn", lastText, shortText };
}

const toneOf = (text: string) => AVATAR_TONES[[...text].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % AVATAR_TONES.length]!;

/** 参训任务一行的状态：老师看的是这个学生做到哪了 */
function taskProgressText(item: StudentTaskItem): { text: string; tone: "ok" | "warn" | "" } {
  if (item.progress === "done") return { text: "已完成", tone: "ok" };
  if (item.taskStatus === "closed") return { text: "没完成", tone: "warn" };
  if (item.startAt && new Date(item.startAt).getTime() > Date.now()) {
    return { text: `${new Date(item.startAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })} 开放`, tone: "" };
  }
  return { text: item.progress === "in_progress" ? "进行中" : "还没开始", tone: "" };
}

/**
 * 学生详情（参数 2.2.3，D-63，设计稿 docs/design/p17-params-teacher 第八节）：名单只管名单（D-35），
 * 参训任务数、平均分、活跃状态点开学生看；样式和任务详情一样，分组之间一条分隔线、组内不画线
 */
function StudentDetail({ session, student, className, onClose, onReset, onEdit, onNavigate }: {
  session: Session; student: ClassStudent; className: string;
  onClose: () => void; onReset: () => void; onEdit: () => void; onNavigate?: (page: string) => void;
}) {
  const [tasks, setTasks] = useState<StudentTaskItem[] | null>(null);
  useEffect(() => {
    fetchStudentTaskList(session, student.id).then(setTasks).catch(() => setTasks([]));
  }, [session, student.id]);
  const tone = toneOf(student.displayName);
  const activity = activityOf(student);
  const scored = (tasks ?? []).filter((item) => item.score != null).length;
  const state = accountState(student);
  const percent = student.tasksTotal ? Math.round((student.tasksDone / student.tasksTotal) * 100) : 0;
  const replay = () => { openReplayFor(student.displayName); onNavigate?.("tracking"); };
  return (
    <Drawer
      title={student.displayName}
      width={480}
      onClose={onClose}
      footer={<><Button onClick={onReset}>重置密码</Button><Button onClick={onEdit}>编辑 / 转班</Button></>}
    >
      <div className="tdv">
        <div className="sdv-who">
          <span className="cls-av" style={{ background: `var(--c-cat-${tone}-soft)`, color: `var(--c-cat-${tone})` }}>{student.displayName.slice(0, 1)}</span>
          <span><b>{student.username}</b><small>{className}</small></span>
          <span className="sdv-tags">
            {student.groupName ? <Flag tone="plain">{student.groupName}</Flag> : <span className="faint">未分组</span>}
            <span className={`cls-acc is-${state}`}><i />{ACCOUNT_LABELS[state]}</span>
          </span>
        </div>
        <div className="sdv-figs">
          <div>
            <small>参训任务</small>
            <b>{student.tasksDone}<em>/ {student.tasksTotal}</em></b>
            <span className="tdv-bar"><i style={{ width: `${percent}%` }} /></span>
          </div>
          <div>
            <small>平均分</small>
            <b className={student.averageScore == null ? "is-na" : student.averageScore < 60 ? "is-bad" : undefined}>{student.averageScore ?? "—"}</b>
            {scored ? <span className="sdv-sub">{scored} 个任务有成绩</span> : null}
          </div>
          <div>
            <small>活跃状态</small>
            <b className={`is-act${activity.tone ? ` is-${activity.tone}` : ""}`}>{activity.text}</b>
            {student.lastActiveAt ? <span className="sdv-sub">{activity.shortText} 最近练习</span> : null}
          </div>
        </div>
        <section className="tdv-sec">
          <h5>参训任务 {tasks?.length ?? ""}</h5>
          {tasks === null ? <p className="board-quiet">正在读取…</p> : tasks.length === 0 ? <p className="faint">还没有下发给这个学生的任务</p> : tasks.map((item) => {
            const progress = taskProgressText(item);
            return (
              <div key={item.id} className="sdv-task">
                <span className="sdv-task-name"><b>{item.name}</b><StageTag stage={item.businessStage} /></span>
                <span className={progress.tone ? `sdv-state is-${progress.tone}` : "sdv-state"}>{progress.text}</span>
                <span className={item.score == null ? "sdv-score is-na" : item.score < 60 ? "sdv-score is-bad" : "sdv-score"}>{item.score ?? "—"}</span>
                {item.conversations ? <button type="button" className="board-link" onClick={replay}>回放 ›</button> : <span className="faint sdv-noreplay">回放 ›</span>}
              </div>
            );
          })}
        </section>
        <section className="tdv-sec">
          <h5>账号</h5>
          <dl className="tdv-kv">
            <dt>加入时间</dt><dd>{new Date(student.createdAt).toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" })}</dd>
            <dt>账号状态</dt><dd>{ACCOUNT_LABELS[state]}</dd>
            <dt>分组</dt><dd>{student.groupName ?? "未分组"}</dd>
          </dl>
        </section>
      </div>
    </Drawer>
  );
}

export function LiveClasses({ session, onNavigate }: { session: Session; onNavigate?: (page: string) => void }) {
  const [classes, setClasses] = useState<ClassSummary[]>([]);
  const [classId, setClassId] = useState("");
  const [students, setStudents] = useState<ClassStudent[]>([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState("");
  const [group, setGroup] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [viewing, setViewing] = useState<ClassStudent | null>(null);
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
      if (group === PENDING && accountState(row) !== "pending") return false;
      if (group === DISABLED && accountState(row) !== "disabled") return false;
      if (group && group !== NO_GROUP && group !== PENDING && group !== DISABLED && row.groupName !== group) return false;
      return !word || `${row.displayName} ${row.username}`.toLowerCase().includes(word);
    });
  }, [students, keyword, group]);
  const allChecked = visible.length > 0 && visible.every((row) => selected.includes(row.id));
  const pendingCount = students.filter((row) => accountState(row) === "pending").length;
  const disabledCount = students.filter((row) => accountState(row) === "disabled").length;
  const myRole = (item: ClassSummary) => (item.headTeacherId === session.user.id ? "班主任" : "任课");

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

  /* 导出名单（D-63）：Excel，带参训任务、平均分、最近练习，和考核报表的导出一致 */
  function exportRoster() {
    if (!current) return;
    const rows = students.map((row) => ({
      学号: row.username,
      姓名: row.displayName,
      分组: row.groupName ?? "—",
      账号状态: ACCOUNT_LABELS[accountState(row)],
      参训任务: `${row.tasksDone} / ${row.tasksTotal}`,
      平均分: row.averageScore ?? "—",
      最近练习: activityOf(row).lastText,
      加入时间: new Date(row.createdAt).toLocaleDateString("zh-CN"),
    }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), "名单");
    XLSX.writeFile(workbook, `${current.name}-名单-${new Date().toLocaleDateString("zh-CN").replace(/\//g, "-")}.xlsx`);
  }

  const classMenu = (
    <MoreMenu
      label="班级操作"
      items={[
        { label: "新建班级", onClick: () => setDialog({ kind: "newClass" }) },
        { label: "删除班级", danger: true, disabled: !current, onClick: () => setDialog({ kind: "deleteClass" }) },
      ]}
    />
  );

  return (
    <>
      <Bench>
        {classes.length === 0 ? (
          <Board><p className="board-quiet">还没有班级。新建一个班级，再把学生名单导进来。 <Button variant="primary" icon={Plus} onClick={() => setDialog({ kind: "newClass" })}>新建班级</Button></p></Board>
        ) : (
          <div className="cls">
            <aside className="cls-list">
              <h6>我的班级<span>{classes.length}</span></h6>
              {classes.map((item) => (
                <button key={item.id} type="button" className={item.id === classId ? "cls-item is-on" : "cls-item"} onClick={() => setClassId(item.id)}>
                  <b>{item.name}</b>
                  <small>{item.studentCount} 名学生 · {myRole(item)}</small>
                  {item.pendingPasswordCount ? <em title="待改密的账号">{item.pendingPasswordCount}</em> : null}
                </button>
              ))}
              <button type="button" className="cls-add" onClick={() => setDialog({ kind: "newClass" })}><Plus size={14} />新建班级</button>
            </aside>

            <div className="cls-main">
              <header className="cls-head">
                <div>
                  <h2>{current?.name}<button type="button" title="重命名班级" onClick={() => setDialog({ kind: "rename" })}><Pencil size={15} /></button></h2>
                  <p className="cls-facts">
                    <span>班主任 {current?.headTeacherName ?? "未设置"}{current?.teachers.length ? ` · 任课 ${current.teachers.map((item) => item.displayName).join("、")}` : ""}</span>
                    <i className="cls-sep" />
                    <span><b>{students.length}</b> 名学生 · <b>{groups.length}</b> 个分组</span>
                    {pendingCount ? <><i className="cls-sep" /><span className="is-warn">{pendingCount} 个账号待改密</span></> : null}
                    {disabledCount ? <><i className="cls-sep" /><span>{disabledCount} 个已停用</span></> : null}
                  </p>
                </div>
                <div className="cls-actions">
                  <Button variant="ghost" icon={Download} disabled={students.length === 0} onClick={exportRoster}>导出名单</Button>
                  <Button icon={FileUp} onClick={() => setDialog({ kind: "import" })}>导入学生</Button>
                  {classMenu}
                </div>
              </header>

              <section className="cls-roster">
                <div className="cls-tools">
                  <SearchBox value={keyword} onChange={setKeyword} placeholder="搜索姓名或学号" />
                  <FilterChips
                    items={[
                      { id: "", label: "全部", count: students.length },
                      ...groups.map((name) => ({ id: name, label: name, count: students.filter((row) => row.groupName === name).length })),
                      ...(groups.length ? [{ id: NO_GROUP, label: "未分组", count: students.filter((row) => !row.groupName).length }] : []),
                      ...(pendingCount ? [{ id: PENDING, label: "待改密", count: pendingCount }] : []),
                      ...(disabledCount ? [{ id: DISABLED, label: "已停用", count: disabledCount }] : []),
                    ]}
                    value={group}
                    onChange={setGroup}
                  />
                </div>
                {selected.length > 0 ? (
                  <div className="cls-batch">
                    <strong>已选 {selected.length} 人</strong>
                    <Button size="sm" onClick={() => setDialog({ kind: "group" })}>分到组…</Button>
                    <Button size="sm" variant="ghost" onClick={() => void run(() => setStudentGroup(session, classId, selected, null), "已移出分组").then(() => setSelected([]))}>移出分组</Button>
                    <Button size="sm" variant="ghost" onClick={() => setSelected([])}>取消选择</Button>
                  </div>
                ) : null}
                <div className="cls-row is-head">
                  <input type="checkbox" aria-label="全选" checked={allChecked} onChange={() => setSelected(allChecked ? [] : visible.map((row) => row.id))} />
                  <span /><span>学生</span><span>分组</span><span>账号状态</span><span>加入时间</span><span />
                </div>
                {loading ? <p className="board-quiet">正在读取…</p> : visible.length === 0 ? (
                  <p className="board-quiet">{keyword || group ? "没有符合条件的学生" : <>这个班还没有学生。<Button variant="text" onClick={() => setDialog({ kind: "import" })}>导入名单</Button></>}</p>
                ) : visible.map((row) => {
                  const state = accountState(row);
                  const tone = toneOf(row.displayName);
                  const checked = selected.includes(row.id);
                  return (
                    <div key={row.id} className={["cls-row is-click", checked ? "is-sel" : "", state === "disabled" ? "is-off" : ""].filter(Boolean).join(" ")}
                      role="button" tabIndex={0} onClick={() => setViewing(row)} onKeyDown={(event) => { if (event.key === "Enter") setViewing(row); }}>
                      <input type="checkbox" aria-label={`选择 ${row.displayName}`} checked={checked} onClick={(event) => event.stopPropagation()}
                        onChange={() => setSelected((list) => (list.includes(row.id) ? list.filter((id) => id !== row.id) : [...list, row.id]))} />
                      <span className="cls-av" style={{ background: `var(--c-cat-${tone}-soft)`, color: `var(--c-cat-${tone})` }}>{row.displayName.slice(0, 1)}</span>
                      <span className="cls-name"><b>{row.displayName}</b><small>{row.username}</small></span>
                      <span>{row.groupName ? <Flag tone="plain">{row.groupName}</Flag> : <span className="faint">未分组</span>}</span>
                      <span className={`cls-acc is-${state}`}><i />{ACCOUNT_LABELS[state]}</span>
                      <span className="cls-time">{joinedText(row.createdAt)}</span>
                      <span onClick={(event) => event.stopPropagation()}><MoreMenu items={[
                        { label: "编辑 / 转班", onClick: () => setDialog({ kind: "edit", student: row }) },
                        { label: "重置密码", onClick: () => setDialog({ kind: "reset", student: row }) },
                        row.status === "active"
                          ? { label: "停用账号", onClick: () => setDialog({ kind: "disable", student: row }) }
                          : { label: "恢复账号", onClick: () => void run(() => setStudentStatus(session, row.id, "active"), `${row.displayName} 已恢复`) },
                        { label: "删除", danger: true, onClick: () => setDialog({ kind: "remove", student: row }) },
                      ]} /></span>
                    </div>
                  );
                })}
              </section>
            </div>
          </div>
        )}
      </Bench>

      {viewing ? (
        <StudentDetail
          session={session}
          student={viewing}
          className={current?.name ?? ""}
          onClose={() => setViewing(null)}
          onReset={() => { setDialog({ kind: "reset", student: viewing }); setViewing(null); }}
          onEdit={() => { setDialog({ kind: "edit", student: viewing }); setViewing(null); }}
          onNavigate={onNavigate}
        />
      ) : null}

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
