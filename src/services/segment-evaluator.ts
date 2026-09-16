import { SupabaseClient } from "@supabase/supabase-js";
import { SegmentCondition, SegmentGroup } from "../types/crm";

/**
 * Segment Condition Evaluator
 * Evaluates segment conditions against contacts with recursive group support.
 */

type ContactRecord = Record<string, any>;

const PAGE_SIZE = 1000;
const UNIFIED_CONTACT_SELECT =
  "id, name, email, phone, source, status, created_at, updated_at";
const FALLBACK_CONTACT_SELECT =
  "id, name, email, phone, status, created_at, updated_at";

// Supported operators by type
export const OPERATORS = {
  string: [
    "equals",
    "notEquals",
    "contains",
    "notContains",
    "exists",
    "notExists",
  ],
  number: [
    "equals",
    "notEquals",
    "gt",
    "gte",
    "lt",
    "lte",
    "exists",
    "notExists",
  ],
  date: ["before", "after", "equals", "exists", "notExists"],
  boolean: ["equals", "notEquals"],
} as const;

// Field type mapping
export const FIELD_TYPES: Record<string, keyof typeof OPERATORS> = {
  name: "string",
  email: "string",
  phone: "string",
  source: "string",
  status: "string",
  created_at: "date",
  updated_at: "date",
};

function hasFieldValue(value: unknown): boolean {
  return value !== null && value !== undefined;
}

function normalizeString(value: unknown): string {
  return String(value ?? "").toLowerCase();
}

function normalizeNumber(value: unknown): number | null {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : null;
}

function normalizeDate(value: unknown): number | null {
  if (!value) return null;
  const normalized = new Date(String(value)).getTime();
  return Number.isFinite(normalized) ? normalized : null;
}

function isValidCondition(condition: SegmentCondition): boolean {
  return Boolean(condition?.field && condition?.operator);
}

function matchesCondition(contact: ContactRecord, condition: SegmentCondition): boolean {
  if (!isValidCondition(condition)) {
    return false;
  }

  const { field, operator, value } = condition;
  const fieldValue = contact[field];
  const fieldType = FIELD_TYPES[field] || "string";

  switch (operator) {
    case "exists":
      return hasFieldValue(fieldValue);
    case "notExists":
      return !hasFieldValue(fieldValue);
    default:
      break;
  }

  if (!hasFieldValue(fieldValue)) {
    return false;
  }

  if (fieldType === "number") {
    const left = normalizeNumber(fieldValue);
    const right = normalizeNumber(value);

    if (left === null || right === null) return false;

    switch (operator) {
      case "equals":
        return left === right;
      case "notEquals":
        return left !== right;
      case "gt":
        return left > right;
      case "gte":
        return left >= right;
      case "lt":
        return left < right;
      case "lte":
        return left <= right;
      default:
        return false;
    }
  }

  if (fieldType === "date") {
    const left = normalizeDate(fieldValue);
    const right = normalizeDate(value);

    if (left === null || right === null) return false;

    switch (operator) {
      case "equals":
        return left === right;
      case "notEquals":
        return left !== right;
      case "before":
      case "lt":
        return left < right;
      case "after":
      case "gt":
        return left > right;
      case "gte":
        return left >= right;
      case "lte":
        return left <= right;
      default:
        return false;
    }
  }

  if (fieldType === "boolean") {
    const left = Boolean(fieldValue);
    const right = Boolean(value);

    switch (operator) {
      case "equals":
        return left === right;
      case "notEquals":
        return left !== right;
      default:
        return false;
    }
  }

  const left = normalizeString(fieldValue);
  const right = normalizeString(value);

  switch (operator) {
    case "equals":
      return left === right;
    case "notEquals":
      return left !== right;
    case "contains":
      return left.includes(right);
    case "notContains":
      return !left.includes(right);
    case "gt":
      return left > right;
    case "gte":
      return left >= right;
    case "lt":
      return left < right;
    case "lte":
      return left <= right;
    default:
      return false;
  }
}

function matchesGroup(contact: ContactRecord, group: SegmentGroup): boolean {
  const conditionResults = (group.conditions || [])
    .filter(isValidCondition)
    .map((condition: SegmentCondition) => matchesCondition(contact, condition));
  const nestedGroupResults = (group.groups || []).map((nestedGroup: SegmentGroup) =>
    matchesGroup(contact, nestedGroup),
  );
  const results = [...conditionResults, ...nestedGroupResults];

  if (results.length === 0) {
    return false;
  }

  return group.logic === "OR" ? results.some(Boolean) : results.every(Boolean);
}

function matchesSegment(
  contact: ContactRecord,
  logic: "AND" | "OR",
  groups: SegmentGroup[],
): boolean {
  const results = (groups || []).map((group) => matchesGroup(contact, group));

  if (results.length === 0) {
    return false;
  }

  return logic === "OR" ? results.some(Boolean) : results.every(Boolean);
}

async function fetchContactsFromTable(
  supabase: SupabaseClient,
  tableName: "crm_contacts_unified" | "contacts",
  businessId: string,
): Promise<ContactRecord[]> {
  const selectClause =
    tableName === "crm_contacts_unified"
      ? UNIFIED_CONTACT_SELECT
      : FALLBACK_CONTACT_SELECT;
  const contacts: ContactRecord[] = [];
  let page = 0;

  while (true) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    const { data, error } = await supabase
      .from(tableName)
      .select(selectClause)
      .eq("business_id", businessId)
      .neq("status", "blocked")
      .order("id", { ascending: true })
      .range(from, to);

    if (error) {
      throw error;
    }

    const batch = ((data || []) as ContactRecord[]).map((contact: ContactRecord) =>
      tableName === "contacts" ? { ...contact, source: null } : contact,
    );

    contacts.push(...batch);

    if (batch.length < PAGE_SIZE) {
      break;
    }

    page += 1;
  }

  return contacts;
}

async function loadContacts(
  supabase: SupabaseClient,
  businessId: string,
): Promise<ContactRecord[]> {
  try {
    return await fetchContactsFromTable(supabase, "crm_contacts_unified", businessId);
  } catch (error: any) {
    if (!error?.message?.includes("does not exist")) {
      throw error;
    }

    console.warn("Falling back to contacts table for segment evaluation");
    return fetchContactsFromTable(supabase, "contacts", businessId);
  }
}

/**
 * Evaluate a segment's conditions and return matching contact count and sample.
 * When `limit` is omitted, the full matched contact list is returned in `sample`.
 */
export async function evaluateSegmentConditions(
  supabase: SupabaseClient,
  businessId: string,
  logic: "AND" | "OR",
  groups: SegmentGroup[],
  options: { limit?: number; countOnly?: boolean } = {},
): Promise<{ count: number; sample: any[] }> {
  const { limit, countOnly = false } = options;

  if (!groups || groups.length === 0) {
    return { count: 0, sample: [] };
  }

  const contacts = await loadContacts(supabase, businessId);
  const matches = contacts.filter((contact) => matchesSegment(contact, logic, groups));

  return {
    count: matches.length,
    sample: countOnly ? [] : matches.slice(0, typeof limit === "number" ? limit : matches.length),
  };
}
