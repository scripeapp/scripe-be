import type { Database } from "../../db/database.types.js";
import { withDatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { withIdentity } from "../../db/principal.js";
import { AppError, forbiddenError, notFoundError } from "../../shared/errors.js";
import * as repository from "./parties.repository.js";
import type {
  CreateAddressInput,
  CreateContactInput,
  CreateCustomerInput,
  CreatePartyInput,
  CreateSupplierInput,
  CustomerAccount,
  CustomerAccountInput,
  CustomerAccountRow,
  Party,
  PartyAddress,
  PartyAddressRow,
  PartyContact,
  PartyContactRow,
  PartyDetail,
  PartyRow,
  OperationContext,
  SupplierAccountInput,
  SupplierAccount,
  SupplierAccountRow,
  UpdateAddressInput,
  UpdateContactInput,
  UpdatePartyInput,
} from "./parties.types.js";

export class PartiesService {
  constructor(private readonly database: Database) {}

  async list(operation: OperationContext, options: Parameters<typeof repository.listParties>[2]): Promise<{ parties: Party[]; nextCursor: string | null }> {
    return this.run(operation, async (context) => {
      await this.authorize(context, operation.businessId, "party.read");
      const rows = await repository.listParties(context, operation.businessId, options);
      const parties = await Promise.all(rows.map((row) => this.toParty(context, row)));
      return { parties, nextCursor: rows.length === options.limit ? repository.encodeCursor(rows[rows.length - 1]!) : null };
    });
  }

  async get(operation: OperationContext, partyId: string): Promise<PartyDetail> {
    return this.run(operation, async (context) => {
      await this.authorize(context, operation.businessId, "party.read");
      return this.requireDetail(context, operation.businessId, partyId);
    });
  }

  async create(operation: OperationContext, input: CreatePartyInput): Promise<PartyDetail> {
    return this.run(operation, async (context) => {
      await this.authorize(context, operation.businessId, "party.manage");
      const row = await repository.createParty(context, operation.businessId, operation.userId, input);
      return this.requireDetail(context, operation.businessId, row.id);
    });
  }

  async update(operation: OperationContext, partyId: string, input: UpdatePartyInput): Promise<PartyDetail> {
    return this.run(operation, async (context) => {
      await this.authorize(context, operation.businessId, "party.manage");
      await this.requireParty(context, operation.businessId, partyId);
      const row = await repository.updateParty(context, operation.businessId, partyId, input);
      if (!row) throw notFoundError("Party not found");
      return this.requireDetail(context, operation.businessId, partyId);
    });
  }

  async archive(operation: OperationContext, partyId: string): Promise<void> {
    return this.run(operation, async (context) => {
      await this.authorize(context, operation.businessId, "party.manage");
      if (!(await repository.archiveParty(context, operation.businessId, partyId))) throw notFoundError("Party not found");
    });
  }

  async createCustomer(operation: OperationContext, input: CreateCustomerInput): Promise<PartyDetail> {
    return this.run(operation, async (context) => {
      await this.authorize(context, operation.businessId, "party.manage");
      const party = await repository.createParty(context, operation.businessId, operation.userId, input);
      await repository.createCustomer(context, operation.businessId, party.id, input.customer);
      return this.requireDetail(context, operation.businessId, party.id);
    });
  }

  async updateCustomer(operation: OperationContext, partyId: string, partyInput: UpdatePartyInput, accountInput: CustomerAccountInput): Promise<PartyDetail> {
    return this.run(operation, async (context) => {
      await this.authorize(context, operation.businessId, "party.manage");
      await this.requireParty(context, operation.businessId, partyId);
      if (!(await repository.findCustomer(context, operation.businessId, partyId))) throw notFoundError("Customer not found");
      if (Object.keys(partyInput).length > 0) await repository.updateParty(context, operation.businessId, partyId, partyInput);
      if (Object.keys(accountInput).length > 0) await repository.updateCustomer(context, operation.businessId, partyId, accountInput);
      return this.requireDetail(context, operation.businessId, partyId);
    });
  }

  async archiveCustomer(operation: OperationContext, partyId: string): Promise<void> {
    return this.run(operation, async (context) => {
      await this.authorize(context, operation.businessId, "party.manage");
      if (!(await repository.updateCustomer(context, operation.businessId, partyId, { lifecycleState: "inactive" }))) throw notFoundError("Customer not found");
    });
  }

  async createSupplier(operation: OperationContext, input: CreateSupplierInput): Promise<PartyDetail> {
    return this.run(operation, async (context) => {
      await this.authorize(context, operation.businessId, "party.manage");
      const party = await repository.createParty(context, operation.businessId, operation.userId, input);
      await repository.createSupplier(context, operation.businessId, party.id, input.supplier);
      return this.requireDetail(context, operation.businessId, party.id);
    });
  }

  async updateSupplier(operation: OperationContext, partyId: string, partyInput: UpdatePartyInput, accountInput: SupplierAccountInput): Promise<PartyDetail> {
    return this.run(operation, async (context) => {
      await this.authorize(context, operation.businessId, "party.manage");
      await this.requireParty(context, operation.businessId, partyId);
      if (!(await repository.findSupplier(context, operation.businessId, partyId))) throw notFoundError("Supplier not found");
      if (Object.keys(partyInput).length > 0) await repository.updateParty(context, operation.businessId, partyId, partyInput);
      if (Object.keys(accountInput).length > 0) await repository.updateSupplier(context, operation.businessId, partyId, accountInput);
      return this.requireDetail(context, operation.businessId, partyId);
    });
  }

  async archiveSupplier(operation: OperationContext, partyId: string): Promise<void> {
    return this.run(operation, async (context) => {
      await this.authorize(context, operation.businessId, "party.manage");
      if (!(await repository.updateSupplier(context, operation.businessId, partyId, { status: "archived" }))) throw notFoundError("Supplier not found");
    });
  }

  async listContacts(operation: OperationContext, partyId: string): Promise<PartyContact[]> {
    return this.run(operation, async (context) => {
      await this.authorize(context, operation.businessId, "party.read");
      await this.requireParty(context, operation.businessId, partyId);
      return (await repository.listContacts(context, operation.businessId, partyId)).map(toContact);
    });
  }
  async createContact(operation: OperationContext, partyId: string, input: CreateContactInput): Promise<PartyContact> {
    return this.run(operation, async (context) => {
      await this.authorize(context, operation.businessId, "party.manage");
      await this.requireParty(context, operation.businessId, partyId);
      return toContact(await repository.createContact(context, operation.businessId, partyId, input));
    });
  }
  async updateContact(operation: OperationContext, partyId: string, contactId: string, input: UpdateContactInput): Promise<PartyContact> {
    return this.run(operation, async (context) => {
      await this.authorize(context, operation.businessId, "party.manage");
      const row = await repository.updateContact(context, operation.businessId, partyId, contactId, input);
      if (!row) throw notFoundError("Contact not found");
      return toContact(row);
    });
  }
  async archiveContact(operation: OperationContext, partyId: string, contactId: string): Promise<void> {
    return this.run(operation, async (context) => {
      await this.authorize(context, operation.businessId, "party.manage");
      if (!(await repository.archiveContact(context, operation.businessId, partyId, contactId))) throw notFoundError("Contact not found");
    });
  }

  async listAddresses(operation: OperationContext, partyId: string): Promise<PartyAddress[]> {
    return this.run(operation, async (context) => {
      await this.authorize(context, operation.businessId, "party.read");
      await this.requireParty(context, operation.businessId, partyId);
      return (await repository.listAddresses(context, operation.businessId, partyId)).map(toAddress);
    });
  }
  async createAddress(operation: OperationContext, partyId: string, input: CreateAddressInput): Promise<PartyAddress> {
    return this.run(operation, async (context) => {
      await this.authorize(context, operation.businessId, "party.manage");
      await this.requireParty(context, operation.businessId, partyId);
      return toAddress(await repository.createAddress(context, operation.businessId, partyId, input));
    });
  }
  async updateAddress(operation: OperationContext, partyId: string, addressId: string, input: UpdateAddressInput): Promise<PartyAddress> {
    return this.run(operation, async (context) => {
      await this.authorize(context, operation.businessId, "party.manage");
      const row = await repository.updateAddress(context, operation.businessId, partyId, addressId, input);
      if (!row) throw notFoundError("Address not found");
      return toAddress(row);
    });
  }
  async archiveAddress(operation: OperationContext, partyId: string, addressId: string): Promise<void> {
    return this.run(operation, async (context) => {
      await this.authorize(context, operation.businessId, "party.manage");
      if (!(await repository.archiveAddress(context, operation.businessId, partyId, addressId))) throw notFoundError("Address not found");
    });
  }

  private async requireParty(context: Parameters<typeof repository.findParty>[0], businessId: string, partyId: string): Promise<PartyRow> {
    const party = await repository.findParty(context, businessId, partyId);
    if (!party || party.status === "archived") throw notFoundError("Party not found");
    return party;
  }
  private async requireDetail(context: Parameters<typeof repository.findParty>[0], businessId: string, partyId: string): Promise<PartyDetail> {
    const row = await this.requireParty(context, businessId, partyId);
    const [contacts, addresses, customerAccount, supplierAccount] = await Promise.all([
      repository.listContacts(context, businessId, partyId),
      repository.listAddresses(context, businessId, partyId),
      repository.findCustomer(context, businessId, partyId),
      repository.findSupplier(context, businessId, partyId),
    ]);
    return {
      ...toPartyBase(row),
      roles: [...(customerAccount ? ["customer" as const] : []), ...(supplierAccount ? ["supplier" as const] : [])],
      contacts: contacts.map(toContact),
      addresses: addresses.map(toAddress),
      customerAccount: customerAccount ? toCustomer(customerAccount) : null,
      supplierAccount: supplierAccount ? toSupplier(supplierAccount) : null,
    };
  }
  private async toParty(context: Parameters<typeof repository.findParty>[0], row: PartyRow): Promise<Party> {
    const [customer, supplier] = await Promise.all([repository.findCustomer(context, row.businessId, row.id), repository.findSupplier(context, row.businessId, row.id)]);
    return { ...toPartyBase(row), roles: [...(customer ? ["customer" as const] : []), ...(supplier ? ["supplier" as const] : [])] };
  }
  private async authorize(context: Parameters<typeof repository.authorizedMembership>[0], businessId: string, permission: string): Promise<void> {
    if (!(await repository.authorizedMembership(context, businessId, permission))) throw forbiddenError(`Missing permission: ${permission}`);
  }
  private async run<T>(operation: OperationContext, work: Parameters<typeof withDatabaseContext<T>>[2]): Promise<T> {
    try { return await withDatabaseContext(this.database, withIdentity(operation.requestId, operation.userId, operation.businessId), work); }
    catch (error) { if (error instanceof AppError || error instanceof DatabaseError) throw error; throw normalizeDatabaseError(error); }
  }
}

function toPartyBase(row: PartyRow): Party {
  return { id: row.id, businessId: row.businessId, kind: row.kind, displayName: row.displayName, legalName: row.legalName, status: row.status, roles: [], createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), archivedAt: row.archivedAt?.toISOString() ?? null };
}
function toContact(row: PartyContactRow): PartyContact { return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }; }
function toAddress(row: PartyAddressRow): PartyAddress { return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }; }
function toCustomer(row: CustomerAccountRow): CustomerAccount { return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }; }
function toSupplier(row: SupplierAccountRow): SupplierAccount { return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }; }
