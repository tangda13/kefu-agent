import { describe, expect, it } from "vitest";
import { roleNav } from "./components/AppShell";

describe("document-defined navigation", () => {
  it("keeps the exact student and teacher primary navigation", () => {
    expect(roleNav.student.map((item) => item.label)).toEqual([
      "任务大厅",
      "客服工作台",
      "订单",
      "评价",
      "邮件",
      "我的记录",
    ]);
    expect(roleNav.teacher.map((item) => item.label)).toEqual([
      "数据总览",
      "实训任务",
      "班级与学生",
      "通知公告",
      "实训跟踪",
      "考核报表",
      "场景配置",
    ]);
  });

  it("keeps management functions within the five parameter-document modules", () => {
    expect(roleNav.admin.map((item) => item.label)).toEqual([
      "系统总览",
      "AI 与语音服务",
      "账号与权限",
      "内容资源库",
      "数据与备份",
    ]);
  });
});

