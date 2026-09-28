-- Intentionally a no-op. The branches this backfilled are ordinary branches
-- from the moment they exist: stock, prices, delivery zones, staff schedules
-- and registers can reference them, and businesses may have renamed them or
-- filled in their address. Nothing distinguishes an untouched backfilled
-- branch from one a business relies on, so deleting them on rollback would
-- risk real data. Remove any unwanted ones through the app instead.
select 1;
