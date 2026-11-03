create table public.test_progress (
    user_id uuid not null references auth.users(id) on delete cascade,
    test_id integer not null check (test_id between 1 and 60),
    passed_attempts integer not null default 0 check (passed_attempts >= 0),
    failed_attempts integer not null default 0 check (failed_attempts >= 0),
    wrong_answers integer not null default 0 check (wrong_answers >= 0),
    last_result text check (last_result in ('passed', 'failed')),
    active_attempt jsonb,
    updated_at timestamptz not null default now(),
    primary key (user_id, test_id)
);

alter table public.test_progress enable row level security;

grant select, insert, update, delete on public.test_progress to authenticated;

create policy "Users can manage their own test progress"
    on public.test_progress
    for all
    to authenticated
    using ((select auth.uid()) = user_id)
    with check ((select auth.uid()) = user_id);
