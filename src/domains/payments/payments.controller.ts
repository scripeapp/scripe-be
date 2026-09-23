import type {NextFunction,Request,Response} from "express"; import {requireAuthContext} from "../../middleware/auth.js"; import {ApiResponse} from "../../shared/api-response.js"; import * as s from "./payments.schemas.js"; import type {PaymentsService} from "./payments.service.js";
export class PaymentsController{constructor(private readonly service:PaymentsService){} readonly record=this.handle(async req=>{const p=s.params.parse(req.params);return{payment:await this.service.record({userId:requireAuthContext(req).userId,businessId:p.businessId,requestId:req.requestId},s.recordPayment.parse(req.body))}},201);

  readonly initiateCheckout = this.handle(async (request) => {
    const { businessId } = s.params.parse(request.params);
    const checkout = await this.service.initiateCheckout(
      { userId: requireAuthContext(request).userId, businessId, requestId: request.requestId },
      s.initiateCheckout.parse(request.body),
    );
    return { checkout };
  }, 201);

  readonly verifyCheckout = this.handle(async (request) => {
    const { businessId, reference } = s.checkoutParams.parse(request.params);
    const status = await this.service.verifyCheckout({ userId: requireAuthContext(request).userId, businessId, requestId: request.requestId }, reference);
    return { checkout: status };
  });

  readonly list = this.handle(async (request) => {
    const { businessId } = s.params.parse(request.params);
    const filter = s.listPaymentsQuery.parse(request.query);
    const result = await this.service.listPayments(
      { userId: requireAuthContext(request).userId, businessId, requestId: request.requestId },
      filter,
    );
    return { payments: result.payments, totalCount: result.totalCount };
  });

  readonly get = this.handle(async (request) => {
    const { businessId, paymentId } = s.paymentParams.parse(request.params);
    const payment = await this.service.getPayment(
      { userId: requireAuthContext(request).userId, businessId, requestId: request.requestId },
      paymentId,
    );
    return { payment };
  });

  private handle<T>(w:(r:Request)=>Promise<T>,status=200){return async(r:Request,res:Response,next:NextFunction)=>{try{ApiResponse.success(res,await w(r),status)}catch(e){next(e)}}}}
