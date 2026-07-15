# 需求追踪矩阵

状态：`基础`=本阶段底座已建立，`计划`=进入对应阶段实现，`验收`=需专项验收。

| ID | 产品要求 | 主要实现位置 | 阶段 | 状态 |
|---|---|---|---|---|
| STU-01 | 学生独立登录、教师重置密码 | IAM、学生客户端 | 1 | 计划 |
| STU-02 | 任务大厅指标、三状态列表、一键进入 | portal/student、Training | 0/1 | 基础 |
| STU-03 | LLM 开放式动态买家对话 | ConversationProvider | 2 | 计划 |
| STU-04 | 20 轮上下文、至少 3 语种 | 会话编排、上下文策略 | 2/5 | 验收 |
| STU-05 | 99% 首字 ≤3 秒、其余 ≤10 秒、≥20 字符/秒 | SSE、指标、验收工具 | 2/5 | 验收 |
| STU-06 | 文字、ASR、TTS 至少 3 语种且语音 ≤5 秒 | VoiceProvider | 2/5 | 验收 |
| STU-07 | 同时至少 3 个买家会话与标签 | portal/workbench、Conversation | 0/2 | 基础 |
| STU-08 | 画像和关联订单信息面板 | portal/workbench、Persona/Commerce | 0/2 | 基础 |
| STU-09 | 订单详情/物流/评价及各不少于 3 个 AI 话术 | portal/orders、Commerce/AI | 0/2 | 基础 |
| STU-10 | 至少 4 个英文邮件模板 | portal/mail、Content | 0/2 | 基础 |
| STU-11 | 六维评估必含违规用语合规、语法准确性、话术规范、沟通有效性、客户情绪安抚、问题解决，附成绩、评语、复盘和改进建议 | portal/records、Assessment | 0/2 | 基础 |
| STU-12 | 违规宣传用语自动检测与规范话术提示（工作台与邮件撰写） | Content 词库、合规检测服务、portal/mail | 2 | 计划 |
| TCH-01 | 数据总览核心指标与薄弱项 | portal/teacher、Reporting | 0/3 | 基础 |
| TCH-02 | 任务列表、新建、下发和评分权重 | portal/teacher、Training | 0/1 | 基础 |
| TCH-03 | 班级学生、分组和导出 | IAM、Reporting | 1/3 | 计划 |
| TCH-04 | 实时监控刷新 ≤10 秒、预警、一键介入 | WebSocket、会话事件流 | 3/5 | 验收 |
| TCH-05 | 回放、至少 6 维评分、人工复核、导出 | Assessment、Reporting | 3 | 计划 |
| TCH-06 | Excel/PDF 考核报表 | Reporting | 3 | 计划 |
| CFG-01 | 至少 8 个场景覆盖 4 个环节 | packages/domain、Training | 0/1 | 基础 |
| CFG-02 | 至少 20 个画像模板，可增删改、启停、批量导入 | Persona | 0/1 | 基础 |
| CFG-03 | 至少 10 国籍、5 性格、3 情绪、4 客户类型 | packages/contracts/domain | 0/1 | 基础 |
| CFG-04 | 动态组合且学生会话前不可知 | Persona 服务端快照 | 1/2 | 计划 |
| CFG-05 | 教师端商品库维护（≥6内置，CRUD/启停，驱动订单与对话） | store_products、教师场景配置页 | 2 | 基础 |
| ADM-01 | 系统运行状态、告警、版本 | Platform | 4 | 计划 |
| ADM-02 | LLM/语音 Provider 配置切换、计量和额度提醒 | Provider Registry、Metering | 4 | 计划 |
| ADM-03 | 教师账号授权、学生导入/重置、班级关联 | IAM | 1/4 | 计划 |
| ADM-04 | 初始 100 条违规词、50 条标准话术 | Content | 4 | 计划 |
| ADM-05 | 手动/定时备份和数据导出 | Backup、Reporting | 4/5 | 计划 |
| ADM-06 | 操作审计、错误日志、登录记录查询追溯（基线 2.4 裁决保留，不设教学入口） | Platform 审计 | 4 | 计划 |
| OPS-01 | 3 年云资源、AI/语音算力和基础运维 | 云部署与运维清单 | 6 | 计划 |
| OPS-02 | 200 人账号规模日常使用 | 容量模型、压测 | 5 | 验收 |
| OPS-03 | 学生/教师 Windows 客户端，管理端国内云浏览器访问 | desktop、portal/admin | 0/6 | 基础 |
| OPS-04 | 故障 1 个工作日内响应 | 运维 SLA | 6 | 计划 |
| OPS-05 | 安装包、管理地址/凭据、手册、部署说明 | 发布流水线、交付文档 | 6 | 计划 |
