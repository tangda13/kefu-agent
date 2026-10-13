import { useState } from "react";
import { ApiError, importStudents, type ImportResult, type Session } from "../api/client";
import { Button, DataTable, Dialog, Field, Textarea, toast } from "../ui";

/* 管理端和教师端共用的账号弹窗：一次性密码展示、批量导入学生 */

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
