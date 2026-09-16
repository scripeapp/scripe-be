-- Ensure comment likes are idempotent and can't create duplicates.
-- comment_likes uses (user_id, post_id) where post_id references comments.id (legacy naming).

alter table public.comment_likes
add constraint comment_likes_user_id_post_id_key unique (user_id, post_id);

create index if not exists comment_likes_user_id_post_id_idx
  on public.comment_likes using btree (user_id, post_id);

