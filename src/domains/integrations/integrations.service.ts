import type { Database } from "../../db/database.types.js";
import { withDatabaseContext, type DatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { withIdentity } from "../../db/principal.js";
import { disconnectGoogleCalendar, findGoogleCalendarAccount, GOOGLE_CALENDAR_SCOPES } from "../../integrations/google-calendar.js";
import { AppError } from "../../shared/errors.js";
import { loadEnvironment } from "../../shared/environment.js";
import * as repository from "./integrations.repository.js";
import type { GoogleCalendarStatus, IntegrationsOperation } from "./integrations.types.js";

export class IntegrationsService {
  constructor(private readonly database: Database) {}

  async googleCalendarStatus(operation: IntegrationsOperation): Promise<GoogleCalendarStatus> {
    const environment = loadEnvironment();
    const [account, meetEnabled] = await Promise.all([
      findGoogleCalendarAccount(operation.userId),
      this.run(operation, (context) => repository.findMeetEnabled(context, operation.userId)),
    ]);
    return {
      available: Boolean(environment.GOOGLE_CLIENT_ID && environment.GOOGLE_CLIENT_SECRET),
      connected: account !== null,
      email: account?.email ?? null,
      meetEnabled,
      scopes: GOOGLE_CALENDAR_SCOPES,
    };
  }

  async setMeetEnabled(operation: IntegrationsOperation, meetEnabled: boolean): Promise<GoogleCalendarStatus> {
    await this.run(operation, (context) => repository.saveMeetEnabled(context, operation.userId, meetEnabled));
    return this.googleCalendarStatus(operation);
  }

  async disconnectGoogleCalendar(operation: IntegrationsOperation): Promise<GoogleCalendarStatus> {
    await disconnectGoogleCalendar(operation.userId);
    return this.googleCalendarStatus(operation);
  }

  private async run<T>(operation: IntegrationsOperation, work: (context: DatabaseContext) => Promise<T>): Promise<T> {
    try {
      return await withDatabaseContext(this.database, withIdentity(operation.requestId, operation.userId, null), work);
    } catch (error) {
      if (error instanceof AppError || error instanceof DatabaseError) throw error;
      throw normalizeDatabaseError(error);
    }
  }
}
