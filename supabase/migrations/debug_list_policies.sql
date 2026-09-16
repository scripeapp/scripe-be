-- RUN THIS IN SUPABASE SQL EDITOR TO SEE ALL POLICIES ON SESSIONS TABLE

SELECT 
  policyname,
  cmd as operation,
  qual as using_clause,
  with_check as with_check_clause
FROM pg_policies 
WHERE tablename = 'sessions'
ORDER BY policyname;
