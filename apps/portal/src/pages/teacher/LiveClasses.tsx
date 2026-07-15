import { FileSpreadsheet, KeyRound, Plus, UploadCloud, UsersRound } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "../../components/AppShell";
import {
  ApiError,
  createClass,
  fetchClasses,
  fetchClassStudents,
  importStudents,
  resetStudentPassword,
  type ClassStudent,
  type ClassSummary,
  type ImportResult,
  type Session,
} from "../../api/client";

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

  async function submitNewClass() {
    if (!newClassName.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const created = await createClass(session, newClassName.trim());
      setNewClassName("");
      setCreating(false);
      await loadClasses();
      setSelectedId(created.id);
      setNotice(`班级「${created.name}」已创建`);
    } catch (cause) {
      setError(errorText(cause));
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
      setError("请按每行「账号,姓名」填写导入名单。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await importStudents(session, selectedId, rows);
      setImportResult(result);
      setImportText("");
      setNotice(`导入完成：成功 ${result.created.length} 人，失败 ${result.failed.length} 人`);
      await loadClasses();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword(student: ClassStudent) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const { temporaryPassword } = await resetStudentPassword(session, student.id);
      setNotice(`已重置 ${student.displayName}（${student.username}）的密码，临时密码：${temporaryPassword}（仅显示一次，请立即转告学生）`);
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
        eyebrow="CLASS MANAGEMENT"
        title="班级与学生管理"
        description="创建班级、批量导入学生、重置密码与名单导出。"
        actions={
          <>
            <button className="secondary-button" onClick={exportRoster} disabled={!selected || students.length === 0}>
              <FileSpreadsheet size={16} /> 导出名单
            </button>
            <button className="primary-button" onClick={() => setCreating((value) => !value)}>
              <Plus size={16} /> 新建班级
            </button>
          </>
        }
      />
      {notice ? <p className="form-notice" role="status">{notice}</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {creating && (
        <section className="panel creation-form">
          <div className="form-grid">
            <label>
              班级名称
              <input value={newClassName} onChange={(event) => setNewClassName(event.target.value)} placeholder="例如：跨境电商2602班" />
            </label>
          </div>
          <div className="form-actions">
            <button className="secondary-button" onClick={() => setCreating(false)}>取消</button>
            <button className="primary-button" onClick={submitNewClass} disabled={busy || !newClassName.trim()}>创建班级</button>
          </div>
        </section>
      )}
      <div className="classes-layout">
        <aside className="panel class-list">
          <div className="panel-heading compact-heading">
            <div>
              <h2>班级列表</h2>
              <p>{classes.length} 个教学班</p>
            </div>
          </div>
          {classes.length === 0 ? <p className="muted">还没有班级，请先新建。</p> : null}
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
              <button className="secondary-button compact" onClick={() => setImporting((value) => !value)}>
                <UploadCloud size={15} /> 批量导入学生
              </button>
            )}
          </div>
          {importing && selected && (
            <div className="import-box">
              <p className="muted">每行一名学生，格式：账号,姓名（支持逗号或制表符分隔）</p>
              <textarea
                rows={5}
                value={importText}
                onChange={(event) => setImportText(event.target.value)}
                placeholder={"s2602001,王小明\ns2602002,刘小红"}
              />
              <div className="form-actions">
                <button className="secondary-button" onClick={() => setImporting(false)}>收起</button>
                <button className="primary-button" onClick={submitImport} disabled={busy}>导入</button>
              </div>
              {importResult && importResult.created.some((row) => row.initialPassword) && (
                <div className="import-result">
                  <strong>初始临时密码（仅显示一次，请复制保存）：</strong>
                  <ul>
                    {importResult.created.map((row) => (
                      <li key={row.username}>
                        {row.username}（{row.displayName}）：{row.initialPassword ?? "使用导入时指定的密码"}
                      </li>
                    ))}
                  </ul>
                  {importResult.failed.length > 0 && (
                    <p className="form-error">失败：{importResult.failed.map((row) => `${row.username}（${row.reason}）`).join("、")}</p>
                  )}
                </div>
              )}
            </div>
          )}
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
              {students.map((row) => (
                <tr key={row.id}>
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
                  <td>
                    <button className="text-button" onClick={() => resetPassword(row)} disabled={busy}>
                      <KeyRound size={14} /> 重置密码
                    </button>
                  </td>
                </tr>
              ))}
              {selected && students.length === 0 ? (
                <tr>
                  <td colSpan={5}>
                    <span className="muted"><UsersRound size={15} /> 班级暂无学生，请批量导入。</span>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
