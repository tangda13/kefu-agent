import { Copy, FileSpreadsheet, KeyRound, Pencil, Plus, Search, Trash2, UploadCloud, UsersRound } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "../../components/AppShell";
import {
  ApiError,
  createClass,
  deleteClass,
  fetchClasses,
  fetchClassStudents,
  importStudents,
  renameClass,
  resetStudentPassword,
  setStudentStatus,
  type ClassStudent,
  type ClassSummary,
  type ImportResult,
  type Session,
} from "../../api/client";
import { copyText, TeacherDialog } from "./widgets";

function errorText(cause: unknown): string {
  return cause instanceof ApiError ? cause.message : "无法连接服务器，请稍后重试。";
}

export function LiveClasses({ session }: { session: Session }) {
  const [classes, setClasses] = useState<ClassSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [students, setStudents] = useState<ClassStudent[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [creating, setCreating] = useState(false);
  const [newClassName, setNewClassName] = useState("");
  const [importing, setImporting] = useState(false);
  const [importText, setImportText] = useState("");
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [studentQuery, setStudentQuery] = useState("");
  const [dialogError, setDialogError] = useState("");
  const [passwordReset, setPasswordReset] = useState<{ name: string; username: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const loadClasses = useCallback(async () => {
    try {
      const list = await fetchClasses(session);
      setClasses(list);
      setSelectedId((current) => current ?? list[0]?.id ?? null);
    } catch (cause) {
      setError(errorText(cause));
    }
  }, [session]);

  useEffect(() => {
    void loadClasses();
  }, [loadClasses]);

  useEffect(() => {
    if (!selectedId) {
      setStudents([]);
      return;
    }
    let cancelled = false;
    fetchClassStudents(session, selectedId)
      .then((rows) => {
        if (!cancelled) setStudents(rows);
      })
      .catch((cause) => {
        if (!cancelled) setError(errorText(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [session, selectedId, notice]);

  const selected = classes.find((item) => item.id === selectedId) ?? null;
  const visibleStudents = useMemo(() => {
    const keyword = studentQuery.trim().toLowerCase();
    if (!keyword) return students;
    return students.filter((row) =>
      row.displayName.toLowerCase().includes(keyword) || row.username.toLowerCase().includes(keyword),
    );
  }, [students, studentQuery]);

  async function submitNewClass() {
    if (!newClassName.trim() || busy) return;
    setBusy(true);
    setDialogError("");
    try {
      const created = await createClass(session, newClassName.trim());
      setNewClassName("");
      setCreating(false);
      await loadClasses();
      setSelectedId(created.id);
      setNotice(`班级「${created.name}」已创建，可继续批量导入学生`);
    } catch (cause) {
      setDialogError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function submitImport() {
    if (!selectedId || busy) return;
    const rows = importText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [username = "", displayName = ""] = line.split(/[,，\t]/).map((part) => part.trim());
        return { username, displayName };
      });
    if (rows.length === 0) {
      setDialogError("请按每行「账号,姓名」填写导入名单。");
      return;
    }
    setBusy(true);
    setDialogError("");
    try {
      const result = await importStudents(session, selectedId, rows);
      setImportResult(result);
      setImportText("");
      setNotice(`导入完成：成功 ${result.created.length} 人，失败 ${result.failed.length} 人`);
      await loadClasses();
    } catch (cause) {
      setDialogError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  function closeImport() {
    setImporting(false);
    setImportResult(null);
    setDialogError("");
  }

  async function copyImportResult() {
    if (!importResult) return;
    const lines = importResult.created
      .map((row) => `${row.username}\t${row.displayName}\t${row.initialPassword ?? "使用导入时指定的密码"}`)
      .join("\n");
    if (await copyText(`账号\t姓名\t初始密码\n${lines}`)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }
  }

  async function resetPassword(student: ClassStudent) {
    if (busy) return;
    if (!window.confirm(`确定重置 ${student.displayName}（${student.username}）的密码吗？原密码将立即失效。`)) return;
    setBusy(true);
    setError("");
    try {
      const { temporaryPassword } = await resetStudentPassword(session, student.id);
      setPasswordReset({ name: student.displayName, username: student.username, password: temporaryPassword });
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function submitRename() {
    if (!selected || !renameValue.trim() || busy) return;
    setBusy(true);
    setDialogError("");
    try {
      await renameClass(session, selected.id, renameValue.trim());
      setRenaming(false);
      setNotice(`班级已重命名为「${renameValue.trim()}」`);
      await loadClasses();
    } catch (cause) {
      setDialogError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function removeClass() {
    if (!selected || busy) return;
    if (!window.confirm(`确定删除班级「${selected.name}」吗？只有没有学生的空班级可以删除。`)) return;
    setBusy(true);
    setError("");
    try {
      await deleteClass(session, selected.id);
      setNotice(`班级「${selected.name}」已删除`);
      setSelectedId(null);
      await loadClasses();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function toggleStudent(student: ClassStudent) {
    if (busy) return;
    const next = student.status === "active" ? "disabled" : "active";
    if (next === "disabled" && !window.confirm(`确定停用 ${student.displayName}（${student.username}）吗？停用后该学生将无法登录，实训数据保留。`)) return;
    setBusy(true);
    setError("");
    try {
      await setStudentStatus(session, student.id, next);
      setNotice(`${student.displayName} 已${next === "active" ? "启用" : "停用"}`);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  function exportRoster() {
    if (!selected) return;
    const header = "账号,姓名,状态,待改密\n";
    const body = students
      .map((row) => `${row.username},${row.displayName},${row.status === "active" ? "启用" : "停用"},${row.mustChangePassword ? "是" : "否"}`)
      .join("\n");
    const blob = new Blob(["﻿" + header + body], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${selected.name}-名单.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return (
    <div className="page">
      <PageHeader
        title="班级与学生管理"
        description="创建班级、批量导入学生、重置密码与名单导出。"
        actions={
          <>
            <button className="secondary-button" onClick={exportRoster} disabled={!selected || students.length === 0}>
              <FileSpreadsheet size={16} /> 导出名单
            </button>
            <button className="primary-button" onClick={() => { setNewClassName(""); setDialogError(""); setCreating(true); }}>
              <Plus size={16} /> 新建班级
            </button>
          </>
        }
      />
      {notice ? <p className="form-notice" role="status">{notice}</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}

      <div className="classes-layout">
        <aside className="panel class-list">
          <div className="panel-heading compact-heading">
            <div>
              <h2>班级列表</h2>
              <p>{classes.length} 个教学班</p>
            </div>
          </div>
          {classes.length === 0 ? (
            <div className="tt-empty">
              <UsersRound size={24} aria-hidden="true" />
              <strong>还没有班级</strong>
              <p>点击右上角「新建班级」创建第一个教学班。</p>
            </div>
          ) : null}
          {classes.map((item) => (
            <button
              className={item.id === selectedId ? "class-item active" : "class-item"}
              key={item.id}
              onClick={() => setSelectedId(item.id)}
            >
              <span>
                <strong>{item.name}</strong>
                <small>{item.studentCount} 人</small>
              </span>
              <em>{item.id === selectedId ? "当前" : "查看"}</em>
            </button>
          ))}
        </aside>
        <section className="panel data-panel">
          <div className="panel-heading">
            <div>
              <h2>{selected ? selected.name : "请选择班级"}</h2>
              <p>{selected ? `${students.length} 名学生` : "从左侧选择或新建一个班级"}</p>
            </div>
            {selected && (
              <div className="tch-heading-actions">
                <button className="secondary-button compact" onClick={() => { setRenameValue(selected.name); setDialogError(""); setRenaming(true); }}>
                  <Pencil size={14} /> 重命名
                </button>
                <button
                  className="secondary-button compact"
                  onClick={removeClass}
                  disabled={students.length > 0}
                  title={students.length > 0 ? "班级内仍有学生，无法删除" : "删除该班级"}
                >
                  <Trash2 size={14} /> 删除班级
                </button>
                <button className="primary-button compact" onClick={() => { setImportResult(null); setDialogError(""); setImporting(true); }}>
                  <UploadCloud size={15} /> 批量导入学生
                </button>
              </div>
            )}
          </div>
          {selected && students.length > 0 ? (
            <div className="tch-toolbar">
              <div className="tch-search">
                <Search size={14} aria-hidden="true" />
                <input
                  value={studentQuery}
                  placeholder="搜索姓名或账号"
                  onChange={(event) => setStudentQuery(event.target.value)}
                />
              </div>
              <span className="tch-count">
                启用 {students.filter((row) => row.status === "active").length} · 停用 {students.filter((row) => row.status !== "active").length}
              </span>
            </div>
          ) : null}
          {selected && students.length === 0 ? (
            <div className="tt-empty">
              <UsersRound size={24} aria-hidden="true" />
              <strong>班级暂无学生</strong>
              <p>点击右上角「批量导入学生」，按「账号,姓名」格式一次导入全班名单，系统会自动生成初始密码。</p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>学生</th>
                  <th>账号</th>
                  <th>状态</th>
                  <th>待改密</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {visibleStudents.map((row) => (
                  <tr key={row.id} className={row.status !== "active" ? "tch-row-muted" : undefined}>
                    <td>
                      <span className="student-cell">
                        <span className="avatar small">{row.displayName[0]}</span>
                        <strong>{row.displayName}</strong>
                      </span>
                    </td>
                    <td>{row.username}</td>
                    <td>
                      <em className={row.status === "active" ? "state-done" : "state-warning"}>
                        {row.status === "active" ? "启用" : "停用"}
                      </em>
                    </td>
                    <td>{row.mustChangePassword ? "是" : "否"}</td>
                    <td className="tch-actions">
                      <button className="text-button" onClick={() => resetPassword(row)} disabled={busy}>
                        <KeyRound size={14} /> 重置密码
                      </button>
                      <button
                        className={row.status === "active" ? "text-button tch-danger" : "text-button"}
                        onClick={() => toggleStudent(row)}
                        disabled={busy}
                      >
                        {row.status === "active" ? "停用" : "启用"}
                      </button>
                    </td>
                  </tr>
                ))}
                {selected && students.length > 0 && visibleStudents.length === 0 ? (
                  <tr><td colSpan={5}><span className="muted">没有匹配「{studentQuery}」的学生。</span></td></tr>
                ) : null}
              </tbody>
            </table>
          )}
        </section>
      </div>

      {creating ? (
        <TeacherDialog
          title="新建班级"
          subtitle="创建后可立即批量导入该班学生"
          onClose={() => setCreating(false)}
          footer={
            <>
              <button className="secondary-button" onClick={() => setCreating(false)}>取消</button>
              <button className="primary-button" onClick={submitNewClass} disabled={busy || !newClassName.trim()}>
                {busy ? "创建中…" : "创建班级"}
              </button>
            </>
          }
        >
          {dialogError ? <p className="form-error" role="alert">{dialogError}</p> : null}
          <label>
            班级名称
            <input
              value={newClassName}
              onChange={(event) => setNewClassName(event.target.value)}
              placeholder="例如：跨境电商2602班"
              autoFocus
              onKeyDown={(event) => { if (event.key === "Enter") void submitNewClass(); }}
            />
          </label>
        </TeacherDialog>
      ) : null}

      {renaming && selected ? (
        <TeacherDialog
          title="重命名班级"
          onClose={() => setRenaming(false)}
          footer={
            <>
              <button className="secondary-button" onClick={() => setRenaming(false)}>取消</button>
              <button className="primary-button" onClick={submitRename} disabled={busy || !renameValue.trim()}>保存</button>
            </>
          }
        >
          {dialogError ? <p className="form-error" role="alert">{dialogError}</p> : null}
          <label>
            班级名称
            <input value={renameValue} onChange={(event) => setRenameValue(event.target.value)} autoFocus />
          </label>
        </TeacherDialog>
      ) : null}

      {importing && selected ? (
        <TeacherDialog
          title={`批量导入学生 · ${selected.name}`}
          subtitle={importResult ? "导入完成，初始密码仅本次显示，请立即复制保存" : "每行一名学生，格式：账号,姓名（支持逗号或制表符分隔）"}
          size="xl"
          onClose={closeImport}
          footer={
            importResult ? (
              <>
                <button className="secondary-button" onClick={() => setImportResult(null)}>继续导入</button>
                <button className="primary-button" onClick={closeImport}>完成</button>
              </>
            ) : (
              <>
                <button className="secondary-button" onClick={closeImport}>取消</button>
                <button className="primary-button" onClick={submitImport} disabled={busy || !importText.trim()}>
                  {busy ? "导入中…" : "导入"}
                </button>
              </>
            )
          }
        >
          {dialogError ? <p className="form-error" role="alert">{dialogError}</p> : null}
          {importResult ? (
            <>
              <div className="tt-weight-head">
                <span className="tt-weight-total">成功 {importResult.created.length} 人</span>
                {importResult.failed.length > 0 ? (
                  <span className="tt-weight-total bad">失败 {importResult.failed.length} 人</span>
                ) : null}
                {importResult.created.length > 0 ? (
                  <button className="text-button" onClick={copyImportResult}>
                    <Copy size={13} /> {copied ? "已复制" : "复制全部账号密码"}
                  </button>
                ) : null}
              </div>
              {importResult.created.length > 0 ? (
                <div className="tt-import-list">
                  <div className="tt-import-row head"><span>账号</span><span>姓名</span><span>初始密码</span></div>
                  {importResult.created.map((row) => (
                    <div key={row.username} className="tt-import-row">
                      <span>{row.username}</span>
                      <span>{row.displayName}</span>
                      <strong>{row.initialPassword ?? "使用导入时指定的密码"}</strong>
                    </div>
                  ))}
                </div>
              ) : null}
              {importResult.failed.length > 0 ? (
                <p className="form-error">
                  失败：{importResult.failed.map((row) => `${row.username}（${row.reason}）`).join("、")}
                </p>
              ) : null}
              <p className="muted tch-dialog-hint">学生首次登录后会被要求修改初始密码。</p>
            </>
          ) : (
            <textarea
              rows={9}
              value={importText}
              onChange={(event) => setImportText(event.target.value)}
              placeholder={"s2602001,王小明\ns2602002,刘小红"}
              autoFocus
            />
          )}
        </TeacherDialog>
      ) : null}

      {passwordReset ? (
        <TeacherDialog
          title={`重置密码 · ${passwordReset.name}`}
          subtitle="临时密码仅本次显示，请立即复制并转告学生；学生登录后需自行修改"
          onClose={() => setPasswordReset(null)}
          footer={<button className="primary-button" onClick={() => setPasswordReset(null)}>我已保存</button>}
        >
          <div className="tt-pass-box">
            <div>
              <span>账号 {passwordReset.username}</span>
              <strong>{passwordReset.password}</strong>
            </div>
            <button
              className="secondary-button compact"
              onClick={async () => {
                if (await copyText(`${passwordReset.username} 临时密码：${passwordReset.password}`)) {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 2000);
                }
              }}
            >
              <Copy size={13} /> {copied ? "已复制" : "复制"}
            </button>
          </div>
        </TeacherDialog>
      ) : null}
    </div>
  );
}
