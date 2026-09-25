-- 0005_app_user_profiles_rich_fields.down.sql
-- Reverts 0005. Runs as scripe_migrator.

drop index if exists app.user_profiles_username_lower_key;

alter table app.user_profiles
    drop column if exists "firstName",
    drop column if exists "lastName",
    drop column if exists "username",
    drop column if exists "bio",
    drop column if exists "website",
    drop column if exists "location",
    drop column if exists "phoneNumber",
    drop column if exists "gender",
    drop column if exists "socialLinks",
    drop column if exists "accountStatus",
    drop column if exists "accountType",
    drop column if exists "preferences";
