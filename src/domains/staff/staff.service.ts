import type { Database } from "../../db/database.types.js";
import { withDatabaseContext } from "../../db/database-context.js";
import type { DatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { withIdentity } from "../../db/principal.js";
import { AppError, notFoundError, validationError } from "../../shared/errors.js";
import * as authorization from "../authorization/authorization.service.js";
import * as authorizationRepository from "../authorization/authorization.repository.js";
import * as repository from "./staff.repository.js";
import type { CreateExceptionInput, CreateStaffInput, SetStaffScheduleInput, SetStaffServicesInput, UpdateStaffInput } from "./staff.schemas.js";
import type { CommissionReportRow, ScheduleException, ScheduleExceptionRow, StaffCommissionReport, StaffMember, StaffOperation, StaffProfileRow, StaffScheduleRow, StaffServiceRow } from "./staff.types.js";

const READ = "team.read";
const MANAGE = "team.manage";

export class StaffService {
  constructor(private readonly database: Database) {}

  async list(operation: StaffOperation): Promise<StaffMember[]> {
    return this.run(operation, async (context) => {
      await authorization.requirePermission(context, operation.businessId, READ);
      const profiles = await repository.listProfiles(context, operation.businessId);
      const staffIds = profiles.map((profile) => profile.id);
      const [services, schedule] = await Promise.all([
        repository.listServices(context, operation.businessId, staffIds),
        repository.listSchedule(context, operation.businessId, staffIds),
      ]);
      return profiles.map((profile) => toStaffMember(profile, services, schedule));
    });
  }

  async create(operation: StaffOperation, input: CreateStaffInput): Promise<StaffMember> {
    return this.run(operation, async (context) => {
      await authorization.requirePermission(context, operation.businessId, MANAGE);
      const profile = await repository.createProfile(context, operation.businessId, input);
      return toStaffMember(profile, [], []);
    });
  }

  async update(operation: StaffOperation, staffId: string, input: UpdateStaffInput): Promise<StaffMember> {
    return this.run(operation, async (context) => {
      await authorization.requirePermission(context, operation.businessId, MANAGE);
      const updated = await repository.updateProfile(context, operation.businessId, staffId, input);
      if (!updated) throw notFoundError("Staff member not found");
      return this.hydrate(context, operation.businessId, updated);
    });
  }

  async remove(operation: StaffOperation, staffId: string): Promise<void> {
    return this.run(operation, async (context) => {
      await authorization.requirePermission(context, operation.businessId, MANAGE);
      const removed = await repository.deleteProfile(context, operation.businessId, staffId);
      if (!removed) throw notFoundError("Staff member not found");
    });
  }

  async setServices(operation: StaffOperation, staffId: string, input: SetStaffServicesInput): Promise<StaffMember> {
    return this.run(operation, async (context) => {
      await authorization.requirePermission(context, operation.businessId, MANAGE);
      const profile = await this.requireProfile(context, operation.businessId, staffId);
      await this.ensureProductsOwned(context, operation.businessId, input.services.map((service) => service.productId));
      await repository.replaceServices(context, operation.businessId, staffId, input);
      return this.hydrate(context, operation.businessId, profile);
    });
  }

  async setSchedule(operation: StaffOperation, staffId: string, input: SetStaffScheduleInput): Promise<StaffMember> {
    return this.run(operation, async (context) => {
      await authorization.requirePermission(context, operation.businessId, MANAGE);
      const profile = await this.requireProfile(context, operation.businessId, staffId);
      await this.ensureLocationsOwned(context, operation.businessId, input.entries.map((entry) => entry.locationId));
      await repository.replaceSchedule(context, operation.businessId, staffId, input);
      return this.hydrate(context, operation.businessId, profile);
    });
  }

  async listExceptions(operation: StaffOperation, staffId?: string): Promise<ScheduleException[]> {
    return this.run(operation, async (context) => {
      await authorization.requirePermission(context, operation.businessId, READ);
      if (staffId) await this.requireProfile(context, operation.businessId, staffId);
      return (await repository.listExceptions(context, operation.businessId, staffId)).map(toException);
    });
  }

  async createException(operation: StaffOperation, input: CreateExceptionInput): Promise<ScheduleException> {
    return this.run(operation, async (context) => {
      await authorization.requirePermission(context, operation.businessId, MANAGE);
      if (input.staffId) await this.requireProfile(context, operation.businessId, input.staffId);
      if (input.locationId) await this.ensureLocationsOwned(context, operation.businessId, [input.locationId]);
      return toException(await repository.createException(context, operation.businessId, input));
    });
  }

  async removeException(operation: StaffOperation, exceptionId: string): Promise<void> {
    return this.run(operation, async (context) => {
      await authorization.requirePermission(context, operation.businessId, MANAGE);
      const removed = await repository.deleteException(context, operation.businessId, exceptionId);
      if (!removed) throw notFoundError("Schedule exception not found");
    });
  }

  async commissionReport(operation: StaffOperation, from: string, to: string): Promise<StaffCommissionReport[]> {
    return this.run(operation, async (context) => {
      await authorization.requirePermission(context, operation.businessId, READ);
      const rows = await repository.commissionReport(context, operation.businessId, new Date(from), new Date(to));
      return rows.map(toCommissionReport);
    });
  }

  private async requireProfile(context: DatabaseContext, businessId: string, staffId: string): Promise<StaffProfileRow> {
    const profile = await repository.findProfile(context, businessId, staffId);
    if (!profile) throw notFoundError("Staff member not found");
    return profile;
  }

  private async ensureProductsOwned(context: DatabaseContext, businessId: string, productIds: string[]): Promise<void> {
    const unique = [...new Set(productIds)];
    if ((await repository.countOwnedProducts(context, businessId, unique)) !== unique.length) {
      throw validationError("Every service must reference a product in this business");
    }
  }

  private async ensureLocationsOwned(context: DatabaseContext, businessId: string, locationIds: string[]): Promise<void> {
    const unique = [...new Set(locationIds)];
    if ((await repository.countOwnedLocations(context, businessId, unique)) !== unique.length) {
      throw validationError("Every schedule entry must reference a location in this business");
    }
  }

  private async hydrate(context: DatabaseContext, businessId: string, profile: StaffProfileRow): Promise<StaffMember> {
    const [services, schedule] = await Promise.all([
      repository.listServices(context, businessId, [profile.id]),
      repository.listSchedule(context, businessId, [profile.id]),
    ]);
    return toStaffMember(profile, services, schedule);
  }

  private async run<T>(operation: StaffOperation, work: (context: DatabaseContext) => Promise<T>): Promise<T> {
    try {
      return await withDatabaseContext(this.database, withIdentity(operation.requestId, operation.userId, operation.businessId), work);
    } catch (error) {
      if (error instanceof AppError || error instanceof DatabaseError) throw error;
      throw normalizeDatabaseError(error);
    }
  }
}

function toStaffMember(profile: StaffProfileRow, services: StaffServiceRow[], schedule: StaffScheduleRow[]): StaffMember {
  return {
    id: profile.id,
    membershipId: profile.membershipId,
    partyId: profile.partyId,
    displayName: profile.displayName,
    photoUploadId: profile.photoUploadId,
    isBookable: profile.isBookable,
    commissionPercent: profile.commissionPercent,
    services: services
      .filter((service) => service.staffId === profile.id)
      .map(({ staffId: _staffId, ...service }) => service),
    schedule: schedule
      .filter((entry) => entry.staffId === profile.id)
      .map(({ staffId: _staffId, ...entry }) => entry),
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  };
}

function toException(row: ScheduleExceptionRow): ScheduleException {
  return {
    id: row.id,
    staffId: row.staffId,
    locationId: row.locationId,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    kind: row.kind,
    reason: row.reason,
  };
}

function toCommissionReport(row: CommissionReportRow): StaffCommissionReport {
  const revenueMinor = Number(row.revenueMinor);
  const commissionMinor = Math.round((revenueMinor * row.commissionPercent) / 100);
  return {
    staffId: row.staffId,
    displayName: row.displayName,
    commissionPercent: row.commissionPercent,
    revenueMinor,
    tipsMinor: Number(row.tipsMinor),
    commissionMinor,
    completedBookings: Number(row.completedCount),
  };
}

/** Owner's starting week: Monday to Friday, 09:00–17:00 at the default branch (branch local time). */
export const OWNER_STARTING_HOURS = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startTime: "09:00", endTime: "17:00" }));

/**
 * Makes a new business's owner bookable from day one, with weekday hours at
 * the default branch, so a one-person business can take bookings without
 * setting up staff first. Called when a business is created; migration 0069
 * did the same for businesses that existed before.
 */
export async function seedOwnerAsStaff(context: DatabaseContext, businessId: string, ownerUserId: string, defaultBranchId: string): Promise<void> {
  const [name, membership] = await Promise.all([
    authorizationRepository.findUserName(context, ownerUserId),
    authorizationRepository.findMembershipByUserId(context, businessId, ownerUserId),
  ]);
  if (!membership) return;
  const profile = await repository.createProfile(context, businessId, {
    membershipId: membership.id,
    displayName: name || membership.email || "Owner",
    isBookable: true,
  });
  await repository.replaceSchedule(context, businessId, profile.id, {
    entries: OWNER_STARTING_HOURS.map((hours) => ({ locationId: defaultBranchId, ...hours })),
  });
}
