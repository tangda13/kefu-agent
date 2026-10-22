import { useState, type ReactNode } from "react";
import { ApiError, importStudents, type ImportResult, type Session } from "../api/client";
import { Button, DataTable, Dialog, Field, Input, Select, Textarea, toast } from "../ui";

/* 管理端和教师端共用的账号弹窗：一次性密码展示、批量导入学生、删除学生 / 班级 / 教师 */

const errorOf = (cause: unknown) => (cause instanceof ApiError ? cause.message : "无法连接服务器，请稍后重试");

/**
 * 删除学生 / 班级（D-86）：先按普通删除试；服务端说还有记录（STUDENT_HAS_DATA / CLASS_NOT_EMPTY，带数量）
 * 就改成输入学号 / 班级名确认，连记录一起删，删之前服务端自动备份。
 * 已经知道有记录的（班里有学生）传 known，直接从输入确认这一步开始。
 */
export function DeleteRecordsDialog({ title, name, nameLabel, intro, known, warn, onDelete, onDone, onClose }: {
  title: string;
  /** 要输入的学号 / 班级名 */
  name: string;
  nameLabel: string;
  /** 没有记录时的确认文字 */
  intro: ReactNode;
  known?: Record<string, unknown>;
  /** 有记录时说清楚会一起删掉什么，counts 是服务端 409 带回的数量 */
  warn: (counts: Record<string, unknown>) => string;
  onDelete: (confirm?: string) => Promise<unknown>;
  onDone: () => void;
  onClose: () => void;
}) {
  const [counts, setCounts] = useState<Record<string, unknown> | null>(known ?? null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const matched = typed.trim().toLowerCase() === name.trim().toLowerCase();

  async function submit() {
    setBusy(true);
    try {
      await onDelete(counts ? typed.trim() : undefined);
      onDone();
    } catch (cause) {
      if (!counts && cause instanceof ApiError && (cause.code === "STUDENT_HAS_DATA" || cause.code === "CLASS_NOT_EMPTY")) setCounts(cause.body);
      else toast.error(errorOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="danger" loading={busy} disabled={Boolean(counts) && !matched} onClick={() => void submit()}>{counts ? "连记录一起删除" : "删除"}</Button>
        </>
      }
    >
      {counts ? (
        <>
          <p>{warn(counts)}删除后不能恢复，删之前系统会自动备份一次。</p>
          <Field label={`输入${nameLabel}「${name}」确认`}>
            <Input autoFocus value={typed} onChange={(event) => setTyped(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && matched && !busy) void submit(); }} />
          </Field>
        </>
      ) : intro}
    </Dialog>
  );
}

/**
 * 删除教师（D-87，仅管理端）：名下没有班级、任务、公告的直接删；有的话选一位启用的教师接手，
 * 班主任、任课授权、任务、公告、复核记录都转给接手人，再删账号。
 */
export function DeleteTeacherDialog({ teacher, teachers, onDelete, onDone, onClose }: {
  teacher: { id: string; displayName: string; username: string; classCount: number };
  teachers: Array<{ id: string; displayName: string; username: string; status: string }>;
  onDelete: (successorId?: string) => Promise<unknown>;
  onDone: () => void;
  onClose: () => void;
}) {
  const candidates = teachers.filter((item) => item.id !== teacher.id && item.status === "active");
  const [work, setWork] = useState<string>(teacher.classCount ? `名下有 ${teacher.classCount} 个班级` : "");
  const [successorId, setSuccessorId] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await onDelete(work ? successorId : undefined);
      onDone();
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "TEACHER_HAS_WORK") {
        const { classes = 0, tasks = 0, notices = 0 } = cause.body as { classes?: number; tasks?: number; notices?: number };
        const parts = [classes ? `${classes} 个班级` : "", tasks ? `${tasks} 个任务` : "", notices ? `${notices} 条公告` : ""].filter(Boolean);
        setWork(`名下有 ${parts.join("、")}`);
      } else toast.error(errorOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title="删除教师"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="danger" loading={busy} disabled={Boolean(work) && !successorId} onClick={() => void submit()}>{work ? "转交并删除" : "删除"}</Button>
        </>
      }
    >
      {work ? (
        <>
          <p>{teacher.displayName}（{teacher.username}）{work}，删除前要交给另一位教师。班主任、任课班级、建的任务、发的公告、复核记录都会转过去。</p>
          {candidates.length ? (
            <Field label="接手教师">
              <Select value={successorId} onChange={(event) => setSuccessorId(event.target.value)}>
                <option value="">请选择</option>
                {candidates.map((item) => <option key={item.id} value={item.id}>{item.displayName}（{item.username}）</option>)}
              </Select>
            </Field>
          ) : <p className="ui-field-error">没有其他启用的教师，先新增一位教师再删除。</p>}
        </>
      ) : (
        <p>确定删除 {teacher.displayName}（{teacher.username}）吗？删除后不能恢复。只是暂时不用的话，可以改为停用。</p>
      )}
    </Dialog>
  );
}

export function PasswordNotice({ title, rows, onClose }: { title: string; rows: Array<{ name: string; account: string; password: string }>; onClose: () => void }) {
  const text = rows.map((row) => `${row.name}\t${row.account}\t${row.password}`).join("\n");
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={() => void navigator.clipboard.writeText(text).then(() => toast.ok("已复制"))}>复制</Button>
          <Button variant="primary" onClick={onClose}>我已记下</Button>
        </>
      }
    >
      <p className="muted">密码只显示这一次，关闭后无法再查看。对方首次登录时需要改成自己的密码。</p>
      <DataTable
        rows={rows}
        rowKey={(row) => row.account}
        columns={[
          { key: "name", title: "姓名", render: (row) => row.name },
          { key: "account", title: "账号", render: (row) => row.account },
          { key: "password", title: "密码", render: (row) => <code className="mono-strong">{row.password}</code> },
        ]}
      />
    </Dialog>
  );
}

export function ImportStudentsDialog({ session, classId, className, onClose, onImported }: {
  session: Session; classId: string; className: string; onClose: () => void; onImported: () => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  async function submit() {
    const rows = text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
      const [username = "", displayName = "", password = ""] = line.split(/[,，\t]/).map((part) => part.trim());
      return password ? { username, displayName, password } : { username, displayName };
    });
    if (rows.length === 0) return setError("每行一个学生：学号,姓名 或 学号,姓名,初始密码");
    setBusy(true);
    setError("");
    try {
      setResult(await importStudents(session, classId, rows));
      setText("");
      onImported();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "无法连接服务器，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  const copy = () => {
    if (!result) return;
    const lines = result.created.map((row) => `${row.displayName}\t${row.username}\t${row.initialPassword ?? "导入时已指定"}`);
    void navigator.clipboard.writeText(`姓名\t学号\t初始密码\n${lines.join("\n")}`).then(() => toast.ok("已复制"));
  };

  return (
    <Dialog
      title={`批量导入 · ${className}`}
      width={640}
      onClose={onClose}
      footer={
        result
          ? <>{result.created.length ? <Button onClick={copy}>复制账号密码</Button> : null}<Button onClick={() => setResult(null)}>继续导入</Button><Button variant="primary" onClick={onClose}>完成</Button></>
          : <><Button onClick={onClose}>取消</Button><Button variant="primary" loading={busy} onClick={() => void submit()}>导入</Button></>
      }
    >
      {result ? (
        <>
          <p>成功 {result.created.length} 人{result.failed.length ? `，失败 ${result.failed.length} 人` : ""}。初始密码只显示这一次，请复制后发给学生。</p>
          {result.created.length ? (
            <DataTable
              rows={result.created}
              rowKey={(row) => row.username}
              columns={[
                { key: "account", title: "学号", render: (row) => row.username },
                { key: "name", title: "姓名", render: (row) => row.displayName },
                { key: "password", title: "初始密码", render: (row) => (row.initialPassword ? <code className="mono-strong">{row.initialPassword}</code> : <span className="faint">导入时已指定</span>) },
              ]}
            />
          ) : null}
          {result.failed.length ? <p className="ui-field-error">失败：{result.failed.map((row) => `${row.username}（${row.reason}）`).join("、")}</p> : null}
        </>
      ) : (
        <Field label="学生名单" hint="每行一个学生：学号,姓名 或 学号,姓名,初始密码。可以直接从 Excel 复制两列粘贴进来；不填密码会自动生成。" error={error}>
          <Textarea autoFocus rows={10} value={text} onChange={(event) => setText(event.target.value)} placeholder={"s2602001,王小明\ns2602002,刘小红"} />
        </Field>
      )}
    </Dialog>
  );
}
