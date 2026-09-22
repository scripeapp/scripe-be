import { z } from "zod";

const uuid = z.string().uuid();
export const params = z.object({ businessId: uuid });
export const partyParams = params.extend({ partyId: uuid });
export const contactParams = partyParams.extend({ contactId: uuid });
export const addressParams = partyParams.extend({ addressId: uuid });

export const listPartiesQuery = z.object({
  role: z.enum(["customer", "supplier"]).optional(),
  status: z.enum(["active", "inactive", "archived"]).optional(),
  search: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(300).optional(),
});
export const createParty = z.object({
  kind: z.enum(["person", "organization"]),
  displayName: z.string().trim().min(1).max(200),
  legalName: z.string().trim().max(200).nullable().optional(),
});
const updatePartyBase = createParty.partial().extend({
  status: z.enum(["active", "inactive"]).optional(),
});
export const updateParty = updatePartyBase.refine((value) => Object.keys(value).length > 0, "At least one field is required");
export const createContact = z.object({
  kind: z.enum(["email", "phone"]),
  value: z.string().trim().min(1).max(320),
  label: z.string().trim().max(80).nullable().optional(),
  isPrimary: z.boolean().default(false),
});
export const updateContact = createContact.omit({ kind: true }).partial().refine((value) => Object.keys(value).length > 0, "At least one field is required");
export const createAddress = z.object({
  kind: z.enum(["billing", "shipping", "office", "other"]),
  label: z.string().trim().max(80).nullable().optional(),
  line1: z.string().trim().min(1).max(240),
  line2: z.string().trim().max(240).nullable().optional(),
  city: z.string().trim().max(120).nullable().optional(),
  state: z.string().trim().max(120).nullable().optional(),
  postalCode: z.string().trim().max(40).nullable().optional(),
  countryCode: z.string().trim().length(2).transform((value) => value.toUpperCase()).default("NG"),
  isDefault: z.boolean().default(false),
});
export const updateAddress = createAddress.partial().refine((value) => Object.keys(value).length > 0, "At least one field is required");
export const customerAccount = z.object({
  acquisitionChannel: z.string().trim().max(120).nullable().optional(),
  lifecycleState: z.enum(["lead", "active", "inactive", "blocked"]).default("active"),
});
export const supplierAccount = z.object({
  code: z.string().trim().max(80).nullable().optional(),
  paymentTerms: z.string().trim().min(1).max(120).default("Net 30"),
  taxId: z.string().trim().max(120).nullable().optional(),
  status: z.enum(["active", "inactive"]).default("active"),
});
export const createCustomer = createParty.extend({ customer: customerAccount.default({}) });
export const createSupplier = createParty.extend({ supplier: supplierAccount.default({}) });
export const updateCustomer = updatePartyBase.extend({ customer: customerAccount.partial().optional() }).refine((value) => Object.keys(value).length > 0, "At least one field is required");
export const updateSupplier = updatePartyBase.extend({ supplier: supplierAccount.partial().optional() }).refine((value) => Object.keys(value).length > 0, "At least one field is required");

const timestamp = z.string().datetime();
const party = z.object({ id: uuid, businessId: uuid, kind: z.enum(["person", "organization"]), displayName: z.string(), legalName: z.string().nullable(), status: z.enum(["active", "inactive", "archived"]), roles: z.array(z.enum(["customer", "supplier"])), createdAt: timestamp, updatedAt: timestamp, archivedAt: timestamp.nullable() });
const contact = z.object({ id: uuid, businessId: uuid, partyId: uuid, kind: z.enum(["email", "phone"]), value: z.string(), normalizedValue: z.string(), label: z.string().nullable(), isPrimary: z.boolean(), status: z.enum(["active", "archived"]), createdAt: timestamp, updatedAt: timestamp });
const address = z.object({ id: uuid, businessId: uuid, partyId: uuid, kind: z.enum(["billing", "shipping", "office", "other"]), label: z.string().nullable(), line1: z.string(), line2: z.string().nullable(), city: z.string().nullable(), state: z.string().nullable(), postalCode: z.string().nullable(), countryCode: z.string().length(2), isDefault: z.boolean(), status: z.enum(["active", "archived"]), createdAt: timestamp, updatedAt: timestamp });
const customer = z.object({ id: uuid, businessId: uuid, partyId: uuid, acquisitionChannel: z.string().nullable(), lifecycleState: z.enum(["lead", "active", "inactive", "blocked"]), createdAt: timestamp, updatedAt: timestamp });
const supplier = z.object({ id: uuid, businessId: uuid, partyId: uuid, code: z.string().nullable(), paymentTerms: z.string(), taxId: z.string().nullable(), status: z.enum(["active", "inactive", "archived"]), createdAt: timestamp, updatedAt: timestamp });
const detail = party.extend({ contacts: z.array(contact), addresses: z.array(address), customerAccount: customer.nullable(), supplierAccount: supplier.nullable() });
export const partiesResult = z.object({ parties: z.array(party), nextCursor: z.string().nullable() });
export const partyResult = z.object({ party: detail });
export const contactsResult = z.object({ contacts: z.array(contact) });
export const contactResult = z.object({ contact });
export const addressesResult = z.object({ addresses: z.array(address) });
export const addressResult = z.object({ address });
export const customerResult = z.object({ customer: detail });
export const supplierResult = z.object({ supplier: detail });
