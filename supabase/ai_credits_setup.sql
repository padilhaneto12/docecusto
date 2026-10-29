-- DOCE CUSTO — Créditos compartilhados de IA (imagem + áudio)
-- Execute UMA vez em Supabase > SQL Editor. Revise o resultado antes de publicar as Edge Functions.

create table if not exists public.ai_credit_balances (
  user_id uuid primary key references auth.users(id) on delete cascade,
  balance integer not null default 0 check (balance >= 0),
  initial_grant boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ai_credit_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  amount integer not null,
  operation text not null,
  reason text,
  related_transaction_id uuid references public.ai_credit_transactions(id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ai_credit_transactions_user_created_idx
  on public.ai_credit_transactions(user_id, created_at desc);

alter table public.ai_credit_balances enable row level security;
alter table public.ai_credit_transactions enable row level security;

drop policy if exists "Users can read own AI credit balance" on public.ai_credit_balances;
create policy "Users can read own AI credit balance"
  on public.ai_credit_balances for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists "Users and admins can read AI credit transactions" on public.ai_credit_transactions;
create policy "Users and admins can read AI credit transactions"
  on public.ai_credit_transactions for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

revoke insert, update, delete on public.ai_credit_balances from anon, authenticated;
revoke insert, update, delete on public.ai_credit_transactions from anon, authenticated;
grant select on public.ai_credit_balances, public.ai_credit_transactions to authenticated;

-- Garante 20 créditos gratuitos para contas já existentes que ainda não receberam saldo.
do $$
declare u record;
begin
  for u in select id from auth.users loop
    insert into public.ai_credit_balances(user_id, balance, initial_grant)
    values (u.id, 20, true)
    on conflict (user_id) do nothing;

    if found then
      insert into public.ai_credit_transactions(user_id, amount, operation, reason, metadata)
      values (u.id, 20, 'welcome_grant', '20 créditos iniciais', '{"source":"migration"}'::jsonb);
    end if;
  end loop;
end $$;

-- Novas contas recebem os mesmos 20 créditos apenas uma vez.
create or replace function public.grant_initial_ai_credits()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.ai_credit_balances(user_id, balance, initial_grant)
  values (new.id, 20, true)
  on conflict (user_id) do nothing;

  if found then
    insert into public.ai_credit_transactions(user_id, amount, operation, reason, metadata)
    values (new.id, 20, 'welcome_grant', '20 créditos iniciais', '{"source":"signup_trigger"}'::jsonb);
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_ai_credits on auth.users;
create trigger on_auth_user_created_ai_credits
  after insert on auth.users
  for each row execute function public.grant_initial_ai_credits();

-- RPC usada somente pelas Edge Functions com SUPABASE_SERVICE_ROLE_KEY.
create or replace function public.consume_ai_credit(p_user_id uuid, p_operation text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare new_balance integer; txn_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Acesso negado';
  end if;
  if p_operation not in ('image', 'audio') then
    raise exception 'Operação inválida';
  end if;

  insert into public.ai_credit_balances(user_id, balance, initial_grant)
  values (p_user_id, 0, false)
  on conflict (user_id) do nothing;

  update public.ai_credit_balances
     set balance = balance - 1, updated_at = now()
   where user_id = p_user_id and balance > 0
   returning balance into new_balance;

  if new_balance is null then
    return jsonb_build_object('ok', false, 'balance', 0);
  end if;

  insert into public.ai_credit_transactions(user_id, amount, operation, reason)
  values (p_user_id, -1, 'consume_' || p_operation, 'Uso de IA por ' || case when p_operation='image' then 'imagem' else 'áudio' end)
  returning id into txn_id;

  return jsonb_build_object('ok', true, 'balance', new_balance, 'transaction_id', txn_id);
end;
$$;

create or replace function public.refund_ai_credit(p_user_id uuid, p_transaction_id uuid, p_reason text default 'Falha técnica; crédito devolvido')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare original public.ai_credit_transactions%rowtype; new_balance integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Acesso negado';
  end if;

  select * into original
    from public.ai_credit_transactions
   where id = p_transaction_id and user_id = p_user_id and amount = -1
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'message', 'Transação não encontrada');
  end if;

  if exists (select 1 from public.ai_credit_transactions where related_transaction_id = p_transaction_id and operation = 'refund') then
    select balance into new_balance from public.ai_credit_balances where user_id = p_user_id;
    return jsonb_build_object('ok', true, 'already_refunded', true, 'balance', new_balance);
  end if;

  update public.ai_credit_balances
     set balance = balance + 1, updated_at = now()
   where user_id = p_user_id
   returning balance into new_balance;

  insert into public.ai_credit_transactions(user_id, amount, operation, reason, related_transaction_id)
  values (p_user_id, 1, 'refund', left(coalesce(p_reason, 'Falha técnica; crédito devolvido'), 240), p_transaction_id);

  return jsonb_build_object('ok', true, 'balance', new_balance);
end;
$$;

create or replace function public.record_ai_credit_usage(
  p_transaction_id uuid, p_input_tokens integer default null,
  p_output_tokens integer default null, p_model text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Acesso negado';
  end if;
  update public.ai_credit_transactions
     set metadata = metadata || jsonb_strip_nulls(jsonb_build_object(
       'input_tokens', p_input_tokens,
       'output_tokens', p_output_tokens,
       'model', p_model
     ))
   where id = p_transaction_id;
end;
$$;

-- Painel admin: quantidade positiva adiciona, negativa remove. Não permite saldo negativo.
create or replace function public.admin_adjust_ai_credits(
  p_user_id uuid, p_amount integer, p_reason text default 'Ajuste manual pelo painel admin'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare new_balance integer;
begin
  if not public.is_admin() then
    raise exception 'Acesso restrito ao administrador';
  end if;
  if p_amount is null or p_amount = 0 or abs(p_amount) > 10000 then
    raise exception 'Informe uma quantidade entre -10000 e 10000, diferente de zero';
  end if;

  insert into public.ai_credit_balances(user_id, balance, initial_grant)
  values (p_user_id, 0, false)
  on conflict (user_id) do nothing;

  update public.ai_credit_balances
     set balance = balance + p_amount, updated_at = now()
   where user_id = p_user_id and balance + p_amount >= 0
   returning balance into new_balance;

  if new_balance is null then
    raise exception 'O saldo não pode ficar negativo';
  end if;

  insert into public.ai_credit_transactions(user_id, amount, operation, reason)
  values (p_user_id, p_amount, 'admin_adjustment', left(coalesce(p_reason, 'Ajuste manual pelo painel admin'), 240));

  return jsonb_build_object('ok', true, 'balance', new_balance);
end;
$$;

revoke all on function public.consume_ai_credit(uuid, text) from public, anon, authenticated;
revoke all on function public.refund_ai_credit(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.record_ai_credit_usage(uuid, integer, integer, text) from public, anon, authenticated;
grant execute on function public.consume_ai_credit(uuid, text) to service_role;
grant execute on function public.refund_ai_credit(uuid, uuid, text) to service_role;
grant execute on function public.record_ai_credit_usage(uuid, integer, integer, text) to service_role;

revoke all on function public.admin_adjust_ai_credits(uuid, integer, text) from public, anon;
grant execute on function public.admin_adjust_ai_credits(uuid, integer, text) to authenticated;
