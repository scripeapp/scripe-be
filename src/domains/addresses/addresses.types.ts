export interface UserAddressRow {
  readonly id: string;
  readonly userId: string;
  readonly label: string | null;
  readonly isDefault: boolean;
  readonly recipientName: string;
  readonly phone: string;
  readonly addressLine1: string;
  readonly addressLine2: string | null;
  readonly city: string;
  readonly state: string;
  readonly postalCode: string | null;
  readonly country: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface UserAddress {
  readonly id: string;
  readonly label: string | null;
  readonly isDefault: boolean;
  readonly recipientName: string;
  readonly phone: string;
  readonly addressLine1: string;
  readonly addressLine2: string | null;
  readonly city: string;
  readonly state: string;
  readonly postalCode: string | null;
  readonly country: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UserAddressListResponse {
  readonly addresses: readonly UserAddress[];
}

export interface AddressesOperation {
  readonly userId: string;
  readonly requestId: string;
}

export interface CreateAddressInput {
  readonly label?: string | null;
  readonly isDefault?: boolean;
  readonly recipientName: string;
  readonly phone: string;
  readonly addressLine1: string;
  readonly addressLine2?: string | null;
  readonly city: string;
  readonly state: string;
  readonly postalCode?: string | null;
  readonly country?: string;
}

export type UpdateAddressInput = Partial<CreateAddressInput>;