import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import * as schemas from "./compliance.schemas.js";
import type { ComplianceService } from "./compliance.service.js";
import type { ComplianceOperation, PersonalOperation } from "./compliance.types.js";

export class ComplianceController {
  constructor(private readonly service: ComplianceService) {}

  // Legal profile
  readonly getLegalProfile = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    return { legalProfile: await this.service.getLegalProfile(this.operation(request, businessId)) };
  });

  readonly upsertLegalProfile = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    return { legalProfile: await this.service.upsertLegalProfile(this.operation(request, businessId), schemas.upsertLegalProfileSchema.parse(request.body)) };
  });

  // Beneficial owners
  readonly listBeneficialOwners = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    return { beneficialOwners: await this.service.listBeneficialOwners(this.operation(request, businessId)) };
  });

  readonly createBeneficialOwner = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    return { beneficialOwner: await this.service.createBeneficialOwner(this.operation(request, businessId), schemas.createBeneficialOwnerSchema.parse(request.body)) };
  }, 201);

  readonly updateBeneficialOwner = this.handle(async (request) => {
    const { businessId, ownerId } = schemas.ownerParamsSchema.parse(request.params);
    return { beneficialOwner: await this.service.updateBeneficialOwner(this.operation(request, businessId), ownerId, schemas.updateBeneficialOwnerSchema.parse(request.body)) };
  });

  readonly archiveBeneficialOwner = this.handle(async (request) => {
    const { businessId, ownerId } = schemas.ownerParamsSchema.parse(request.params);
    await this.service.archiveBeneficialOwner(this.operation(request, businessId), ownerId);
    return { archived: true };
  });

  // Cases
  readonly listCases = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    return { cases: await this.service.listCases(this.operation(request, businessId)) };
  });

  readonly getCase = this.handle(async (request) => {
    const { businessId, caseId } = schemas.caseParamsSchema.parse(request.params);
    return { case: await this.service.getCase(this.operation(request, businessId), caseId) };
  });

  readonly openCase = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    schemas.openCaseSchema.parse(request.body ?? {});
    return { case: await this.service.openCase(this.operation(request, businessId)) };
  }, 201);

  readonly updateCase = this.handle(async (request) => {
    const { businessId, caseId } = schemas.caseParamsSchema.parse(request.params);
    const { status, notes } = schemas.updateCaseSchema.parse(request.body);
    return { case: await this.service.updateCaseStatus(this.operation(request, businessId), caseId, status, notes) };
  });

  // Documents
  readonly listDocuments = this.handle(async (request) => {
    const { businessId, caseId } = schemas.caseParamsSchema.parse(request.params);
    return { documents: await this.service.listDocuments(this.operation(request, businessId), caseId) };
  });

  readonly addDocument = this.handle(async (request) => {
    const { businessId, caseId } = schemas.caseParamsSchema.parse(request.params);
    return { document: await this.service.addDocument(this.operation(request, businessId), caseId, schemas.createDocumentSchema.parse(request.body)) };
  }, 201);

  // Submissions
  readonly listSubmissions = this.handle(async (request) => {
    const { businessId, caseId } = schemas.caseParamsSchema.parse(request.params);
    return { submissions: await this.service.listSubmissions(this.operation(request, businessId), caseId) };
  });

  readonly recordSubmission = this.handle(async (request) => {
    const { businessId, caseId } = schemas.caseParamsSchema.parse(request.params);
    return { submission: await this.service.recordSubmission(this.operation(request, businessId), caseId, schemas.createSubmissionSchema.parse(request.body)) };
  }, 201);

  // Personal: consents
  readonly listConsents = this.handle(async (request) => ({
    consents: await this.service.listConsents(this.personalOperation(request)),
  }));

  readonly grantConsent = this.handle(async (request) => ({
    consent: await this.service.grantConsent(this.personalOperation(request), schemas.grantConsentSchema.parse(request.body)),
  }), 201);

  readonly revokeConsent = this.handle(async (request) => {
    const { consentId } = schemas.consentParamsSchema.parse(request.params);
    await this.service.revokeConsent(this.personalOperation(request), consentId);
    return { revoked: true };
  });

  // Personal: data-privacy requests
  readonly listPrivacyRequests = this.handle(async (request) => ({
    requests: await this.service.listPrivacyRequests(this.personalOperation(request)),
  }));

  readonly createPrivacyRequest = this.handle(async (request) => ({
    request: await this.service.createPrivacyRequest(this.personalOperation(request), schemas.createPrivacyRequestSchema.parse(request.body)),
  }), 201);

  private operation(request: Request, businessId: string): ComplianceOperation {
    return {
      userId: requireAuthContext(request).userId,
      businessId,
      requestId: request.requestId,
    };
  }

  private personalOperation(request: Request): PersonalOperation {
    return {
      userId: requireAuthContext(request).userId,
      requestId: request.requestId,
    };
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
