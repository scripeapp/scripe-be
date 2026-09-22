drop function if exists app.get_confirmed_avatar_object_key(uuid);

alter table app.user_profiles
    drop column if exists "avatarUploadId";
