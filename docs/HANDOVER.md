# 交接文档（2026-07-15 更新）

## Git 仓库（2026-07-15 建立）
- 本地 main 分支，远程 https://github.com/tangda13/kefu-agent（首次提交 80cac5c 已推送）。
- **推送必须走代理**：直连 github.com 443 会超时，已配仓库级 `git config http.proxy http://127.0.0.1:7890`（Clash，随系统代理）。
- git 身份为仓库级配置（joesph_voluptatibuste@chef.net），未动全局；用户可自行改 user.name。
- .gitignore 已排除：`apps/api/.env`（密钥）、`apps/api/backups/`（**备份含密码哈希与服务密钥，严禁入库**）、`uploads/`（运行时数据）、node_modules/dist、Office 锁文件、`.claude/settings.local.json`。
- ⚠️ **工作区有未提交改动**（另一并行会话的开发中功能：`apps/api/src/review-gen.ts` 买家闭环评价 + conversations/orders/client/domain 若干修改）——接手后先确认该功能完成度（build+test）再提交推送，勿直接丢弃。

## 项目状态总览

| 阶段 | 内容 | 状态 |
|---|---|---|
| 0-1 | 基线/账号/班级/任务 | ✅ 完成 |
| 2 | 学生端全闭环（LLM对话/高仿真工作台/订单AI话术/邮件违规检测/六维评分/TTS播报/ASR语音输入/语音消息直发） | ✅ 完成 |
| 3 | 教师端（总览/任务/班级/实时监控+介入/回放复核/考核报表Excel-PDF/场景商品配置） | ✅ 完成 |
| 4 | 管理端（系统总览/Provider热切换/计量告警/账号/内容库DB化/备份/审计/定时备份） | ✅ 完成 |
| 5 | 验收工具（TTFT报表+一键100次测试）✅；**换正式LLM Provider ⏸**；并发压测 ⏸ | 部分 |
| 6 | Electron 打包（electron-builder+签名）、部署文档、操作手册 | ⏸ 待做 |

## 关键待办（按优先级）
1. 提交工作区未提交改动（买家闭环评价 review-gen 等，见上方 Git 段落）。
2. **换正式 LLM Provider**：keliagent 实测 TTFT P50=5.9s、≤3s率仅7%（红线99%）❌。拿到正式服务后在管理端「AI与语音服务」填地址+密钥+模型，保存即热切换，再点「运行验收测试(100次)」复验。输出速度/TTS/ASR 均已达标。
3. 阶段6：electron-builder 打包安装包（现为单客户端）+ 部署说明 + 操作手册。
4. 并发压测（200账号/100并发目标）。
5. 零散债：任务限时未强制执行；侧边栏品牌"AI 实训平台"含"实训"字样待用户拍板是否改名。

## 学生端其他页面（2026-07-15 并行完成，详见记忆 cecs-project-state）
- **订单页 v2/v3**：电商后台式两级导航（千牛式列表→详情 hero 五步条+三页签），物流轨迹细颗粒扫描事件、收件信息按国籍虚拟。
- **评价管理独立页**（侧边栏"评价"）：全店评价统计/筛选，人工回复为主+AI 辅助（components/ReviewReply.tsx），回复记录 localStorage。
- **邮件页 v2**：邮箱客户端三栏（收件箱=按订单状态派生的买家来信/回复/写邮件/已发送/草稿箱）+ AI 辅助写信（/v1/mail/assist）+ 买家 AI 回信（015迁移 mail_replies，营销信按客户类型概率回）。
- 共用组件已抽出：components/{BuyerAvatar,SuggestionComposer,ReviewReply}.tsx；邮箱派生在 domain（stableHash/deriveBuyerEmail，前后端共用勿改算法）。

## 环境速查
- 一键启动（2026-10-12 起）：根目录 `dev.cmd`（学生/教师客户端调试，默认同时开学生、教师两个独立登录的客户端；`dev.cmd stop|status|restart api|logs|client teacher 2|test`）和 `admin.cmd`（浏览器打开管理端）。旧的 `启动开发环境.cmd` / `客户端.cmd` / `start-dev.ps1` / `start-client.ps1` 已删除
- 端口：API 8787 / 前端 **5288**（5173/5174 属智慧物流项目勿动）/ Postgres 容器 cecs-pg:5434（库 cecs、cecs_test）
- 密钥在 `apps/api/.env`（gitignore）：LLM=keliagent deepseek-v4-pro；语音=豆包（TTS seed-tts-2.0 音色 vv_uranus/dayi_uranus；ASR volc.seedasr.sauc.duration）
- 测试账号：admin/Admin#Prod2026 · wang.teacher/Teach#2026 · s2601001/Student#01 · s2601002/Student#02（班级：跨境电商2601班）
- 验证方式：`pnpm build && pnpm test`（19项）；Playwright 脚本模式见 scratchpad 历史

## 设计系统（2026-07-14 全面重构）
- 视觉权威文档：根目录 `DESIGN.md`（苹果设计语言）。改 UI 前必读，样式全在 `apps/portal/src/styles.css`（设计令牌见文件头部 `:root`）。
- 核心规则：单一交互色 Action Blue #0066cc（暗面 #2997ff）；无装饰渐变/阴影/发光；卡片=白底+1px 发丝线 #e0e0e0+18px 圆角；暗色瓦片 #272729 做韵律；主按钮=蓝色胶囊，按压 scale(.97)；系统字体栈（无 Google Fonts，离线可用）；正文最小字号 11px；开关用 Apple 绿 #34c759。
- 登录页：左暗色瓦片编辑部排版 + 右白卡「学生登录/教师登录」页签。

## 工作台 v5（2026-07-15 功能深化）
- **会话结束权在买家**：客服无关闭按钮；买家问题解决/失去耐心时输出 `[END_OF_SERVICE]` 标记（conversation-provider prompt + conversations.ts 流式扣留剥离），服务端自动关会话并触发六维评分，前端显示"客户已离开"。
- **KPI 扩展**：workbench-stats 新增 12小时响应率/满意率(导演satisfaction均值)/询单支付金额/付款人数/询单转化率；前端精简条+「查看详情」展开面板。
- **教师指导走通知**：不再内嵌会话气泡；新端点 /v1/student/guidance，App.tsx 20s 轮询 → 顶栏铃铛下拉（未读角标、点击跳会话，已读存 localStorage）。
- **订单页签**：013 迁移放开一会话一订单（orders.is_primary）；老客/粉丝客自动生成 1-3 笔历史订单（domain generateBuyerOrderHistory，地址按国籍生成 buildOrderAddress）；状态筛选/单号搜索/复制；操作=发送订单卡(cards type=order)/详情展开/备注/改地址（PATCH /v1/orders/:id，写 payload jsonb）。
- **商品页签**：全店商品/买家浏览过（会话种子稳定抽取）子页签，SKU 行；右栏加宽 328px。
- **输入区**：表情面板/发图片/视频/文件（/v1/conversations/:cid/attachment-messages，multipart+kind 字段，消息 kind=image|video|file，买家能感知并回应）/快捷短语/自动翻译开关（localStorage 持久，自动为最新买家消息取译文，GET messages 已回传缓存译文）。
- ⚠️ 修复潜在 bug：CORS 默认不放行 PATCH/DELETE，server.ts 已显式配置 methods（教师复核 PATCH、管理端 DELETE 此前在浏览器会被预检拦截）。

## 工作台 v6（2026-07-15 二轮优化）
- KPI 条移页面左上；顶栏全局搜索框删除（原为占位无功能）。
- 三栏分界线可拖拽调宽（col-resizer，宽度存 localStorage cecs.ws.railW/panelW）。
- 商品面板操作扩展：发送商品 / **邀请下单**（cards type=invite，买家可回应）/ **规格属性**（展开属性行+填入规格信息到输入框）/ **算价**（数量×单价合计+填入报价）。
- 修复卡片消息气泡：学生发出的商品/优惠券/订单卡此前白字无底色不可见，现学生侧蓝底白字、买家侧灰底。
- **买家拟真聊天**：prompt 改口语短句风（禁公文腔/列表），支持 `|||` 分隔 1-3 条连发短消息——服务端流式解析（split 事件+扣留窗口）、分行落库（回放/教师端同样逐条）；**学生连发**：消息 defer 落库即时上屏，发送后开 **2 秒打字检测窗口**——窗口内每次击键/再次发送都把窗口重置回 2s（还在打字买家就等）；窗口到期时输入框仍有草稿则继续顺延（思考中），最多等 15s 兜底（防弃稿死锁）；窗口结束 POST /reply 让买家一次性回应全部。
- 已实测：买家会因连续无关推销自然离场（END 机制真实触发）；沉睡客用两条短气泡口语回应连发唤醒。

## 教师端 v3（2026-07-17 全面重构）
- **操作全部弹窗化**：新建任务（chip 多选班级/场景 + 权重滑杆合计校验 + 一键均衡）、新建/重命名班级、批量导入学生（结果含初始密码列表+一键复制）、重置密码（结果弹窗+复制）、发布公告、添加商品（含主图预览）、画像编辑——不再有页面内嵌表单。
- **实训跟踪重构为监控台**：左侧会话列表（预警优先排序、等待时长着色、最新消息摘要、需介入标记），右侧实时对话流（与列表同为 8 秒轮询，满足 ≤10s 红线；贴底自动跟随），教师可对**任意会话**自主介入（快捷指导语 + 输入框，不限于 AI 预警）；会话结束保留快照并提示转向回放。「回放与评分」合并为大弹窗（复用 rec-modal：左对话回放、右六维评分/AI评语/建议/人工复核表单）。
- **数据总览/考核报表**：真 SVG 六维雷达 + 薄弱项标记；直方图重排（网格线/计数/空态）；报表页新增指标摘要行（已评会话/参评学生/加权平均/及格优良率）、排名表带档位徽章。
- **场景配置**：商品/场景/画像启停用改 Apple 开关；表格加停用置灰。
- **共享组件** `apps/portal/src/pages/teacher/widgets.tsx`：TeacherDialog（Esc 关闭，wide/xl/xxl）、Histogram、RadarChart、scoreBand、formatIdle、copyText。
- **全局**：MetricCard 排版修复（标签上、大数字下，AppShell 组件与 CSS 同步改，学生/管理端同样受益）；教师端页头去英文 eyebrow；新样式集中在 styles.css 末尾「教师端 v3（tt- 前缀）」段。

## 评分体系任务化 + 自由练习（2026-07-17）
- **评分层级**：会话评分（过程数据，实时监控/回放复核用）→ **任务成绩 = 该任务下所有已评会话的均分**（assessment.ts 落库时重算，教师复核改分后同步重算 task_progress.score）→ 班级统计一人一个样本。
- **总分加权**：会话总分按任务 scoring_weights 加权（此前权重只存不用，六维等权是兜底）。
- **教师端统计口径**（overview/reports 共用 teacher.ts 的 aggregateTaskCentric）：「全部任务综合」= 每名学生各任务成绩的平均（一人一样本）；两页均有任务筛选器（?taskId=）可看单个任务分布/雷达/排名；报表排名 = 综合成绩排序，含任务数/会话数/最高任务分。
- **自由练习**：任务大厅深色横幅右侧新入口（fb-practice，场景选择弹窗，随机场景默认）→ 创建无任务会话（POST /v1/conversations 只传 scenarioId）→ sessionStorage cecs.openConversation 挂载进工作台。**无任务会话不评分**（assessment.ts 提前 return），因此不进学生/教师任何成绩统计；教师实训跟踪仍可监控介入，会话带「练习」标记（tracking 接口 practice 字段）。
- ⚠️ 旧测试数据：库里 3 条历史评分挂在无任务会话上，任务口径下总览/报表为空属正常；新完成的任务会话会正常入统计。

## 任务定时开放（2026-07-17）
- 任务新增 `start_at`（迁移 018）：留空 = 立即开放；设置后学生任务列表**可见但标「未开始」+ 开放时间，不可进入**（适合学期初一次性排整学期任务计划）。
- 强制链路：学生端任务大厅未开始行无开始按钮、工作台「未分配」队列过滤 locked 任务、**服务端 POST /v1/conversations 对未开始任务 403（TASK_NOT_STARTED）**；开始时间须早于截止时间（前后端双校验）。
- 教师端：新建/编辑弹窗均可设开始时间；任务表未开始任务显示「未开始」黄标 + 开放时间；`/v1/student/tasks` 返回 startAt + locked 派生字段。
- 服务端错误消息不拼具体时间（服务器时区未必与学生一致），开放时间由前端本地化展示。

## 架构要点
- 单仓 pnpm：apps/{api,portal,desktop} + packages/{contracts,domain}；API=Fastify+pg（15个迁移，migrations.ts）；前端 React+Vite；桌面 Electron（已安全加固，待打包）
- 买家=自研轻量Agent（导演-演员）：director.ts 每轮异步评分/情绪演变/剧情阶段/事实记忆（conversations.state），人设每轮重注入防漂移；记忆按会话行级隔离
- 画像：DB模板(教师维护)打底 + 任务persona_rule约束 + 按国籍姓名池真随机；头像=本地真人库按性别
- **核心设计原则：实训是幕后逻辑，学生端界面必须是纯正客服软件**（任务=未分配新客进线，无实训字样）。2026-07-16 用户澄清边界：该原则只约束沉浸层（工作台/订单/评价/邮件）；**任务大厅与我的记录属学习管理层**，可直呼任务/成绩（任务列表**无状态页签**，平铺全部任务、状态为行内彩色标签 待办/进行中/已完成；按钮 开始任务/继续任务/查看成绩），但 persona_rule（买家国籍/性格/情绪约束）仍不得暴露给学生。任务大厅已重构：全部任务列表+行内详情（场景/互动方式/限时/评分权重，/v1/student/tasks 已扩展）+指标卡接真数据。
- Provider 可热切换（SwappableConversationProvider，DB设置优先于env）；所有验收指标（TTFT/语音耗时）落库可核验

## 文档索引
- `docs/PRODUCT_BASELINE.md` 产品红线（改需求先改它）· `docs/REQUIREMENTS_TRACEABILITY.md` 需求追踪（STU/TCH/CFG/ADM/OPS编号）· `docs/ROADMAP.md` 排期 · `docs/ARCHITECTURE.md` 架构
