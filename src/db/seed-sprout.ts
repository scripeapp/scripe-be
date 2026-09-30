import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { loadEnvironment } from "../shared/environment.js";

type JsonRecord = Record<string, unknown>;

loadEnvironment();

const databaseUrl = process.env.DATABASE_MIGRATE_URL;
if (!databaseUrl) throw new Error("DATABASE_MIGRATE_URL is required");

const seedPath = resolve(process.cwd(), "test-data/sprout-meals.seed.json");
const seed = JSON.parse(await readFile(seedPath, "utf8")) as JsonRecord;
const client = new pg.Client({ connectionString: databaseUrl });
const refs = new Map<string, string>();

const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

async function findId(table: string, where: JsonRecord): Promise<string | null> {
  const entries = Object.entries(where);
  const parameters: unknown[] = [];
  const clauses = entries.map(([key, value]) => {
    if (value === null) return `${quote(key)} is null`;
    parameters.push(value);
    return `${quote(key)} = $${parameters.length}`;
  });
  const result = await client.query<{ id: string }>(
    `select id from app.${quote(table)} where ${clauses.join(" and ")} limit 1`,
    parameters,
  );
  return result.rows[0]?.id ?? null;
}

async function ensure(
  table: string,
  ref: string,
  where: JsonRecord,
  values: JsonRecord,
): Promise<string> {
  const existing = await findId(table, where);
  if (existing) {
    const entries = Object.entries(values);
    if (entries.length > 0) {
      const sets = entries.map(([key], index) => `${quote(key)} = $${index + 1}`);
      await client.query(
        `update app.${quote(table)} set ${sets.join(", ")} where id = $${entries.length + 1}`,
        [...entries.map(([, value]) => value), existing],
      );
    }
    refs.set(ref, existing);
    return existing;
  }

  const row = { ...where, ...values };
  const entries = Object.entries(row);
  const result = await client.query<{ id: string }>(
    `insert into app.${quote(table)} (${entries.map(([key]) => quote(key)).join(", ")}) values (${entries.map((_, index) => `$${index + 1}`).join(", ")}) returning id`,
    entries.map(([, value]) => value),
  );
  const id = result.rows[0]!.id;
  refs.set(ref, id);
  return id;
}

async function ensureImmutable(
  table: string,
  ref: string,
  where: JsonRecord,
  values: JsonRecord,
): Promise<string> {
  const existing = await findId(table, where);
  if (existing) {
    refs.set(ref, existing);
    return existing;
  }
  return ensure(table, ref, where, values);
}

async function link(table: string, values: JsonRecord, conflictColumns: string[]) {
  const entries = Object.entries(values);
  await client.query(
    `insert into app.${quote(table)} (${entries.map(([key]) => quote(key)).join(", ")}) values (${entries.map((_, index) => `$${index + 1}`).join(", ")}) on conflict (${conflictColumns.map(quote).join(", ")}) do nothing`,
    entries.map(([, value]) => value),
  );
}

const id = (ref: unknown) => {
  const value = refs.get(String(ref));
  if (!value) throw new Error(`Unresolved seed reference: ${String(ref)}`);
  return value;
};

async function main() {
  await client.connect();
  await client.query("begin");
  try {
    const business = seed.business as JsonRecord;
    const existingBusiness = await client.query<{ id: string; createdBy: string }>(
      `select id, "createdBy" from app.businesses where "displayName" = $1 order by "createdAt" limit 1`,
      [business.displayName],
    );
    if (!existingBusiness.rows[0]) throw new Error("Create the Sprout Meals business and owner account before running this seed");
    const businessId = existingBusiness.rows[0].id;
    const ownerId = existingBusiness.rows[0].createdBy;
    refs.set(String(business.ref), businessId);
    await client.query(
      `update app.businesses set "website"=$2,"primaryVertical"=$3,"defaultCurrency"=$4,"timezone"=$5,"addressLine1"=$6,"addressLine2"=$7,"city"=$8,"state"=$9,"postalCode"=$10,"country"=$11 where id=$1`,
      [businessId, business.website, business.primaryVertical, business.defaultCurrency, business.timezone, business.addressLine1, business.addressLine2, business.city, business.state, business.postalCode, business.country],
    );

    for (const unit of ((seed.units as JsonRecord).records as JsonRecord[])) {
      await ensure("units", String(unit.ref), { businessId, code: unit.code }, { name: unit.name, symbol: unit.symbol, isBase: unit.isBase });
    }

    for (const store of seed.stores as JsonRecord[]) {
      const storeId = await ensure("stores", String(store.ref), { businessId, isDefault: store.isDefault }, {
        name: store.name, slug: store.slug, description: store.description, status: "active",
        sellsOnline: store.sellsOnline, sellsInPerson: store.sellsInPerson, contactEmail: store.contactEmail,
        contactPhone: store.contactPhone, timezone: store.timezone, createdBy: ownerId,
      });
      for (const location of store.locations as JsonRecord[]) {
        const locationWhere = location.isDefault
          ? { businessId, storeId, isDefault: true }
          : { businessId, storeId, name: location.name };
        await ensure("locations", String(location.ref), locationWhere, {
          name: location.name, kind: location.kind, status: location.status, isDefault: location.isDefault, addressLine1: location.addressLine1,
          city: location.city, state: location.state, postalCode: location.postalCode ?? null, countryCode: location.countryCode,
          phone: location.phone ?? null, timezone: location.timezone ?? store.timezone, prepTimeMinutes: location.prepTimeMinutes ?? null,
          operationTypes: location.operationTypes, acceptingOrders: location.acceptingOrders, taxRate: location.taxRate,
          serviceChargeRates: JSON.stringify(location.serviceChargeRates ?? {}), manager: location.manager ?? null, format: location.format ?? null,
        });
      }
      for (const channel of store.channels as JsonRecord[]) {
        await ensure("sales_channels", String(channel.ref), { businessId, storeId, code: channel.code }, { name: channel.name, kind: channel.kind, status: channel.status });
      }
      for (const register of store.registers as JsonRecord[]) {
        await ensure("registers", String(register.ref), { businessId, storeId, name: register.name }, { locationId: id(register.locationRef), status: register.status });
      }
    }

    for (const category of seed.categories as JsonRecord[]) {
      if (!category.parentRef) await ensure("categories", String(category.ref), { businessId, slug: category.slug }, { parentId: null, name: category.name, description: category.description, sortOrder: category.sortOrder });
    }
    for (const category of seed.categories as JsonRecord[]) {
      if (category.parentRef) await ensure("categories", String(category.ref), { businessId, slug: category.slug }, { parentId: id(category.parentRef), name: category.name, description: category.description, sortOrder: category.sortOrder });
    }

    for (const group of seed.modifierGroups as JsonRecord[]) {
      const groupId = await ensure("modifier_groups", String(group.ref), { businessId, storeId: id(group.storeRef), name: group.name }, {
        description: group.description, selectionMode: group.selectionMode, minSelections: group.minSelections,
        maxSelections: group.maxSelections, kind: group.kind, status: "active",
      });
      for (const option of group.options as JsonRecord[]) {
        await ensure("modifier_options", String(option.ref), { businessId, groupId, name: option.name }, {
          priceAdjustmentMinor: option.priceAdjustmentMinor, isDefault: option.isDefault, sortOrder: option.sortOrder, status: "active",
        });
      }
    }

    for (const product of seed.products as JsonRecord[]) {
      const productId = await ensure("products", String(product.ref), { businessId, storeId: id(product.storeRef), slug: product.slug }, {
        name: product.name, description: product.description, productType: product.productType, status: product.status,
        isSellable: product.isSellable, trackInventory: product.trackInventory, allowBackorder: product.allowBackorder ?? false, createdBy: ownerId,
      });
      for (const variant of product.variants as JsonRecord[]) {
        await ensure("product_variants", String(variant.ref), { businessId, productId, name: variant.name }, {
          sku: variant.sku, optionValues: JSON.stringify(variant.optionValues ?? {}), unitId: id(variant.unitRef), isDefault: variant.isDefault, status: "active",
        });
      }
      for (const categoryRef of (product.categoryRefs as string[] ?? [])) await link("product_categories", { businessId, productId, categoryId: id(categoryRef) }, ["productId", "categoryId"]);
      for (const [sortOrder, groupRef] of (product.modifierGroupRefs as string[] ?? []).entries()) await link("product_modifier_groups", { businessId, productId, groupId: id(groupRef), sortOrder }, ["productId", "groupId"]);
    }

    for (const price of seed.prices as JsonRecord[]) {
      await ensure("product_prices", String(price.ref), { businessId, productVariantId: id(price.productVariantRef), locationId: price.locationRef ? id(price.locationRef) : null, assetCode: price.assetCode }, {
        amountMinor: price.amountMinor, compareAtMinor: price.compareAtMinor ?? null, status: "active", createdBy: ownerId,
      });
    }

    for (const discount of seed.discounts as JsonRecord[]) {
      const productIds = (discount.productRefs as string[] ?? []).map(id);
      const discountWhere = discount.code
        ? { businessId, code: discount.code }
        : { businessId, name: discount.name };
      await ensure("discounts", String(discount.ref), discountWhere, {
        kind: discount.kind, code: discount.code ?? null, type: discount.type, percentageBps: discount.percentageBps ?? null,
        fixedAmountMinor: discount.fixedAmountMinor ?? null, isActive: discount.isActive, maxUsage: discount.maxUsage ?? null,
        oneUsePerCustomer: discount.oneUsePerCustomer ?? false, startsAt: discount.startsAt ?? null, expiresAt: discount.expiresAt ?? null,
        appliesTo: discount.appliesTo ?? "all", productIds, trigger: discount.trigger ?? null,
        triggerSpendMinor: discount.triggerSpendMinor ?? null, triggerQuantity: discount.triggerQuantity ?? null,
        qualificationProductIds: productIds, allowCodeOnTop: discount.allowCodeOnTop ?? false,
        showOnStorefront: discount.showOnStorefront ?? true, createdBy: ownerId,
      });
    }

    for (const party of [...seed.vendors as JsonRecord[], ...seed.customers as JsonRecord[]]) {
      const partyId = await ensure("parties", String(party.ref), { businessId, displayName: party.displayName }, { kind: party.kind, legalName: party.legalName ?? null, status: party.status, createdBy: ownerId });
      for (const contact of party.contacts as JsonRecord[]) await ensure("party_contacts", `${party.ref}:${contact.kind}:${contact.value}`, { businessId, partyId, kind: contact.kind, normalizedValue: contact.value }, { value: contact.value, label: contact.label ?? null, isPrimary: contact.isPrimary ?? false, status: "active" });
      for (const address of (party.addresses as JsonRecord[] ?? [])) {
        const addressKind = address.kind ?? "delivery";
        const addressWhere = address.isDefault
          ? { businessId, partyId, kind: addressKind, isDefault: true }
          : { businessId, partyId, kind: addressKind, line1: address.line1 };
        await ensure("party_addresses", `${party.ref}:address:${address.label ?? address.line1}`, addressWhere, { label: address.label ?? null, line1: address.line1, line2: address.line2 ?? null, city: address.city ?? null, state: address.state ?? null, postalCode: address.postalCode ?? null, countryCode: address.countryCode ?? "NG", isDefault: address.isDefault ?? false, status: "active" });
      }
      if (party.supplierAccount) {
        const account = party.supplierAccount as JsonRecord;
        await ensure("supplier_accounts", `${party.ref}:supplier`, { businessId, partyId }, { code: account.code ?? null, paymentTerms: account.paymentTerms ?? "Net 30", taxId: account.taxId ?? null, status: "active", contactPerson: account.contactPerson ?? null, category: account.category ?? null, website: account.website ?? null, bankName: account.bankName ?? null, bankCode: account.bankCode ?? null, accountNumber: account.accountNumber ?? null, accountName: account.accountName ?? null, notes: account.notes ?? "" });
      }
      if (party.customerAccount) {
        const account = party.customerAccount as JsonRecord;
        await ensure("customer_accounts", `${party.ref}:customer`, { businessId, partyId }, { acquisitionChannel: account.acquisitionChannel ?? null, lifecycleState: account.lifecycleState ?? "active" });
      }
    }

    const membershipResult = await client.query<{ id: string }>(
      `select id from app.business_memberships where "businessId"=$1 and "userId"=$2 limit 1`,
      [businessId, ownerId],
    );
    const ownerMembershipId = membershipResult.rows[0]?.id ?? null;

    const inventory = seed.inventory as JsonRecord;
    const inventoryLocationRefs = new Map<string, string>();
    for (const locationRef of new Set([
      ...(inventory.items as JsonRecord[]).map((item) => String(item.trackedAtRef)),
      ...(inventory.movements as JsonRecord[]).map((movement) => String(movement.inventoryLocationRef)),
      ...(inventory.transfers as JsonRecord[]).flatMap((transfer) => [String(transfer.fromLocationRef), String(transfer.toLocationRef)]),
    ])) {
      const locationId = id(locationRef);
      const locationName = await client.query<{ name: string }>(`select name from app.locations where id=$1`, [locationId]);
      const inventoryLocationId = await ensure("inventory_locations", `inventory:${locationRef}`, { businessId, locationId }, { name: locationName.rows[0]?.name ?? locationRef, status: "active" });
      inventoryLocationRefs.set(locationRef, inventoryLocationId);
    }
    const inventoryLocationId = (ref: unknown) => {
      const value = inventoryLocationRefs.get(String(ref));
      if (!value) throw new Error(`Unresolved inventory location: ${String(ref)}`);
      return value;
    };

    for (const item of inventory.items as JsonRecord[]) {
      const matchingVariant = await client.query<{ id: string }>(`select id from app.product_variants where "businessId"=$1 and sku=$2 limit 1`, [businessId, item.sku]);
      await ensure("inventory_items", String(item.ref), { businessId, sku: item.sku }, { name: item.name, variantId: matchingVariant.rows[0]?.id ?? null, trackingMode: "quantity", status: "active" });
    }
    for (const movement of inventory.movements as JsonRecord[]) {
      const transactionId = await ensureImmutable("stock_transactions", `tx:${movement.ref}`, { businessId, idempotencyKey: movement.idempotencyKey }, {
        type: movement.type, reason: movement.reason, actorUserId: ownerId, requestId: `seed:${String(movement.ref)}`,
      });
      await ensureImmutable("stock_movements", String(movement.ref), { businessId, transactionId, inventoryItemId: id(movement.inventoryItemRef), inventoryLocationId: inventoryLocationId(movement.inventoryLocationRef) }, {
        quantity: movement.quantity, unitCostMinor: movement.unitCostMinor ?? null,
      });
    }
    for (const count of inventory.counts as JsonRecord[]) {
      const countId = await ensureImmutable("stock_counts", String(count.ref), { businessId, reference: String(count.ref).toUpperCase() }, {
        status: count.status === "closed" ? "applied" : count.status, inventoryLocationId: inventoryLocationId(count.inventoryLocationRef), scope: "all", countDate: "2026-09-25", notes: count.notes, createdBy: ownerId, appliedAt: count.status === "closed" ? "2026-09-25T20:00:00.000Z" : null,
      });
      for (const line of count.lines as JsonRecord[]) {
        await ensureImmutable("stock_count_lines", `${count.ref}:${line.inventoryItemRef}`, { businessId, countId, inventoryItemId: id(line.inventoryItemRef) }, { systemQuantity: line.countedQuantity, countedQuantity: line.countedQuantity });
      }
    }
    for (const transfer of inventory.transfers as JsonRecord[]) {
      const transferId = await ensureImmutable("stock_transfers", String(transfer.ref), { businessId, reference: String(transfer.ref).toUpperCase() }, {
        status: transfer.status === "completed" ? "received" : transfer.status, fromInventoryLocationId: inventoryLocationId(transfer.fromLocationRef), toInventoryLocationId: inventoryLocationId(transfer.toLocationRef), notes: "Seeded stock transfer", createdBy: ownerId,
        sentAt: transfer.status === "completed" ? "2026-09-25T18:00:00.000Z" : null, receivedAt: transfer.status === "completed" ? "2026-09-25T19:00:00.000Z" : null,
      });
      for (const line of transfer.lines as JsonRecord[]) await ensureImmutable("stock_transfer_lines", `${transfer.ref}:${line.inventoryItemRef}`, { businessId, transferId, inventoryItemId: id(line.inventoryItemRef) }, { quantity: line.quantity, quantityReceived: transfer.status === "completed" ? line.quantity : 0, unitCostMinor: null });
    }
    const balanceRows = new Map<string, number>();
    for (const movement of inventory.movements as JsonRecord[]) {
      const key = `${String(movement.inventoryItemRef)}:${String(movement.inventoryLocationRef)}`;
      balanceRows.set(key, (balanceRows.get(key) ?? 0) + Number(movement.quantity));
    }
    for (const count of inventory.counts as JsonRecord[]) for (const line of count.lines as JsonRecord[]) balanceRows.set(`${String(line.inventoryItemRef)}:${String(count.inventoryLocationRef)}`, Number(line.countedQuantity));
    for (const transfer of inventory.transfers as JsonRecord[]) for (const line of transfer.lines as JsonRecord[]) {
      const fromKey = `${String(line.inventoryItemRef)}:${String(transfer.fromLocationRef)}`;
      const toKey = `${String(line.inventoryItemRef)}:${String(transfer.toLocationRef)}`;
      balanceRows.set(fromKey, (balanceRows.get(fromKey) ?? 0) - Number(line.quantity));
      balanceRows.set(toKey, (balanceRows.get(toKey) ?? 0) + Number(line.quantity));
    }
    for (const [key, onHand] of balanceRows) {
      const [itemRef, locationRef] = key.split(":") as [string, string];
      await ensure("stock_balances", `balance:${key}`, { businessId, inventoryItemId: id(itemRef), inventoryLocationId: inventoryLocationId(locationRef) }, { onHand, reserved: 0 });
    }

    for (const purchaseOrder of seed.purchaseOrders as JsonRecord[]) {
      const purchaseOrderId = await ensure("purchase_orders", String(purchaseOrder.ref), { businessId, orderNumber: purchaseOrder.orderNumber }, {
        supplierAccountId: id(`${String(purchaseOrder.supplierRef)}:supplier`), storeId: id(purchaseOrder.storeRef), status: purchaseOrder.status,
        orderedAt: "2026-09-22T09:00:00.000Z", expectedAt: purchaseOrder.expectedAt, notes: purchaseOrder.notes, createdBy: ownerId,
      });
      for (const line of purchaseOrder.lines as JsonRecord[]) await ensure("purchase_order_lines", String(line.ref), { businessId, purchaseOrderId, inventoryItemId: id(line.inventoryItemRef) }, { quantityOrdered: line.quantityOrdered, quantityReceived: purchaseOrder.status === "received" ? line.quantityOrdered : 0, unitCostMinor: line.unitCostMinor });
      for (const receipt of purchaseOrder.receipts as JsonRecord[]) {
        const receiptId = await ensure("goods_receipts", String(receipt.ref), { businessId, idempotencyKey: receipt.idempotencyKey }, { purchaseOrderId, inventoryLocationId: inventoryLocationId(receipt.inventoryLocationRef), status: "posted", receivedAt: "2026-09-24T09:00:00.000Z", receivedBy: ownerId });
        for (const line of receipt.lines as JsonRecord[]) {
          await ensure("goods_receipt_lines", `${receipt.ref}:${line.purchaseOrderLineRef}`, { businessId, receiptId, purchaseOrderLineId: id(line.purchaseOrderLineRef) }, { inventoryItemId: id(line.inventoryItemRef), quantityReceived: line.quantityReceived, quantityRejected: line.quantityRejected, unitCostMinor: line.unitCostMinor });
          await client.query(`update app.purchase_order_lines set "quantityReceived"=$1 where id=$2`, [line.quantityReceived, id(line.purchaseOrderLineRef)]);
        }
      }
    }

    for (const booking of (seed.bookings as JsonRecord).records as JsonRecord[]) {
      const startsAt = new Date(String(booking.scheduledFor));
      const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
      const bookingId = await ensure("bookings", String(booking.ref), { businessId, storeId: id("store_main"), customerPartyId: id(booking.customerRef), startsAt: startsAt.toISOString() }, {
        locationId: booking.locationRef ? id(booking.locationRef) : null, requiresApproval: false, status: booking.status, initiatedBy: "creator", source: "dashboard", endsAt: endsAt.toISOString(), notes: booking.notes,
      });
      const price = await client.query<{ amountMinor: string }>(`select "amountMinor" from app.product_prices where "businessId"=$1 and "productVariantId"=$2 order by "locationId" nulls first limit 1`, [businessId, id(booking.variantRef)]);
      await ensure("booking_items", `${booking.ref}:item`, { businessId, bookingId, position: 0 }, { productId: id(booking.productRef), variantId: id(booking.variantRef), staffId: null, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), modifierOptionIds: [], priceMinor: Number(price.rows[0]?.amountMinor ?? 0), durationMinutes: 60, status: "confirmed" });
    }

    for (const order of seed.orders as JsonRecord[]) {
      const totals = order.totals as JsonRecord;
      const fulfillment = order.fulfillment as JsonRecord;
      const payment = (seed.payments as JsonRecord[]).find((candidate) => candidate.ref === order.paymentRef);
      const paymentStatus = payment?.status === "captured" ? "paid" : payment?.status === "refunded" ? "refunded" : "unpaid";
      const orderId = await ensure("orders", String(order.ref), { businessId, orderNumber: order.orderNumber }, {
        storeId: id(order.storeRef), channelId: id(order.channelRef), locationId: fulfillment.locationRef ? id(fulfillment.locationRef) : null,
        customerPartyId: order.customerRef ? id(order.customerRef) : null, currency: order.currency, status: order.status, paymentStatus,
        fulfillmentStatus: order.status === "fulfilled" ? "fulfilled" : "unfulfilled", subtotalMinor: totals.subtotalMinor, discountMinor: totals.discountMinor,
        taxMinor: totals.taxMinor, totalMinor: totals.grandTotalMinor, createdBy: ownerId, idempotencyKey: `seed:${String(order.ref)}`,
      });
      for (const line of order.lines as JsonRecord[]) {
        const variant = await client.query<{ sku: string | null; description: string }>(`select v.sku, p.name||' — '||v.name as description from app.product_variants v join app.products p on p.id=v."productId" where v.id=$1`, [id(line.productVariantRef)]);
        const selectedModifiers = Object.fromEntries(Object.entries(line.selectedModifiers as JsonRecord).map(([groupRef, optionRefs]) => [id(groupRef), (optionRefs as string[]).map(id)]));
        await ensure("order_lines", String(line.ref), { businessId, orderId, productVariantId: id(line.productVariantRef) }, { sku: variant.rows[0]?.sku ?? null, description: variant.rows[0]?.description ?? String(line.productVariantRef), quantity: line.quantity, unitPriceMinor: line.unitPriceMinor, discountMinor: 0, taxMinor: 0, lineTotalMinor: Number(line.quantity) * Number(line.unitPriceMinor), assetCode: order.currency, selectedModifiers: JSON.stringify(selectedModifiers) });
      }
      await ensure("fulfillments", `${order.ref}:fulfillment`, { businessId, orderId }, { inventoryLocationId: inventoryLocationId(fulfillment.locationRef), method: fulfillment.method, status: order.status === "fulfilled" ? "fulfilled" : "allocated", createdBy: ownerId, fulfilledAt: order.status === "fulfilled" ? "2026-09-25T18:00:00.000Z" : null });
      if (order.bookingRef) await client.query(`update app.bookings set "orderId"=$1 where id=$2`, [orderId, id(order.bookingRef)]);
      if (order.return) {
        const returnData = order.return as JsonRecord;
        const returnId = await ensure("returns", String(returnData.ref), { businessId, orderId }, { reason: returnData.reason, inventoryLocationId: inventoryLocationId(fulfillment.locationRef), refundableAmountMinor: returnData.refundAmountMinor, createdBy: ownerId });
        const firstLine = (order.lines as JsonRecord[])[0]!;
        await ensure("return_lines", `${returnData.ref}:line`, { businessId, returnId, orderLineId: id(firstLine.ref) }, { quantity: firstLine.quantity, condition: "sellable", restocked: false, amountMinor: returnData.refundAmountMinor });
      }
    }
    for (const payment of seed.payments as JsonRecord[]) await ensure("payments", String(payment.ref), { businessId, idempotencyKey: payment.idempotencyKey }, { orderId: id(payment.orderRef), method: payment.method, status: payment.status, assetCode: payment.assetCode, amountMinor: payment.amountMinor, externalReference: payment.externalReference ?? null, createdBy: ownerId });

    const banking = seed.banking as JsonRecord;
    const kyb = banking.kyb as JsonRecord;
    await client.query(
      `insert into app.banking_profiles ("businessId","kycStatus","businessType","registeredBusinessName","registrationNumber","taxIdentificationNumber","dateOfRegistration",website,description,"businessCategory","annualRevenue","businessAddress") values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict ("businessId") do update set "kycStatus"=excluded."kycStatus","businessType"=excluded."businessType","registeredBusinessName"=excluded."registeredBusinessName","registrationNumber"=excluded."registrationNumber","taxIdentificationNumber"=excluded."taxIdentificationNumber","dateOfRegistration"=excluded."dateOfRegistration",website=excluded.website,description=excluded.description,"businessCategory"=excluded."businessCategory","annualRevenue"=excluded."annualRevenue","businessAddress"=excluded."businessAddress","updatedAt"=now()`,
      [businessId, "pending", kyb.businessType, kyb.registeredBusinessName, kyb.registrationNumber, kyb.taxIdentificationNumber, kyb.dateOfRegistration, kyb.website, kyb.description, kyb.businessCategory, kyb.annualRevenue, JSON.stringify(kyb.address)],
    );
    const virtualAccount = banking.virtualAccount as JsonRecord;
    await ensure("virtual_accounts", String(virtualAccount.ref), { businessId, accountNumber: virtualAccount.accountNumber }, { provider: virtualAccount.provider, accountName: virtualAccount.accountName, bankName: virtualAccount.bankName, assetCode: virtualAccount.currency, status: virtualAccount.status, metadata: JSON.stringify({ seeded: true }) });
    for (const transaction of (banking.wallet as JsonRecord).transactions as JsonRecord[]) await ensure("wallet_transactions", String(transaction.ref), { businessId, providerReference: transaction.reference }, { type: transaction.source === "withdrawal" ? "withdrawal" : transaction.source === "supplier_payment" ? "bill_payment" : "deposit", direction: transaction.type === "credit" ? "credit" : "debit", status: transaction.status === "completed" ? "posted" : "pending", assetCode: "NGN", amountMinor: transaction.amountMinor, grossAmountMinor: transaction.amountMinor, feeAmountMinor: 0, feeBreakdown: JSON.stringify({}), provider: "seed", description: transaction.narration, metadata: JSON.stringify({ source: transaction.source }), postedAt: "2026-09-25T20:00:00.000Z" });
    for (const withdrawal of banking.withdrawals as JsonRecord[]) {
      const beneficiary = withdrawal.beneficiary as JsonRecord;
      await ensure("withdrawals", String(withdrawal.ref), { businessId, providerReference: String(withdrawal.ref).toUpperCase() }, { requestedBy: ownerId, amountMinor: withdrawal.amountMinor, assetCode: "NGN", bankCode: beneficiary.bankCode, accountNumber: beneficiary.accountNumber, accountName: beneficiary.accountName, idempotencyKey: `seed:${String(withdrawal.ref)}`, status: withdrawal.status === "completed" ? "success" : withdrawal.status, purpose: "withdrawal" });
    }

    if (ownerMembershipId) for (const store of seed.stores as JsonRecord[]) for (const shift of store.shifts as JsonRecord[]) {
      const registerId = id(shift.registerRef);
      const register = await client.query<{ locationId: string }>(`select "locationId" from app.registers where id=$1`, [registerId]);
      const shiftId = await ensure("register_shifts", String(shift.ref), { businessId, registerId, openedAt: "2026-09-25T08:00:00.000Z" }, { storeId: id(store.ref), locationId: register.rows[0]!.locationId, openedByMembershipId: ownerMembershipId, closedByMembershipId: ownerMembershipId, openingCashMinor: shift.openingCashMinor, expectedCashMinor: shift.countedCashMinor, countedCashMinor: shift.countedCashMinor, varianceMinor: 0, status: "closed", closedAt: "2026-09-25T20:00:00.000Z", notes: shift.notes });
      for (const movement of shift.cashMovements as JsonRecord[]) await ensureImmutable("cash_movements", String(movement.ref), { businessId, idempotencyKey: `seed:${String(movement.ref)}` }, { storeId: id(store.ref), locationId: register.rows[0]!.locationId, registerId, shiftId, type: movement.type === "pay_in" ? "cash_in" : movement.type === "pay_out" ? "cash_out" : movement.type, amountMinor: movement.amountMinor, reason: movement.reason, actorMembershipId: ownerMembershipId, requestId: `seed:${String(movement.ref)}`, occurredAt: "2026-09-25T12:00:00.000Z" });
    }

    await client.query("commit");
    console.log(`Sprout Meals seed loaded into business ${businessId}.`);
    console.log(`Resolved ${refs.size} reference records.`);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

await main();
