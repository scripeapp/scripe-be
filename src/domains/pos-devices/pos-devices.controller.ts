import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import { authRequiredError } from "../../shared/errors.js";
import type { DeviceActor } from "../pos/pos.service.js";
import type { PosLineInput } from "../pos/pos.types.js";
import {
  chargeSchema,
  closeShiftSchema,
  customersQuerySchema,
  openShiftSchema,
  ordersQuerySchema,
  pairSchema,
  previewSchema,
  productParamsSchema,
  registerParamsSchema,
  unlockSchema,
} from "./pos-devices.schemas.js";
import type { PosDevicesService } from "./pos-devices.service.js";

export const DEVICE_TOKEN_HEADER = "x-register-device-token";

const toLines = (items: { product_id: string; variant_id?: string | null; quantity: number; selected_modifiers: { modifier_option_id: string }[] }[]): PosLineInput[] =>
  items.map((item) => ({
    productId: item.product_id,
    variantId: item.variant_id ?? null,
    quantity: item.quantity,
    modifierOptionIds: item.selected_modifiers.map((modifier) => modifier.modifier_option_id),
  }));

export class PosDevicesController {
  constructor(private readonly service: PosDevicesService) {}

  /** Signs a request in as the paired device named by its token header. */
  readonly requireDevice = async (request: Request, _response: Response, next: NextFunction): Promise<void> => {
    try {
      const token = request.header(DEVICE_TOKEN_HEADER);
      const device = token ? await this.service.resolve(request.requestId, token) : undefined;
      if (!device) {
        next(authRequiredError("This device isn't paired. Enter a pairing code from Registers."));
        return;
      }
      request.device = this.service.actor(device, request.requestId);
      next();
    } catch (error) {
      next(error);
    }
  };

  // dashboard
  readonly createPairingCode = this.handle(async (request) => {
    const { businessId, storeId, registerId } = registerParamsSchema.parse(request.params);
    return await this.service.createPairingCode(this.user(request, businessId), storeId, registerId);
  }, 201);

  readonly listDevices = this.handle(async (request) => {
    const { businessId, registerId } = registerParamsSchema.parse(request.params);
    return { devices: await this.service.listDevices(this.user(request, businessId), registerId) };
  });

  readonly unpair = this.handle(async (request) => {
    const { businessId, storeId, registerId } = registerParamsSchema.parse(request.params);
    return await this.service.unpair(this.user(request, businessId), storeId, registerId);
  });

  // device
  readonly pair = this.handle(async (request) => {
    const body = pairSchema.parse(request.body);
    const clientKey = request.ip ?? "unknown";
    return await this.service.pair(request.requestId, clientKey, { code: body.pairing_code, label: body.label, platform: body.platform });
  });

  readonly session = this.handle(async (request) => this.service.session(this.device(request)));

  readonly unlock = this.handle(async (request) => {
    const body = unlockSchema.parse(request.body);
    return { staff: await this.service.unlock(this.device(request), body.pin, body.expected_staff_id) };
  });

  readonly catalog = this.handle(async (request) => this.service.catalog(this.device(request)));

  readonly modifierGroups = this.handle(async (request) => {
    const { productId } = productParamsSchema.parse(request.params);
    return { groups: await this.service.modifierGroups(this.device(request), productId) };
  });

  readonly currentShift = this.handle(async (request) => ({ shift: await this.service.currentShift(this.device(request)) }));
  readonly shiftSummary = this.handle(async (request) => ({ summary: await this.service.shiftSummary(this.device(request)) }));

  readonly openShift = this.handle(async (request) => {
    const body = openShiftSchema.parse(request.body);
    return { shift: await this.service.openShift(this.device(request), body.staff_id, body.opening_cash_minor) };
  }, 201);

  readonly closeShift = this.handle(async (request) => {
    const body = closeShiftSchema.parse(request.body);
    return { shift: await this.service.closeShift(this.device(request), body.staff_id, body.counted_cash_minor, body.notes) };
  });

  readonly preview = this.handle(async (request) => {
    const body = previewSchema.parse(request.body);
    return { preview: await this.service.preview(this.device(request), toLines(body.items)) };
  });

  readonly charge = this.handle(async (request) => {
    const body = chargeSchema.parse(request.body);
    return {
      order: await this.service.charge(this.device(request), {
        items: toLines(body.items),
        paymentMethod: body.payment_method,
        staffId: body.staff_id,
        idempotencyKey: body.idempotency_key,
        customerId: body.customer_id ?? null,
      }),
    };
  });

  readonly orders = this.handle(async (request) => {
    const query = ordersQuerySchema.parse(request.query);
    return { orders: await this.service.orders(this.device(request), query.status, query.limit) };
  });

  readonly customers = this.handle(async (request) => {
    const query = customersQuerySchema.parse(request.query);
    return { customers: await this.service.customers(this.device(request), query.search || null, query.limit) };
  });

  private device(request: Request): DeviceActor {
    if (!request.device) throw authRequiredError("This device isn't paired.");
    return request.device;
  }

  private user(request: Request, businessId: string) {
    return { userId: requireAuthContext(request).userId, requestId: request.requestId, businessId };
  }

  private handle<T>(work: (request: Request) => Promise<T>, statusCode = 200) {
    return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
      try {
        ApiResponse.success(response, await work(request), statusCode);
      } catch (error) {
        next(error);
      }
    };
  }
}
