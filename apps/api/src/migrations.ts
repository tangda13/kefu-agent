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
];
