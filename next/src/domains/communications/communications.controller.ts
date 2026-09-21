import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import * as schemas from "./communications.schemas.js";
import type { CommunicationsService } from "./communications.service.js";
import type { CommunicationsOperation } from "./communications.types.js";

export class CommunicationsController {
  constructor(private readonly service: CommunicationsService) {}

  // Domains
  readonly listDomains = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    return { domains: await this.service.listDomains(this.operation(request, businessId)) };
  });
  readonly addDomain = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    const { domain } = schemas.addDomainSchema.parse(request.body);
    return { domain: await this.service.addDomain(this.operation(request, businessId), domain) };
  }, 201);
  readonly verifyDomain = this.handle(async (request) => {
    const { businessId, domainId } = schemas.domainParamsSchema.parse(request.params);
    return { domain: await this.service.verifyDomain(this.operation(request, businessId), domainId) };
  });
  readonly deleteDomain = this.handle(async (request) => {
    const { businessId, domainId } = schemas.domainParamsSchema.parse(request.params);
    await this.service.deleteDomain(this.operation(request, businessId), domainId);
    return null;
  });

  // Senders
  readonly listSenders = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    return { senders: await this.service.listSenders(this.operation(request, businessId)) };
  });
  readonly createSender = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    return { sender: await this.service.createSender(this.operation(request, businessId), schemas.createSenderSchema.parse(request.body)) };
  }, 201);
  readonly updateSender = this.handle(async (request) => {
    const { businessId, senderId } = schemas.senderParamsSchema.parse(request.params);
    return { sender: await this.service.updateSender(this.operation(request, businessId), senderId, schemas.updateSenderSchema.parse(request.body)) };
  });
  readonly setDefaultSender = this.handle(async (request) => {
    const { businessId, senderId } = schemas.senderParamsSchema.parse(request.params);
    return { sender: await this.service.setDefaultSender(this.operation(request, businessId), senderId) };
  });
  readonly deleteSender = this.handle(async (request) => {
    const { businessId, senderId } = schemas.senderParamsSchema.parse(request.params);
    await this.service.deleteSender(this.operation(request, businessId), senderId);
    return null;
  });

  // Templates
  readonly listTemplates = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    const { channel } = schemas.listTemplatesQuerySchema.parse(request.query);
    return { templates: await this.service.listTemplates(this.operation(request, businessId), channel) };
  });
  readonly createTemplate = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    return { template: await this.service.createTemplate(this.operation(request, businessId), schemas.createTemplateSchema.parse(request.body)) };
  }, 201);
  readonly updateTemplate = this.handle(async (request) => {
    const { businessId, templateId } = schemas.templateParamsSchema.parse(request.params);
    return { template: await this.service.updateTemplate(this.operation(request, businessId), templateId, schemas.updateTemplateSchema.parse(request.body)) };
  });
  readonly deleteTemplate = this.handle(async (request) => {
    const { businessId, templateId } = schemas.templateParamsSchema.parse(request.params);
    await this.service.deleteTemplate(this.operation(request, businessId), templateId);
    return null;
  });

  // Audience segments
  readonly listSegments = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    return { segments: await this.service.listSegments(this.operation(request, businessId)) };
  });
  readonly createSegment = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    return { segment: await this.service.createSegment(this.operation(request, businessId), schemas.createSegmentSchema.parse(request.body)) };
  }, 201);
  readonly updateSegment = this.handle(async (request) => {
    const { businessId, segmentId } = schemas.segmentParamsSchema.parse(request.params);
    return { segment: await this.service.updateSegment(this.operation(request, businessId), segmentId, schemas.updateSegmentSchema.parse(request.body)) };
  });
  readonly deleteSegment = this.handle(async (request) => {
    const { businessId, segmentId } = schemas.segmentParamsSchema.parse(request.params);
    await this.service.deleteSegment(this.operation(request, businessId), segmentId);
    return null;
  });
  readonly listSegmentMembers = this.handle(async (request) => {
    const { businessId, segmentId } = schemas.segmentParamsSchema.parse(request.params);
    return { members: await this.service.listSegmentMembers(this.operation(request, businessId), segmentId) };
  });
  readonly addSegmentMembers = this.handle(async (request) => {
    const { businessId, segmentId } = schemas.segmentParamsSchema.parse(request.params);
    const { partyIds } = schemas.addSegmentMembersSchema.parse(request.body);
    await this.service.addSegmentMembers(this.operation(request, businessId), segmentId, partyIds);
    return null;
  }, 201);
  readonly removeSegmentMember = this.handle(async (request) => {
    const { businessId, segmentId, partyId } = schemas.segmentMemberParamsSchema.parse(request.params);
    await this.service.removeSegmentMember(this.operation(request, businessId), segmentId, partyId);
    return null;
  });

  // Opt-outs
  readonly listOptOuts = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    return { optOuts: await this.service.listOptOuts(this.operation(request, businessId)) };
  });
  readonly optOut = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    const { partyId, channel, reason } = schemas.optOutSchema.parse(request.body);
    return { optOut: await this.service.optOut(this.operation(request, businessId), partyId, channel, reason ?? null) };
  }, 201);
  readonly optIn = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    const { partyId, channel } = schemas.optInSchema.parse(request.body);
    await this.service.optIn(this.operation(request, businessId), partyId, channel);
    return null;
  });

  // Credits
  readonly listPackages = this.handle(() => Promise.resolve({ packages: this.service.listPackages() }));
  readonly getAccount = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    return this.service.getAccount(this.operation(request, businessId));
  });
  readonly initiateTopup = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    return this.service.initiateTopup(this.operation(request, businessId), schemas.initiateTopupSchema.parse(request.body));
  }, 201);

  // Messages
  readonly listMessages = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    return { messages: await this.service.listMessages(this.operation(request, businessId), schemas.listMessagesQuerySchema.parse(request.query)) };
  });
  readonly getMessage = this.handle(async (request) => {
    const { businessId, messageId } = schemas.messageParamsSchema.parse(request.params);
    return this.service.getMessage(this.operation(request, businessId), messageId);
  });
  readonly createMessage = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    return { message: await this.service.createMessage(this.operation(request, businessId), schemas.createMessageSchema.parse(request.body)) };
  }, 201);
  readonly updateMessage = this.handle(async (request) => {
    const { businessId, messageId } = schemas.messageParamsSchema.parse(request.params);
    return { message: await this.service.updateMessage(this.operation(request, businessId), messageId, schemas.updateMessageSchema.parse(request.body)) };
  });
  readonly deleteMessage = this.handle(async (request) => {
    const { businessId, messageId } = schemas.messageParamsSchema.parse(request.params);
    await this.service.deleteMessage(this.operation(request, businessId), messageId);
    return null;
  });
  readonly estimateCost = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    return { estimate: await this.service.estimateCost(this.operation(request, businessId), schemas.estimateCostSchema.parse(request.body)) };
  });
  readonly sendMessage = this.handle(async (request) => {
    const { businessId, messageId } = schemas.messageParamsSchema.parse(request.params);
    return this.service.sendMessage(this.operation(request, businessId), messageId);
  });

  private operation(request: Request, businessId: string): CommunicationsOperation {
    return { userId: requireAuthContext(request).userId, businessId, requestId: request.requestId };
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
