import { z } from "zod";

const commaSeparatedValues = (value: string | undefined) =>
  value ? value.split(",").filter(Boolean) : undefined;

const uuidList = z.string().transform(commaSeparatedValues).pipe(
  z.array(z.string().uuid()).optional(),
);

const enumList = <T extends [string, ...string[]]>(values: T) =>
  z.string().transform(commaSeparatedValues).pipe(z.array(z.enum(values)).optional());

/**
 * Unified store catalog (products + events + courses) list query.
 * `store_id` is optional so businesses with events/courses but no store
 * still get a catalog; products are simply skipped when it is absent.
 */
export const catalogSchemas = {
  list: z.object({
    page: z.string().optional().default("1"),
    limit: z.string().optional().default("10"),
    status: z.enum(["published", "draft"]).optional(),
    search: z.string().optional(),
    store_id: z.string().uuid("Invalid store ID").optional(),
    types: z.string().transform(commaSeparatedValues).pipe(z.array(z.string()).optional()),
    category_ids: uuidList,
    availability: enumList(["in_stock", "low_stock", "out_of_stock", "unlimited"]),
    price_min: z.coerce.number().nonnegative().optional(),
    price_max: z.coerce.number().nonnegative().optional(),
    created_from: z.coerce.date().optional(),
    created_to: z.coerce.date().optional(),
    supplier_ids: uuidList,
    created_by_ids: uuidList,
    channels: enumList(["storefront", "pos", "marketplace"]),
  }),
};

export type CatalogListQuery = z.infer<typeof catalogSchemas.list>;
