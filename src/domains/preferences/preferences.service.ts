import type { Database } from "../../db/database.types.js";
import { withDatabaseContext, type DatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { withIdentity } from "../../db/principal.js";
import { AppError, notFoundError } from "../../shared/errors.js";
import * as repository from "./preferences.repository.js";
import type { Preferences, PreferencesOperation } from "./preferences.types.js";

export class PreferencesService {
  constructor(private readonly database: Database) {}

  async get(operation: PreferencesOperation): Promise<Preferences> {
    return this.run(operation, (context) => repository.getPreferences(context, operation.userId));
  }

  async update(operation: PreferencesOperation, patch: Preferences): Promise<Preferences> {
    return this.run(operation, async (context) => {
      const updated = await repository.mergePreferences(context, operation.userId, patch);
      if (!updated) throw notFoundError("Profile not found");
      return updated;
    });
  }

  private async run<T>(operation: PreferencesOperation, work: (context: DatabaseContext) => Promise<T>): Promise<T> {
    try {
      return await withDatabaseContext(this.database, withIdentity(operation.requestId, operation.userId, null), work);
    } catch (error) {
      if (error instanceof AppError || error instanceof DatabaseError) throw error;
      throw normalizeDatabaseError(error);
    }
  }
}
