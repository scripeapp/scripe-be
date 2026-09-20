export type PartyKind = "person" | "organization";
export type PartyStatus = "active" | "inactive" | "archived";
export type ContactKind = "email" | "phone";
export type AddressKind = "billing" | "shipping" | "office" | "other";

export interface OperationContext {
  readonly userId: string;
  readonly businessId: string;
  readonly requestId: string;
}

export interface PartyRow {
  readonly id: string;
  readonly businessId: string;
  readonly kind: PartyKind;
  readonly displayName: string;
  readonly legalName: string | null;
  readonly status: PartyStatus;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly archivedAt: Date | null;
}

export interface Party {
  readonly id: string;
  readonly businessId: string;
  readonly kind: PartyKind;
  readonly displayName: string;
  readonly legalName: string | null;
  readonly status: PartyStatus;
  readonly roles: readonly ("customer" | "supplier")[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

export interface PartyContactRow {
  readonly id: string;
  readonly businessId: string;
  readonly partyId: string;
  readonly kind: ContactKind;
  readonly value: string;
  readonly normalizedValue: string;
  readonly label: string | null;
  readonly isPrimary: boolean;
  readonly status: "active" | "archived";
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PartyContact extends Omit<PartyContactRow, "createdAt" | "updatedAt"> {
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PartyAddressRow {
  readonly id: string;
  readonly businessId: string;
  readonly partyId: string;
  readonly kind: AddressKind;
  readonly label: string | null;
  readonly line1: string;
  readonly line2: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly postalCode: string | null;
  readonly countryCode: string;
  readonly isDefault: boolean;
  readonly status: "active" | "archived";
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PartyAddress extends Omit<PartyAddressRow, "createdAt" | "updatedAt"> {
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CustomerAccountRow {
  readonly id: string;
  readonly businessId: string;
  readonly partyId: string;
  readonly acquisitionChannel: string | null;
  readonly lifecycleState: "lead" | "active" | "inactive" | "blocked";
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CustomerAccount extends Omit<CustomerAccountRow, "createdAt" | "updatedAt"> {
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SupplierAccountRow {
  readonly id: string;
  readonly businessId: string;
  readonly partyId: string;
  readonly code: string | null;
  readonly paymentTerms: string;
  readonly taxId: string | null;
  readonly status: "active" | "inactive" | "archived";
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SupplierAccount extends Omit<SupplierAccountRow, "createdAt" | "updatedAt"> {
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PartyDetail extends Party {
  readonly contacts: readonly PartyContact[];
  readonly addresses: readonly PartyAddress[];
  readonly customerAccount: CustomerAccount | null;
  readonly supplierAccount: SupplierAccount | null;
}

export interface CreatePartyInput {
  readonly kind: PartyKind;
  readonly displayName: string;
  readonly legalName?: string | null;
}
export interface UpdatePartyInput {
  readonly kind?: PartyKind;
  readonly displayName?: string;
  readonly legalName?: string | null;
  readonly status?: Exclude<PartyStatus, "archived">;
}
export interface CreateContactInput {
  readonly kind: ContactKind;
  readonly value: string;
  readonly label?: string | null;
  readonly isPrimary?: boolean;
}
export interface UpdateContactInput {
  readonly value?: string;
  readonly label?: string | null;
  readonly isPrimary?: boolean;
}
export interface CreateAddressInput {
  readonly kind: AddressKind;
  readonly label?: string | null;
  readonly line1: string;
  readonly line2?: string | null;
  readonly city?: string | null;
  readonly state?: string | null;
  readonly postalCode?: string | null;
  readonly countryCode?: string;
  readonly isDefault?: boolean;
}
export type UpdateAddressInput = Partial<CreateAddressInput>;
export interface CustomerAccountInput {
  readonly acquisitionChannel?: string | null;
  readonly lifecycleState?: CustomerAccountRow["lifecycleState"];
}
export interface CreateCustomerInput extends CreatePartyInput {
  readonly customer: CustomerAccountInput;
}
export interface SupplierAccountInput {
  readonly code?: string | null;
  readonly paymentTerms?: string;
  readonly taxId?: string | null;
  readonly status?: SupplierAccountRow["status"];
}
export interface CreateSupplierInput extends CreatePartyInput {
  readonly supplier: SupplierAccountInput;
}
