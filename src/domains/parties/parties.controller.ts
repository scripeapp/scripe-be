import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import { notFoundError } from "../../shared/errors.js";
import * as schemas from "./parties.schemas.js";
import type { PartiesService } from "./parties.service.js";
import type { OperationContext } from "./parties.types.js";

export class PartiesController {
  constructor(private readonly service: PartiesService) {}

  readonly list = this.handle(async (request) => {
    const { businessId } = schemas.params.parse(request.params);
    return this.service.list(this.operation(request, businessId), schemas.listPartiesQuery.parse(request.query));
  }, 200, schemas.partiesResult);
  readonly create = this.handle(async (request) => {
    const { businessId } = schemas.params.parse(request.params);
    return { party: await this.service.create(this.operation(request, businessId), schemas.createParty.parse(request.body)) };
  }, 201, schemas.partyResult);
  readonly get = this.handle(async (request) => {
    const { businessId, partyId } = schemas.partyParams.parse(request.params);
    return { party: await this.service.get(this.operation(request, businessId), partyId) };
  }, 200, schemas.partyResult);
  readonly update = this.handle(async (request) => {
    const { businessId, partyId } = schemas.partyParams.parse(request.params);
    return { party: await this.service.update(this.operation(request, businessId), partyId, schemas.updateParty.parse(request.body)) };
  }, 200, schemas.partyResult);
  readonly archive = this.handle(async (request) => {
    const { businessId, partyId } = schemas.partyParams.parse(request.params);
    await this.service.archive(this.operation(request, businessId), partyId);
    return { archived: true };
  });

  readonly listContacts = this.handle(async (request) => {
    const { businessId, partyId } = schemas.partyParams.parse(request.params);
    return { contacts: await this.service.listContacts(this.operation(request, businessId), partyId) };
  }, 200, schemas.contactsResult);
  readonly createContact = this.handle(async (request) => {
    const { businessId, partyId } = schemas.partyParams.parse(request.params);
    return { contact: await this.service.createContact(this.operation(request, businessId), partyId, schemas.createContact.parse(request.body)) };
  }, 201, schemas.contactResult);
  readonly updateContact = this.handle(async (request) => {
    const { businessId, partyId, contactId } = schemas.contactParams.parse(request.params);
    return { contact: await this.service.updateContact(this.operation(request, businessId), partyId, contactId, schemas.updateContact.parse(request.body)) };
  }, 200, schemas.contactResult);
  readonly archiveContact = this.handle(async (request) => {
    const { businessId, partyId, contactId } = schemas.contactParams.parse(request.params);
    await this.service.archiveContact(this.operation(request, businessId), partyId, contactId);
    return { archived: true };
  });

  readonly listAddresses = this.handle(async (request) => {
    const { businessId, partyId } = schemas.partyParams.parse(request.params);
    return { addresses: await this.service.listAddresses(this.operation(request, businessId), partyId) };
  }, 200, schemas.addressesResult);
  readonly createAddress = this.handle(async (request) => {
    const { businessId, partyId } = schemas.partyParams.parse(request.params);
    return { address: await this.service.createAddress(this.operation(request, businessId), partyId, schemas.createAddress.parse(request.body)) };
  }, 201, schemas.addressResult);
  readonly updateAddress = this.handle(async (request) => {
    const { businessId, partyId, addressId } = schemas.addressParams.parse(request.params);
    return { address: await this.service.updateAddress(this.operation(request, businessId), partyId, addressId, schemas.updateAddress.parse(request.body)) };
  }, 200, schemas.addressResult);
  readonly archiveAddress = this.handle(async (request) => {
    const { businessId, partyId, addressId } = schemas.addressParams.parse(request.params);
    await this.service.archiveAddress(this.operation(request, businessId), partyId, addressId);
    return { archived: true };
  });

  readonly listCustomers = this.handle(async (request) => this.listRole(request, "customer"), 200, schemas.partiesResult);
  readonly createCustomer = this.handle(async (request) => {
    const { businessId } = schemas.params.parse(request.params);
    return { customer: await this.service.createCustomer(this.operation(request, businessId), schemas.createCustomer.parse(request.body)) };
  }, 201, schemas.customerResult);
  readonly getCustomer = this.handle(async (request) => this.getRole(request, "customer"), 200, schemas.customerResult);
  readonly updateCustomer = this.handle(async (request) => {
    const { businessId, partyId } = schemas.partyParams.parse(request.params);
    const { customer, ...partyInput } = schemas.updateCustomer.parse(request.body);
    return { customer: await this.service.updateCustomer(this.operation(request, businessId), partyId, partyInput, customer ?? {}) };
  }, 200, schemas.customerResult);
  readonly archiveCustomer = this.handle(async (request) => {
    const { businessId, partyId } = schemas.partyParams.parse(request.params);
    await this.service.archiveCustomer(this.operation(request, businessId), partyId);
    return { archived: true };
  });

  readonly listSuppliers = this.handle(async (request) => this.listRole(request, "supplier"), 200, schemas.partiesResult);
  readonly createSupplier = this.handle(async (request) => {
    const { businessId } = schemas.params.parse(request.params);
    return { supplier: await this.service.createSupplier(this.operation(request, businessId), schemas.createSupplier.parse(request.body)) };
  }, 201, schemas.supplierResult);
  readonly getSupplier = this.handle(async (request) => this.getRole(request, "supplier"), 200, schemas.supplierResult);
  readonly updateSupplier = this.handle(async (request) => {
    const { businessId, partyId } = schemas.partyParams.parse(request.params);
    const { supplier, ...partyInput } = schemas.updateSupplier.parse(request.body);
    return { supplier: await this.service.updateSupplier(this.operation(request, businessId), partyId, partyInput, supplier ?? {}) };
  }, 200, schemas.supplierResult);
  readonly archiveSupplier = this.handle(async (request) => {
    const { businessId, partyId } = schemas.partyParams.parse(request.params);
    await this.service.archiveSupplier(this.operation(request, businessId), partyId);
    return { archived: true };
  });

  private async listRole(request: Request, role: "customer" | "supplier") {
    const { businessId } = schemas.params.parse(request.params);
    return this.service.list(this.operation(request, businessId), { ...schemas.listPartiesQuery.parse(request.query), role });
  }
  private async getRole(request: Request, role: "customer" | "supplier") {
    const { businessId, partyId } = schemas.partyParams.parse(request.params);
    const party = await this.service.get(this.operation(request, businessId), partyId);
    if (!party[`${role}Account`]) throw notFoundError(`${role} not found`);
    return { [role]: party };
  }
  private operation(request: Request, businessId: string): OperationContext { return { userId: requireAuthContext(request).userId, businessId, requestId: request.requestId }; }
  private handle<T>(work: (request: Request) => Promise<T>, statusCode = 200, responseSchema?: { parse(value: unknown): unknown }) {
    return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
      try { const result = await work(request); ApiResponse.success(response, responseSchema ? responseSchema.parse(result) : result, statusCode); } catch (error) { next(error); }
    };
  }
}
