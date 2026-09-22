import { sql } from "kysely";
import type { Database, DatabaseTransaction } from "./database.types.js";
import type { Principal } from "./principal.js";

export interface DatabaseContext {
  readonly transaction: DatabaseTransaction;
  readonly principal: Principal;
}

async function applyRlsContext(
  transaction: DatabaseTransaction,
  principal: Principal,
): Promise<void> {
  await sql`
    select
      set_config('app.user_id', ${principal.userId}, true),
      set_config('app.business_id', ${principal.businessId}, true),
      set_config('app.request_id', ${principal.requestId}, true)
  `.execute(transaction);
}

/**
 * Runs `work` inside a transactional executor whose statements carry the
 * principal's identity via transaction-local config. Services own the
 * transaction boundary; repositories receive a DatabaseContext and never
 * touch the global pool.
 */
export async function withDatabaseContext<T>(
  database: Database,
  principal: Principal,
  work: (context: DatabaseContext) => Promise<T>,
): Promise<T> {
  return database.transaction().execute(async (transaction) => {
    await applyRlsContext(transaction, principal);
    const context: DatabaseContext = {
      transaction,
      principal,
    };
    return work(context);
  });
}

export type { DatabaseTransaction };