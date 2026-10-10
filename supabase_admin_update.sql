-- ============================================================
-- DOCE CUSTO - ATUALIZAÇÃO DO ADMIN
-- Execute no Supabase > SQL Editor
-- ============================================================
-- Adiciona ao dashboard:
-- 1) crescimento acumulado de usuários por mês (12 meses)
-- 2) mantém as métricas existentes
-- A lista de usuários é carregada diretamente de public.profiles;
-- admins já possuem permissão SELECT sobre todos os perfis.
-- ============================================================

create or replace function public.admin_dashboard_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if not (select public.is_admin()) then
    raise exception 'Acesso negado: administrador necessário';
  end if;

  select jsonb_build_object(
    'total_users',
      (select count(*) from public.profiles),

    'users_last_7_days',
      (select count(*)
       from public.profiles
       where created_at >= now() - interval '7 days'),

    'users_last_30_days',
      (select count(*)
       from public.profiles
       where created_at >= now() - interval '30 days'),

    'total_recipes',
      coalesce((
        select sum(
          case
            when jsonb_typeof(ud.data->'receitas') = 'array'
              then jsonb_array_length(ud.data->'receitas')
            else 0
          end
        )
        from public.user_data ud
      ), 0),

    'total_ingredients',
      coalesce((
        select sum(
          case
            when jsonb_typeof(ud.data->'insumos') = 'array'
              then jsonb_array_length(ud.data->'insumos')
            else 0
          end
        )
        from public.user_data ud
      ), 0),

    'total_products',
      coalesce((
        select sum(
          case
            when jsonb_typeof(ud.data->'produtos') = 'array'
              then jsonb_array_length(ud.data->'produtos')
            else 0
          end
        )
        from public.user_data ud
      ), 0),

    'users_with_data',
      (select count(*) from public.user_data),

    'data_updated_last_7_days',
      (select count(*)
       from public.user_data
       where updated_at >= now() - interval '7 days'),

    'user_growth',
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'label', to_char(month_start, 'Mon/YY'),
            'total', (
              select count(*)
              from public.profiles p
              where p.created_at < month_start + interval '1 month'
            )
          )
          order by month_start
        )
        from generate_series(
          date_trunc('month', now()) - interval '11 months',
          date_trunc('month', now()),
          interval '1 month'
        ) as month_start
      ), '[]'::jsonb)
  )
  into result;

  return result;
end;
$$;

revoke all on function public.admin_dashboard_stats() from public, anon;
grant execute on function public.admin_dashboard_stats() to authenticated;

-- ============================================================
-- VERIFICAÇÃO OPCIONAL
-- ============================================================
-- Logado como ADMIN no SQL Editor, execute:
-- select public.admin_dashboard_stats();
--
-- Procure pela propriedade "user_growth".
-- ============================================================
