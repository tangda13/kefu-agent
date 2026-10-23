export interface Migration {
  id: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    id: "001_stage1_foundation",
    sql: `
create extension if not exists pgcrypto;

create table if not exists classes (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  head_teacher_id uuid,
  created_at timestamptz not null default now()
);

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  password_hash text not null,
  display_name text not null,
  role text not null check (role in ('student','teacher','admin')),
  class_id uuid references classes(id),
  status text not null default 'active' check (status in ('active','disabled')),
  must_change_password boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table classes
  add constraint classes_head_teacher_fk
  foreign key (head_teacher_id) references users(id);

create table if not exists teacher_classes (
  teacher_id uuid not null references users(id) on delete cascade,
  class_id uuid not null references classes(id) on delete cascade,
  primary key (teacher_id, class_id)
);

create table if not exists refresh_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists refresh_tokens_user_idx on refresh_tokens(user_id);

create table if not exists scenarios (
  id text primary key,
  name text not null,
  stage text not null check (stage in ('pre_sale','in_sale','after_sale','customer_care')),
  objective text not null,
  default_language text not null,
  enabled boolean not null default true
);

create table if not exists persona_templates (
  id text primary key,
  name text not null,
  nationality text not null,
  identity text not null,
  personality text not null,
  emotion text not null,
  language text not null,
  preference text not null,
  customer_type text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  business_stage text not null check (business_stage in ('pre_sale','in_sale','after_sale','customer_care')),
  scenario_ids jsonb not null default '[]'::jsonb,
  persona_rule jsonb not null default '{}'::jsonb,
  interaction_mode text not null default 'text_voice' check (interaction_mode in ('text','voice','text_voice')),
  time_limit_minutes integer,
  deadline timestamptz,
  scoring_weights jsonb not null default '{}'::jsonb,
  status text not null default 'published' check (status in ('draft','published','closed')),
  created_by uuid not null references users(id),
  created_at timestamptz not null default now()
);

create table if not exists task_classes (
  task_id uuid not null references tasks(id) on delete cascade,
  class_id uuid not null references classes(id) on delete cascade,
  primary key (task_id, class_id)
);

create table if not exists task_progress (
  task_id uuid not null references tasks(id) on delete cascade,
  student_id uuid not null references users(id) on delete cascade,
  status text not null default 'todo' check (status in ('todo','in_progress','done')),
  score numeric,
  updated_at timestamptz not null default now(),
  primary key (task_id, student_id)
);

create table if not exists audit_log (
  id bigserial primary key,
  actor_id uuid,
  action text not null,
  target text,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_log_actor_idx on audit_log(actor_id);
create index if not exists audit_log_action_idx on audit_log(action);
`,
  },
  {
    id: "002_conversations",
    sql: `
create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references tasks(id) on delete set null,
  student_id uuid not null references users(id) on delete cascade,
  scenario_id text references scenarios(id),
  persona jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active','closed')),
  created_at timestamptz not null default now()
);
create index if not exists conversations_student_idx on conversations(student_id);

create table if not exists conversation_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  sender text not null check (sender in ('buyer','student','teacher')),
  content text not null,
  created_at timestamptz not null default now()
);
create index if not exists conversation_messages_conv_idx
  on conversation_messages(conversation_id, created_at);

create table if not exists conversation_metrics (
  request_id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  received_at timestamptz not null,
  first_char_at timestamptz,
  completed_at timestamptz,
  valid_chars integer not null default 0,
  provider text not null,
  model text not null,
  outcome text not null check (outcome in ('success','timeout','error'))
);
create index if not exists conversation_metrics_conv_idx
  on conversation_metrics(conversation_id);
`,
  },
  {
    id: "003_orders",
    sql: `
create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid unique references conversations(id) on delete cascade,
  student_id uuid not null references users(id) on delete cascade,
  order_no text not null,
  status text not null,
  product_name text not null,
  total_amount numeric not null,
  currency text not null default 'USD',
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists orders_student_idx on orders(student_id);
`,
  },
  {
    id: "004_message_translation",
    sql: `
alter table conversation_messages add column if not exists translated_content text;
`,
  },
  {
    id: "005_message_cards",
    sql: `
alter table conversation_messages add column if not exists kind text not null default 'text';
alter table conversation_messages add column if not exists payload jsonb;
`,
  },
  {
    id: "006_store_products",
    sql: `
create table if not exists store_products (
  id text primary key,
  name text not null,
  spec text not null,
  price numeric not null,
  sales integer not null default 0,
  stock integer not null default 0,
  tone text not null default '#2f6f8f',
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
`,
  },
  {
    id: "007_product_image",
    sql: `
alter table store_products add column if not exists image_url text;
`,
  },
  {
    id: "008_mail_submissions",
    sql: `
create table if not exists mail_submissions (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references users(id) on delete cascade,
  template_id text not null,
  subject text not null,
  body text not null,
  violations jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists mail_submissions_student_idx on mail_submissions(student_id);
`,
  },
  {
    id: "009_assessments",
    sql: `
create table if not exists assessments (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid unique not null references conversations(id) on delete cascade,
  student_id uuid not null references users(id) on delete cascade,
  scores jsonb not null,
  total numeric not null,
  comment text not null default '',
  suggestions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists assessments_student_idx on assessments(student_id);
`,
  },
  {
    id: "010_voice_metrics",
    sql: `
create table if not exists voice_metrics (
  id bigserial primary key,
  kind text not null check (kind in ('tts','asr')),
  elapsed_ms integer not null,
  chars integer not null default 0,
  outcome text not null check (outcome in ('success','error','timeout')),
  created_at timestamptz not null default now()
);
`,
  },
  {
    id: "011_conversation_state",
    sql: `
alter table conversations add column if not exists state jsonb not null default '{}'::jsonb;
`,
  },
  {
    id: "012_admin_foundation",
    sql: `
create table if not exists app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists content_terms (
  id bigserial primary key,
  kind text not null check (kind in ('forbidden','phrase')),
  text text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (kind, text)
);
`,
  },
  {
    id: "013_buyer_order_history",
    sql: `
alter table orders drop constraint if exists orders_conversation_id_key;
alter table orders add column if not exists is_primary boolean not null default true;
create index if not exists orders_conversation_idx on orders(conversation_id);
`,
  },
  {
    id: "014_mail_recipient",
    sql: `
alter table mail_submissions add column if not exists recipient text;
`,
  },
  {
    id: "015_mail_replies",
    sql: `
create table if not exists mail_replies (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references users(id) on delete cascade,
  order_id uuid references orders(id) on delete set null,
  submission_id uuid references mail_submissions(id) on delete cascade,
  from_name text not null,
  from_email text not null,
  subject text not null,
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists mail_replies_student_idx on mail_replies(student_id);
`,
  },
  {
    id: "016_baseline_assessments",
    sql: `
create table if not exists baseline_assessments (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references users(id) on delete cascade,
  answers jsonb not null,
  scores jsonb not null,
  total int not null,
  created_at timestamptz not null default now()
);
create unique index if not exists baseline_assessments_student_uq on baseline_assessments(student_id);
`,
  },
  {
    id: "017_announcements",
    sql: `
create table if not exists announcements (
  id uuid primary key default gen_random_uuid(),
  publisher_id uuid not null references users(id) on delete cascade,
  class_id uuid references classes(id) on delete cascade,
  title text not null,
  content text not null,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists announcements_class_idx on announcements(class_id);
`,
  },
  {
    /* 任务定时开放：start_at 之前学生可见但不可进入（服务端强制）；留空 = 立即开放 */
    id: "018_task_start_at",
    sql: `
alter table tasks add column if not exists start_at timestamptz;
`,
  },
  {
    /* 学生个人快捷短语：工作台自建，仅本人可见，与标准话术库（content_terms）并列展示 */
    id: "019_student_phrases",
    sql: `
create table if not exists student_phrases (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references users(id) on delete cascade,
  text text not null,
  created_at timestamptz not null default now()
);
create index if not exists student_phrases_student_idx on student_phrases(student_id);
`,
  },
  {
    /* 任务完成标准（教师可配）：
       completion_rule = all_scenarios（每个场景至少完成一次会话）| conversation_count（完成 required_count 次会话）
       pass_score = 达标分数线（空 = 不设线，完成即达标）。达标状态由 score 与 pass_score 推导，不落库 */
    id: "020_task_completion_rule",
    sql: `
alter table tasks add column if not exists completion_rule text not null default 'all_scenarios';
alter table tasks add column if not exists required_count int;
alter table tasks add column if not exists pass_score int;
`,
  },
  {
    /* 接待节奏（教师可配，买家自动进线取代手动「接入」）：
       sequential 上一位会话结束后下一位进线 | interval 每 N 分钟进线一位（可并发）| all_at_once 开始任务后全部进线 */
    id: "021_task_arrival_policy",
    sql: `
alter table tasks add column if not exists arrival_mode text not null default 'sequential';
alter table tasks add column if not exists arrival_interval_minutes int;
`,
  },
  {
    /* 账号安全（I1/I5）：
       login_failures 记录登录失败次数，key = user:<账号> | ip:<地址>，超限后 locked_until 内拒绝登录；
       班主任只记在 classes.head_teacher_id，teacher_classes 只放授权任课教师，清掉历史上两边重复写入的行 */
    id: "022_account_security",
    sql: `
create table if not exists login_failures (
  key text primary key,
  fail_count int not null default 0,
  window_started_at timestamptz not null default now(),
  locked_until timestamptz
);
delete from teacher_classes tc using classes c
  where c.id = tc.class_id and c.head_teacher_id = tc.teacher_id;
`,
  },
  {
    /* 学生端状态上云（K1–K4）：原先存在客户端 localStorage，换机器即丢失、教师也看不到
       review_replies 评价回复记录 | mail_drafts 邮件草稿（id 由客户端生成）| read_marks 已读标记（邮件 / 教师指导） */
    id: "023_student_cloud_state",
    sql: `
create table if not exists review_replies (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references users(id) on delete cascade,
  order_id uuid not null references orders(id) on delete cascade,
  text text not null,
  created_at timestamptz not null default now()
);
create index if not exists review_replies_student_idx on review_replies(student_id, order_id);

create table if not exists mail_drafts (
  student_id uuid not null references users(id) on delete cascade,
  id text not null,
  recipient text not null default '',
  subject text not null default '',
  body text not null default '',
  template_id text,
  saved_at timestamptz not null default now(),
  primary key (student_id, id)
);

create table if not exists read_marks (
  user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('mail','guidance')),
  item_id text not null,
  read_at timestamptz not null default now(),
  primary key (user_id, kind, item_id)
);
`,
  },
  {
    /* 模型网关（G1–G6）：llm_profiles 每行一个可用的“厂商地址 + 模型 + 参数”档案，Key 加密存储；
       用途路由与导演频率存 app_settings.llm_routing；llm_usage 记录每次调用的 tokens、费用与结果 */
    id: "024_llm_gateway",
    sql: `
create table if not exists llm_profiles (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  preset_key text not null default 'custom',
  protocol text not null default 'openai-completions',
  base_url text not null,
  api_key_enc text not null default '',
  model text not null,
  extra_headers jsonb not null default '{}'::jsonb,
  extra_body jsonb not null default '{}'::jsonb,
  max_tokens_field text not null default 'max_tokens' check (max_tokens_field in ('max_tokens','max_completion_tokens')),
  json_mode boolean not null default false,
  timeout_ms int not null default 60000,
  price_input numeric not null default 0,
  price_output numeric not null default 0,
  enabled boolean not null default true,
  is_default boolean not null default false,
  test_status text not null default 'untested' check (test_status in ('untested','ok','failed')),
  test_result jsonb,
  tested_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists llm_profiles_one_default on llm_profiles(is_default) where is_default;

create table if not exists llm_usage (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  profile_id uuid references llm_profiles(id) on delete set null,
  profile_name text not null,
  model text not null,
  purpose text not null,
  outcome text not null check (outcome in ('success','error','timeout','parse_error')),
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cost numeric not null default 0,
  ttft_ms int,
  duration_ms int not null default 0,
  fallback boolean not null default false,
  conversation_id uuid,
  error text
);
create index if not exists llm_usage_created_idx on llm_usage(created_at);

alter table voice_metrics add column if not exists audio_ms int not null default 0;
`,
  },
  {
    /* Agent 底座（J2/J5/J7）：场景剧本、评分追溯（提示词版本 + 模型 + 客观依据） */
    id: "025_agent_foundation",
    sql: `
alter table scenarios add column if not exists script jsonb;
alter table assessments add column if not exists prompt_version text;
alter table assessments add column if not exists model text;
alter table assessments add column if not exists evidence jsonb not null default '{}'::jsonb;
`,
  },
  {
    /* D8：班内分组（一个学生只在一个组里，空 = 未分组） */
    id: "026_student_groups",
    sql: `
alter table users add column if not exists group_name text;
`,
  },
  {
    /* D9 / C7：教师逐维度复核。AI 原始分另存，教师评语与 AI 评语分开 */
    id: "027_assessment_review",
    sql: `
alter table assessments add column if not exists ai_scores jsonb;
alter table assessments add column if not exists ai_total numeric;
alter table assessments add column if not exists teacher_comment text;
alter table assessments add column if not exists reviewed_by uuid references users(id) on delete set null;
alter table assessments add column if not exists reviewed_at timestamptz;
`,
  },
  {
    /* 公告已读：学生端顶栏显示过即记已读（kind = notice），教师端公告列表显示已读人数 */
    id: "028_notice_read_marks",
    sql: `
alter table read_marks drop constraint if exists read_marks_kind_check;
alter table read_marks add constraint read_marks_kind_check check (kind in ('mail','guidance','notice'));
`,
  },
  {
    /* D-32 场景配置扩充：场景沟通方式与订单状态；商品详情（多图、规格矩阵、卖点、参数、尺码表、物流、售后、FAQ） */
    id: "029_scene_library",
    sql: `
alter table scenarios add column if not exists channel text not null default 'chat';
alter table scenarios add column if not exists order_kind text;
alter table store_products add column if not exists category text;
alter table store_products add column if not exists images jsonb not null default '[]'::jsonb;
alter table store_products add column if not exists details jsonb not null default '{}'::jsonb;
alter table store_products add column if not exists source text not null default 'manual';
alter table store_products add column if not exists source_url text;
alter table store_products add column if not exists library_id text;
alter table store_products add column if not exists updated_at timestamptz not null default now();
update store_products set images = jsonb_build_array(image_url) where image_url is not null and images = '[]'::jsonb;
`,
  },
  {
    /* D-33 买家画像结构化：买家角色、决策风格、关注点、补充说明；场景适用客户价值层 */
    id: "030_persona_structure",
    sql: `
alter table persona_templates add column if not exists buyer_role text;
alter table persona_templates add column if not exists decision_style text;
alter table persona_templates add column if not exists concerns jsonb not null default '[]'::jsonb;
alter table persona_templates add column if not exists note text;
alter table scenarios add column if not exists customer_types jsonb not null default '[]'::jsonb;
`,
  },
  {
    /* 个人中心：用户头像 */
    id: "031_user_avatar",
    sql: `
alter table users add column if not exists avatar_url text;
`,
  },
  {
    /* D-36 接待生命周期：结束原因与时间（buyer_left / student_ended / timeout / abandoned / task_closed） */
    id: "032_conversation_close_reason",
    sql: `
alter table conversations add column if not exists closed_reason text;
alter table conversations add column if not exists closed_at timestamptz;
`,
  },
  {
    /* 学生端改版（C2）：客服在接待中手动做的三件事——咨询原因（系统按场景预填，学生确认或改正）、待跟进、客户备注。
       系统客户标签按订单规则实时计算，不落库；店铺资料存 app_settings.store_profile */
    id: "033_conversation_service_meta",
    sql: `
alter table conversations add column if not exists contact_reason text;
alter table conversations add column if not exists contact_reason_suggested text;
alter table conversations add column if not exists follow_up boolean not null default false;
alter table conversations add column if not exists buyer_note text;
alter table conversations add column if not exists buyer_note_at timestamptz;
`,
  },
  {
    /* 评价、邮件正文的中文译文：同一段文字只翻一次，存库长期复用（按原文 sha256 去重） */
    id: "034_text_translations",
    sql: `
create table if not exists text_translations (
  text_hash text primary key,
  source text not null,
  translation text not null,
  created_at timestamptz not null default now()
);
`,
  },
  {
    /* D-42 买家语音按语种分厂商（豆包 / 阿里云）：朗读记录带厂商，费用按厂商单价分开算 */
    id: "035_voice_metrics_vendor",
    sql: `
alter table voice_metrics add column if not exists vendor text not null default 'doubao';
`,
  },
  {
    /* 阿里云主用、豆包备用：阿里云出错单次转豆包的朗读记录 fallback = true，原因存 fallback_reason（throttled / server / timeout / network / auth / quota） */
    id: "036_voice_metrics_fallback",
    sql: `
alter table voice_metrics add column if not exists fallback boolean not null default false;
alter table voice_metrics add column if not exists fallback_reason text;
`,
  },
  {
    /* 深度思考开关（2026-10-14）：思考参数从“附加请求参数”挪到档案的 thinking 字段（开关 + 档位 + 该厂商的参数写法）。
       老档案：附加参数里写了关闭的记为关闭，写了档位的记为该档位，没写的记为“开启 + 模型默认”（什么都不发，和原来一样）；
       写法按当时的厂商模板补上（与 contracts 的 LLM_PRESETS 一致），然后从附加参数里去掉这几个字段 */
    id: "037_llm_profile_thinking",
    sql: `
alter table llm_profiles add column if not exists thinking jsonb;
update llm_profiles set
  thinking = jsonb_build_object(
    'enabled', not (
      coalesce(extra_body->>'reasoning_effort', '') = 'none'
      or coalesce(extra_body->'thinking'->>'type', '') = 'disabled'
      or coalesce(extra_body->>'enable_thinking', '') = 'false'
    ),
    'level', case when extra_body->>'reasoning_effort' in ('low', 'medium', 'high', 'max') then extra_body->>'reasoning_effort' else 'default' end,
    'params', case preset_key
      when 'deepseek' then '{"off":{"thinking":{"type":"disabled"}},"on":{"thinking":{"type":"enabled"}},"levels":{}}'::jsonb
      when 'zhipu' then '{"off":{"thinking":{"type":"disabled"}},"on":{"thinking":{"type":"enabled"}},"levels":{}}'::jsonb
      when 'ark' then '{"off":{"thinking":{"type":"disabled"}},"on":{"thinking":{"type":"enabled"}},"levels":{}}'::jsonb
      when 'qwen' then '{"off":{"enable_thinking":false},"on":{"enable_thinking":true},"levels":{}}'::jsonb
      when 'siliconflow' then '{"off":{"enable_thinking":false},"on":{"enable_thinking":true},"levels":{}}'::jsonb
      when 'kimi' then 'null'::jsonb
      when 'newapi' then '{"off":{"thinking":{"type":"disabled"},"reasoning_effort":"none"},"on":{},"levels":{"low":{"reasoning_effort":"low"},"medium":{"reasoning_effort":"medium"},"high":{"reasoning_effort":"high"},"max":{"reasoning_effort":"max"}}}'::jsonb
      else '{"off":{"reasoning_effort":"none"},"on":{},"levels":{"low":{"reasoning_effort":"low"},"medium":{"reasoning_effort":"medium"},"high":{"reasoning_effort":"high"}}}'::jsonb
    end
  ),
  extra_body = coalesce(extra_body, '{}'::jsonb) - 'thinking' - 'reasoning_effort' - 'enable_thinking'
where thinking is null;
alter table llm_profiles alter column thinking set default '{"enabled":false,"level":"default","params":null}'::jsonb;
alter table llm_profiles alter column thinking set not null;
`,
  },
  {
    /* 参数核对 · 学生端（2026-10-19）：
       - service_rating：接待结束时买家给服务打的 1–5 星（D-54），按结束时满意度换算，不是一条消息
       - tool_followup：会话结束后用订单页工具（付款提醒 / 物流通知）、买家回复后的短跟进（D-56）：
         { kind, orderId, sentAt, startedAt, studentTurns, endedAt, endReason }；跟进不评分、不出星级
       - channel：chat = 在线会话，mail = 邮件任务（D-58，邮件和评分、任务进度复用会话这套）
       - mail_submissions.conversation_id：任务邮件发出后和它的邮件会话关联 */
    id: "038_params_student",
    sql: `
alter table conversations add column if not exists service_rating smallint check (service_rating between 1 and 5);
alter table conversations add column if not exists tool_followup jsonb;
alter table conversations add column if not exists channel text not null default 'chat' check (channel in ('chat','mail'));
alter table mail_submissions add column if not exists conversation_id uuid references conversations(id) on delete set null;
`,
  },
  {
    /* D-54：已经结束的老接待按当时的满意度补上星级（和 starsFromSatisfaction 同一套分界），满意率不用从零开始 */
    id: "039_service_rating_backfill",
    sql: `
-- 已经结束的老接待按当时的满意度补上星级（和 starsFromSatisfaction 同一套分界），满意率不用从零开始
update conversations c set service_rating = case
    when coalesce((c.state->>'satisfaction')::numeric, 60) >= 85 then 5
    when coalesce((c.state->>'satisfaction')::numeric, 60) >= 70 then 4
    when coalesce((c.state->>'satisfaction')::numeric, 60) >= 45 then 3
    when coalesce((c.state->>'satisfaction')::numeric, 60) >= 25 then 2
    else 1 end
where c.status = 'closed' and c.service_rating is null and c.channel = 'chat'
  and exists (select 1 from conversation_messages m where m.conversation_id = c.id and m.sender = 'buyer');
`,
  },
  {
    /* D-66：店铺优惠券从代码里的 4 张固定券改成教师端可配置。amount：满减是美元、折扣是减百分之几；product_ids 空 = 全店，customer_types 空 = 不限 */
    id: "040_store_coupons",
    sql: `
create table if not exists store_coupons (
  id text primary key,
  title text not null,
  kind text not null check (kind in ('amount', 'percent', 'shipping')),
  amount numeric not null default 0,
  threshold numeric not null default 0,
  product_ids jsonb not null default '[]',
  customer_types jsonb not null default '[]',
  valid_days integer not null check (valid_days between 1 and 365),
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
insert into store_coupons (id, title, kind, amount, threshold, customer_types, valid_days, created_at) values
  ('CPN-001', 'New Customer $5 Off', 'amount', 5, 30, '["潜在意向客"]', 7, now() - interval '4 seconds'),
  ('CPN-002', '10% Off Storewide', 'percent', 10, 0, '[]', 3, now() - interval '3 seconds'),
  ('CPN-003', 'Free Shipping', 'shipping', 0, 20, '[]', 15, now() - interval '2 seconds'),
  ('CPN-004', 'Loyal Buyer $8 Off', 'amount', 8, 50, '["复购老客"]', 30, now() - interval '1 seconds')
on conflict (id) do nothing;
`,
  },
  {
    /* D-78：账号不区分大小写。管理端和教师端都能导入学生，S2024001 和 s2024001 不能成为两个账号；登录按小写比对。
       原样保存（显示用），唯一性按 lower(username) */
    id: "041_username_case_insensitive",
    sql: `
create unique index if not exists users_username_lower_key on users (lower(username));
`,
  },
  {
    /* L1 后台任务补漏：assess_attempts = 自动评分跑过几次（每次含进程内重试），定时补漏只补不到 3 次的；
       review_done_at = 买家留评跑完（写了评价或判断不用写）。老会话一律算跑完，补漏只管上线之后结束的 */
    id: "042_background_retry",
    sql: `
alter table conversations add column if not exists assess_attempts smallint not null default 0;
alter table conversations add column if not exists review_done_at timestamptz;
update conversations set review_done_at = coalesce(closed_at, now()) where status = 'closed' and review_done_at is null;
`,
  },
  {
    /* D-90 买家的两本账：来办的事（items）、还能忍几次（patience）、每轮判断（judgements）、怎么走的（exit）。
       结构见 domain 的 buyer-ledger.ts；老会话为空，第一次轮到买家说话时补 */
    id: "043_buyer_ledger",
    sql: `
alter table conversations add column if not exists buyer_ledger jsonb;
`,
  },
  {
    /* D-90 买家每条开头那段判断，存在这一轮的第一条买家消息上：下一轮给买家看聊天时原样放回去，
       不然买家照着自己前面不带判断的消息学，第二条起就不写了（评测 2026-10-22）。只给买家提示词用，接口不返回 */
    id: "044_buyer_note",
    sql: `
alter table conversation_messages add column if not exists buyer_note text;
`,
  },
  {
    /* 刷新令牌续期宽限：rotated_at = 这张是续期时被换掉的（不是登出、改密、停用作废的）。
       换掉后 60 秒内再拿来续期照样放行：续期的响应丢了（断网、页面被关）、两个页签同时续期时，后到的那个不会被踢回登录页 */
    id: "045_refresh_reuse_grace",
    sql: `
alter table refresh_tokens add column if not exists rotated_at timestamptz;
`,
  },
];
