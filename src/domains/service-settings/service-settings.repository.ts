import { sql } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import type { UpsertServiceSettingsInput } from "./service-settings.schemas.js";
import type { ServiceSettingsRow } from "./service-settings.types.js";

const SETTINGS_COLUMNS = sql`
  "productId", "businessId", "durationMinutes", "bufferBeforeMinutes",
  "bufferAfterMinutes", "minNoticeMinutes", "maxAdvanceDays", "slotIntervalMinutes",
  "locationType", "requiresApproval", "depositRule", "cancellationWindowMin",
  "createdAt", "updatedAt"
`;

/** The product's type, when it exists in the given business (RLS-scoped read). */
export async function findProductType(
  context: DatabaseContext,
  businessId: string,
  productId: string,
): Promise<string | undefined> {
  const result = await sql<{ productType: string }>`
    select "productType" from app.products
    where "id" = ${productId}::uuid and "businessId" = ${businessId}::uuid
    limit 1
  `.execute(context.transaction);
  return result.rows[0]?.productType;
}

export async function findSettings(
  context: DatabaseContext,
  businessId: string,
  productId: string,
): Promise<ServiceSettingsRow | undefined> {
  const result = await sql<ServiceSettingsRow>`
    select ${SETTINGS_COLUMNS} from app.product_service_settings
    where "productId" = ${productId}::uuid and "businessId" = ${businessId}::uuid
    limit 1
  `.execute(context.transaction);
  return result.rows[0];
}

export async function upsertSettings(
  context: DatabaseContext,
  businessId: string,
  productId: string,
  input: UpsertServiceSettingsInput,
): Promise<ServiceSettingsRow> {
  const result = await sql<ServiceSettingsRow>`
    insert into app.product_service_settings (
      "productId", "businessId", "durationMinutes", "bufferBeforeMinutes",
      "bufferAfterMinutes", "minNoticeMinutes", "maxAdvanceDays", "slotIntervalMinutes",
      "locationType", "requiresApproval", "depositRule", "cancellationWindowMin"
    ) values (
      ${productId}::uuid, ${businessId}::uuid, ${input.durationMinutes}, ${input.bufferBeforeMinutes},
      ${input.bufferAfterMinutes}, ${input.minNoticeMinutes}, ${input.maxAdvanceDays}, ${input.slotIntervalMinutes},
      ${input.locationType}, ${input.requiresApproval}, ${JSON.stringify(input.depositRule)}::jsonb, ${input.cancellationWindowMin}
    )
    on conflict ("productId") do update set
      "durationMinutes" = excluded."durationMinutes",
      "bufferBeforeMinutes" = excluded."bufferBeforeMinutes",
      "bufferAfterMinutes" = excluded."bufferAfterMinutes",
      "minNoticeMinutes" = excluded."minNoticeMinutes",
      "maxAdvanceDays" = excluded."maxAdvanceDays",
      "slotIntervalMinutes" = excluded."slotIntervalMinutes",
      "locationType" = excluded."locationType",
      "requiresApproval" = excluded."requiresApproval",
      "depositRule" = excluded."depositRule",
      "cancellationWindowMin" = excluded."cancellationWindowMin",
      "updatedAt" = now()
    returning ${SETTINGS_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0]!;
}
