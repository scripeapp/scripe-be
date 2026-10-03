-- Notification preferences are honoured when sending, not just stored.
-- Preferences are kept per category ("sales", "deposits", "team") and
-- channel ("email", "in_app"); no row means on. Senders often run without
-- a signed-in user (webhooks), where the own-rows RLS policy hides every
-- preference, so these definer functions answer the one yes/no question.

create function app.notification_enabled(target_user_id uuid, target_category text, target_channel text)
returns boolean
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select coalesce(
    (select p."enabled" from app.notification_preferences p
      where p."userId" = target_user_id and p."type" = target_category and p."channel" = target_channel),
    true
  );
$$;

revoke all on function app.notification_enabled(uuid, text, text) from public;
grant execute on function app.notification_enabled(uuid, text, text) to scripe_app;

-- For emails addressed by address only (e.g. a deposit alert to the banking
-- notification email). An address that is no user's always receives it.
create function app.notification_enabled_for_email(target_email text, target_category text, target_channel text)
returns boolean
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select coalesce(
    (select bool_and(p."enabled")
      from auth."user" u
      join app.notification_preferences p on p."userId" = u."id"
      where lower(u."email") = lower(target_email) and p."type" = target_category and p."channel" = target_channel),
    true
  );
$$;

revoke all on function app.notification_enabled_for_email(text, text, text) from public;
grant execute on function app.notification_enabled_for_email(text, text, text) to scripe_app;
