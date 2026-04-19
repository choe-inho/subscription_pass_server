-- ================================================================
-- 청약핏 DB 스키마 v1.2
-- 변경 내역
--   v1.1 → v1.2
--   · announcement_cutoffs 테이블 추가
--     (공고별 가점 커트라인 — APT_SCORE API 수집 데이터)
--   · housing_types unique 제약 명시
--   · 전체 DROP 순서 정리 (의존성 역순)
-- ================================================================

-- ─────────────────────────────────────────
-- 0. 기존 테이블 전체 초기화 (의존성 역순)
-- ⚠️  주의: 기존 데이터 전체 삭제됨
-- ─────────────────────────────────────────

drop view     if exists user_subscription_status;
drop type     if exists notification_type cascade;

drop table if exists notifications          cascade;
drop table if exists subscriptions          cascade;
drop table if exists user_interests         cascade;
drop table if exists announcement_cutoffs   cascade;  -- v1.2 추가
drop table if exists historical_cutoffs     cascade;
drop table if exists competition_rates      cascade;
drop table if exists housing_types          cascade;
drop table if exists announcements          cascade;
drop table if exists user_profiles          cascade;

drop function if exists update_announcement_status();

-- ─────────────────────────────────────────
-- 1. 유저 프로필 (가점 + FCM 토큰)
-- ─────────────────────────────────────────

create table user_profiles (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid references auth.users(id) on delete cascade unique,

  subscription_months  int  default 0,
  payment_count        int  default 0,
  homeless_months      int  default 0,
  dependent_count      int  default 0,
  is_head_of_household bool default false,

  -- 청약가점 자동 계산 (저장형 Generated Column)
  calculated_score int generated always as (
    least(floor(homeless_months / 12.0)::int, 15) * 2   -- 무주택기간 (최대 32점)
    + least(dependent_count, 6) * 5                      -- 부양가족 (최대 35점)
    + least(floor(subscription_months / 12.0)::int, 15) -- 청약통장 (최대 17점)
    + 2
  ) stored,

  interest_regions     text[]  default '{}',
  fcm_token            text,
  notification_preferences jsonb default '{
    "push_enabled":      true,
    "subscription_alert": true,
    "winner_alert":       true,
    "competition_alert":  false,
    "marketing_alert":    false
  }'::jsonb,
  updated_at           timestamp default now()
);

alter table user_profiles enable row level security;
create policy "user_profiles_self_only"
  on user_profiles for all
  using (auth.uid() = user_id);

-- ─────────────────────────────────────────
-- 2. 청약 공고
-- ─────────────────────────────────────────

create table announcements (
  id                 uuid primary key default gen_random_uuid(),
  announcement_no    text unique not null,
  house_name         text not null,
  region_name        text not null,
  district_name      text,
  address            text,
  house_type         text,                              -- 민영 / 국민
  supply_type        text,                              -- APT / 오피스텔 등
  announcement_date  date,
  subscription_start date,
  subscription_end   date,
  winner_date        date,
  contract_start     date,
  total_supply       int     default 0,
  status             text    default 'upcoming'
                     check (status in ('upcoming', 'open', 'closed', 'announced')),
  source_url         text,
  synced_at          timestamp default now(),
  created_at         timestamp default now()
);

create index idx_announcements_status      on announcements(status);
create index idx_announcements_region      on announcements(region_name, district_name);
create index idx_announcements_sub_start   on announcements(subscription_start);
create index idx_announcements_winner_date on announcements(winner_date);

-- ─────────────────────────────────────────
-- 3. 주택형별 정보
-- ─────────────────────────────────────────

create table housing_types (
  id                   uuid primary key default gen_random_uuid(),
  announcement_id      uuid references announcements(id) on delete cascade,
  type_name            text not null,                   -- 59A, 84B 등
  exclusive_area       numeric(6,2),                    -- 전용면적 (㎡)
  supply_area          numeric(6,2),                    -- 공급면적 (㎡)
  supply_count         int default 0,                   -- 일반공급 세대수
  special_supply_count int default 0,                   -- 특별공급 세대수
  sale_price_min       int,                             -- 분양가 최저 (만원)
  sale_price_max       int,                             -- 분양가 최고 (만원)
  sale_price_avg       int,                             -- 분양가 평균 (만원)

  unique (announcement_id, type_name)
);

create index idx_housing_types_announcement on housing_types(announcement_id);

-- ─────────────────────────────────────────
-- 4. 경쟁률
-- ─────────────────────────────────────────

create table competition_rates (
  id               uuid primary key default gen_random_uuid(),
  announcement_id  uuid references announcements(id) on delete cascade,
  housing_type_id  uuid references housing_types(id)   on delete set null,
  general_rate     numeric(8,2) default 0,              -- 일반공급 경쟁률
  special_rate     numeric(8,2) default 0,              -- 특별공급 경쟁률
  applicant_count  int          default 0,              -- 총 신청자 수
  recorded_at      timestamp    default now()
);

create index idx_competition_announcement
  on competition_rates(announcement_id, recorded_at desc);

-- ─────────────────────────────────────────
-- 5. 과거 커트라인 — 지역·연도별 통계 집계
--    (API: ApplyhomeStatSvc — 지역별 당첨자 통계)
-- ─────────────────────────────────────────

create table historical_cutoffs (
  id            uuid primary key default gen_random_uuid(),
  region_name   text not null,
  district_name text,
  house_type    text not null,                          -- 민영 / 국민
  area_range    text not null,                          -- 면적 구간 (예: 60㎡ 이하)
  year          int  not null,
  min_score     int,
  avg_score     int,
  max_score     int,
  cutoff_score  int,                                    -- 대표 커트라인 (최저점 기준)
  sample_count  int default 0,

  unique (region_name, house_type, area_range, year)
);

create index idx_cutoffs_lookup
  on historical_cutoffs(region_name, house_type, area_range, year desc);

-- ─────────────────────────────────────────
-- 6. 공고별 가점 커트라인 (v1.2 신규)
--    (API: ApplyhomeInfoCmpetRtSvc/getAptLttotPblancScore)
--    당첨자 발표 이후 주택형·거주구분별 최저/최고/평균 가점
-- ─────────────────────────────────────────

create table announcement_cutoffs (
  id               uuid primary key default gen_random_uuid(),
  announcement_id  uuid not null references announcements(id) on delete cascade,

  housing_type     text not null,                       -- 주택형 (59A, 84B 등)
  reside_type      text not null default '전체',        -- 거주자 / 기타경기 / 기타지역 / 전체

  supply_count     int          not null default 0,     -- 공급세대수
  winner_count     int          not null default 0,     -- 당첨자수
  min_score        int,                                  -- 최저 당첨가점
  max_score        int,                                  -- 최고 당첨가점
  avg_score        numeric(5,2),                         -- 평균 당첨가점
  collected_at     timestamptz  not null default now(),

  -- upsert 기준: 공고 × 주택형 × 거주구분 조합 유일
  unique (announcement_id, housing_type, reside_type)
);

create index idx_announcement_cutoffs_announcement_id
  on announcement_cutoffs(announcement_id);

create index idx_announcement_cutoffs_min_score
  on announcement_cutoffs(min_score);

alter table announcement_cutoffs enable row level security;

create policy "announcement_cutoffs_public_read"
  on announcement_cutoffs for select
  using (true);

create policy "announcement_cutoffs_service_write"
  on announcement_cutoffs for all
  to service_role
  using (true)
  with check (true);

-- ─────────────────────────────────────────
-- 7. 관심 단지
-- ─────────────────────────────────────────

create table user_interests (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid references auth.users(id)       on delete cascade,
  announcement_id  uuid references announcements(id)    on delete cascade,
  housing_type_id  uuid references housing_types(id)    on delete set null,
  notify_enabled   bool default true,
  created_at       timestamp default now(),

  unique (user_id, announcement_id, housing_type_id)
);

alter table user_interests enable row level security;
create policy "user_interests_self_only"
  on user_interests for all
  using (auth.uid() = user_id);

create index idx_interests_user     on user_interests(user_id);
create index idx_interests_announce on user_interests(announcement_id);

-- ─────────────────────────────────────────
-- 8. 알림 이력
-- ─────────────────────────────────────────

create type notification_type as enum (
  'announcement',
  'sub_start',
  'sub_end',
  'winner',
  'competition'
);

create table notifications (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid references auth.users(id)       on delete cascade,
  announcement_id  uuid references announcements(id)    on delete set null,
  type             notification_type not null,
  title            text not null,
  body             text,
  is_read          bool default false,
  sent_at          timestamp default now()
);

alter table notifications enable row level security;
create policy "notifications_self_read"
  on notifications for select
  using (auth.uid() = user_id);

create index idx_notifications_user_unread
  on notifications(user_id, is_read, sent_at desc);

-- ─────────────────────────────────────────
-- 9. 구독 정보
-- ─────────────────────────────────────────

create table subscriptions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references auth.users(id) on delete cascade unique,
  plan            text default 'free' check (plan in ('free', 'pro')),
  platform        text check (platform in ('ios', 'android', null)),
  revenue_cat_id  text unique,
  started_at      timestamp,
  expires_at      timestamp,
  is_active       bool default false,
  updated_at      timestamp default now()
);

alter table subscriptions enable row level security;
create policy "subscriptions_self_read"
  on subscriptions for select
  using (auth.uid() = user_id);

-- ─────────────────────────────────────────
-- 10. 공고 상태 자동 갱신 함수
-- ─────────────────────────────────────────

create or replace function update_announcement_status()
returns void as $$
begin
  update announcements set status =
    case
      when subscription_start > current_date                                          then 'upcoming'
      when subscription_start <= current_date and subscription_end >= current_date    then 'open'
      when subscription_end   <  current_date
       and (winner_date is null or winner_date >= current_date)                       then 'closed'
      else 'announced'
    end;
end;
$$ language plpgsql;

-- pg_cron 활성화 후 주석 해제
-- select cron.schedule('update-status', '0 0 * * *', 'select update_announcement_status()');

-- ─────────────────────────────────────────
-- 11. 유저 구독 상태 뷰
-- ─────────────────────────────────────────

create or replace view user_subscription_status as
select
  up.user_id,
  up.fcm_token,
  up.interest_regions,
  up.calculated_score,
  up.notification_preferences,
  coalesce(s.plan,      'free')  as plan,
  -- ─────────────────────────────────────────────────────────
  -- v1.0 무료 + 리워드 광고 모델 전환:
  -- 모든 유저를 Pro로 간주 → D-1 사전 알림/경쟁률 급등 알림 등
  -- 서버측 Pro 게이팅을 무력화하고 유저 토글만 기준으로 발송.
  --
  -- · 결제/RevenueCat 흐름은 앱 레벨 kProFeatureEnabled=false 로 차단
  -- · 이 뷰는 알림 발송 필터에만 사용되므로 결제 경로에 영향 없음
  -- · v1.2 에서 유료 Pro 재오픈 시 아래 원복 블록을 활성화하면 됨
  -- ─────────────────────────────────────────────────────────
  true                            as is_pro,
  -- 원복(v1.2): 위 true 를 삭제하고 아래 블록으로 교체
  -- coalesce(
  --   s.is_active = true
  --   and s.plan = 'pro'
  --   and (s.expires_at is null or s.expires_at > now()),
  --   false
  -- ) as is_pro,
  s.expires_at
from user_profiles up
left join subscriptions s
  on  s.user_id   = up.user_id
  and s.is_active = true
  and s.plan      = 'pro'
  -- 만료된 구독은 조인에서 제외 (뷰 레벨 1차 필터)
  and (s.expires_at is null or s.expires_at > now());
