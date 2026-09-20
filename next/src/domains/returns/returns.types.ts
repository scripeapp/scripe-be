export type ReturnLineCondition = "sellable" | "damaged" | "defective";

export interface ReturnRow {
  readonly id: string;
  readonly businessId: string;
  readonly orderId: string;
  readonly reason: string;
  readonly inventoryLocationId: string | null;
  readonly refundableAmountMinor: string;
  readonly createdBy: string;
  readonly createdAt: Date;
}

export interface ReturnLineRow {
  readonly id: string;
  readonly businessId: string;
  readonly returnId: string;
  readonly orderLineId: string;
  readonly quantity: number;
  readonly condition: ReturnLineCondition;
  readonly restocked: boolean;
  readonly amountMinor: string;
  readonly createdAt: Date;
}

export interface Return extends Omit<ReturnRow, "createdAt"> {
  readonly createdAt: string;
  readonly lines: ReturnLine[];
}

export interface ReturnLine extends Omit<ReturnLineRow, "createdAt"> {
  readonly createdAt: string;
}

export interface ReturnsOperation {
  readonly userId: string;
  readonly businessId: string;
  readonly requestId: string;
}

export interface CreateReturnLineInput {
  readonly orderLineId: string;
  readonly quantity: number;
  readonly condition: ReturnLineCondition;
  readonly restock: boolean;
}

export interface CreateReturnInput {
  readonly orderId: string;
  readonly reason: string;
  readonly inventoryLocationId?: string | null;
  readonly lines: CreateReturnLineInput[];
}
