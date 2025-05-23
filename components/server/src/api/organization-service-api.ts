/**
 * Copyright (c) 2023 Gitpod GmbH. All rights reserved.
 * Licensed under the GNU Affero General Public License (AGPL).
 * See License.AGPL.txt in the project root for license information.
 */

import { HandlerContext, ServiceImpl } from "@connectrpc/connect";
import { inject, injectable } from "inversify";
import { OrganizationService as OrganizationServiceInterface } from "@gitpod/public-api/lib/gitpod/v1/organization_connect";
import {
    CreateOrganizationRequest,
    CreateOrganizationResponse,
    DeleteOrganizationMemberRequest,
    DeleteOrganizationMemberResponse,
    DeleteOrganizationRequest,
    DeleteOrganizationResponse,
    GetOrganizationInvitationRequest,
    GetOrganizationInvitationResponse,
    GetOrganizationMaintenanceModeRequest,
    GetOrganizationMaintenanceModeResponse,
    GetOrganizationRequest,
    GetOrganizationResponse,
    GetOrganizationSettingsRequest,
    GetOrganizationSettingsResponse,
    GetMaintenanceNotificationRequest,
    GetMaintenanceNotificationResponse,
    JoinOrganizationRequest,
    JoinOrganizationResponse,
    ListOrganizationMembersRequest,
    ListOrganizationMembersResponse,
    ListOrganizationsRequest,
    ListOrganizationsRequest_Scope,
    ListOrganizationsResponse,
    ListOrganizationWorkspaceClassesRequest,
    ListOrganizationWorkspaceClassesResponse,
    ResetOrganizationInvitationRequest,
    ResetOrganizationInvitationResponse,
    SetOrganizationMaintenanceModeRequest,
    SetOrganizationMaintenanceModeResponse,
    SetMaintenanceNotificationRequest,
    SetMaintenanceNotificationResponse,
    UpdateOrganizationMemberRequest,
    UpdateOrganizationMemberResponse,
    UpdateOrganizationRequest,
    UpdateOrganizationResponse,
    UpdateOrganizationSettingsRequest,
    UpdateOrganizationSettingsResponse,
} from "@gitpod/public-api/lib/gitpod/v1/organization_pb";
import { PublicAPIConverter } from "@gitpod/public-api-common/lib/public-api-converter";
import { OrganizationService } from "../orgs/organization-service";
import { OrganizationSettings } from "@gitpod/gitpod-protocol";
import { PaginationResponse } from "@gitpod/public-api/lib/gitpod/v1/pagination_pb";
import { validate as uuidValidate } from "uuid";
import { ctxUserId } from "../util/request-context";
import { ApplicationError, ErrorCodes } from "@gitpod/gitpod-protocol/lib/messaging/error";

@injectable()
export class OrganizationServiceAPI implements ServiceImpl<typeof OrganizationServiceInterface> {
    constructor(
        @inject(OrganizationService)
        private readonly orgService: OrganizationService,
        @inject(PublicAPIConverter)
        private readonly apiConverter: PublicAPIConverter,
    ) {}

    async listOrganizationWorkspaceClasses(
        req: ListOrganizationWorkspaceClassesRequest,
        _: HandlerContext,
    ): Promise<ListOrganizationWorkspaceClassesResponse> {
        if (!uuidValidate(req.organizationId)) {
            throw new ApplicationError(ErrorCodes.BAD_REQUEST, "organizationId is required");
        }
        const list = await this.orgService.listWorkspaceClasses(ctxUserId(), req.organizationId);
        return new ListOrganizationWorkspaceClassesResponse({
            workspaceClasses: list.map((e) => this.apiConverter.toWorkspaceClass(e)),
        });
    }

    async createOrganization(req: CreateOrganizationRequest, _: HandlerContext): Promise<CreateOrganizationResponse> {
        // TODO(gpl) This mimicks the current behavior of adding the subjectId as owner
        const ownerId = ctxUserId();
        if (!ownerId) {
            throw new ApplicationError(ErrorCodes.BAD_REQUEST, "No userId available");
        }
        const org = await this.orgService.createOrganization(ownerId, req.name);
        const response = new CreateOrganizationResponse();
        response.organization = this.apiConverter.toOrganization(org);
        return response;
    }

    async getOrganization(req: GetOrganizationRequest, _: HandlerContext): Promise<GetOrganizationResponse> {
        if (!uuidValidate(req.organizationId)) {
            throw new ApplicationError(ErrorCodes.BAD_REQUEST, "organizationId is required");
        }

        const org = await this.orgService.getOrganization(ctxUserId(), req.organizationId);
        const response = new GetOrganizationResponse();
        response.organization = this.apiConverter.toOrganization(org);
        return response;
    }

    async updateOrganization(req: UpdateOrganizationRequest, _: HandlerContext): Promise<UpdateOrganizationResponse> {
        if (!uuidValidate(req.organizationId)) {
            throw new ApplicationError(ErrorCodes.BAD_REQUEST, "organizationId is required");
        }
        if (typeof req.name !== "string") {
            throw new ApplicationError(ErrorCodes.BAD_REQUEST, "nothing to update");
        }

        const org = await this.orgService.updateOrganization(ctxUserId(), req.organizationId, {
            name: req.name,
        });
        return new UpdateOrganizationResponse({
            organization: this.apiConverter.toOrganization(org),
        });
    }

    async listOrganizations(req: ListOrganizationsRequest, _: HandlerContext): Promise<ListOrganizationsResponse> {
        const orgs = await this.orgService.listOrganizations(
            ctxUserId(),
            {
                limit: req.pagination?.pageSize || 100,
                offset: (req.pagination?.page || 0) * (req.pagination?.pageSize || 0),
            },
            req.scope === ListOrganizationsRequest_Scope.ALL ? "installation" : "member",
        );
        const response = new ListOrganizationsResponse();
        response.organizations = orgs.rows.map((org) => this.apiConverter.toOrganization(org));
        response.pagination = new PaginationResponse();
        response.pagination.total = orgs.total;
        return response;
    }

    async deleteOrganization(req: DeleteOrganizationRequest, _: HandlerContext): Promise<DeleteOrganizationResponse> {
        if (!uuidValidate(req.organizationId)) {
            throw new ApplicationError(ErrorCodes.BAD_REQUEST, "organizationId is required");
        }

        await this.orgService.deleteOrganization(ctxUserId(), req.organizationId);
        return new DeleteOrganizationResponse();
    }

    async getOrganizationInvitation(
        req: GetOrganizationInvitationRequest,
        _: HandlerContext,
    ): Promise<GetOrganizationInvitationResponse> {
        if (!uuidValidate(req.organizationId)) {
            throw new ApplicationError(ErrorCodes.BAD_REQUEST, "organizationId is required");
        }

        const invitation = await this.orgService.getOrCreateInvite(ctxUserId(), req.organizationId);
        const response = new GetOrganizationInvitationResponse();
        response.invitationId = invitation.id;
        return response;
    }

    async joinOrganization(req: JoinOrganizationRequest, _: HandlerContext): Promise<JoinOrganizationResponse> {
        if (!uuidValidate(req.invitationId)) {
            throw new ApplicationError(ErrorCodes.BAD_REQUEST, "invitationId is required");
        }

        const orgId = await this.orgService.joinOrganization(ctxUserId(), req.invitationId);
        const result = new JoinOrganizationResponse();
        result.organizationId = orgId;
        return result;
    }

    async resetOrganizationInvitation(
        req: ResetOrganizationInvitationRequest,
        _: HandlerContext,
    ): Promise<ResetOrganizationInvitationResponse> {
        if (!uuidValidate(req.organizationId)) {
            throw new ApplicationError(ErrorCodes.BAD_REQUEST, "organizationId is required");
        }

        const inviteId = await this.orgService.resetInvite(ctxUserId(), req.organizationId);
        const result = new ResetOrganizationInvitationResponse();
        result.invitationId = inviteId.id;
        return result;
    }

    async listOrganizationMembers(
        req: ListOrganizationMembersRequest,
        _: HandlerContext,
    ): Promise<ListOrganizationMembersResponse> {
        if (!uuidValidate(req.organizationId)) {
            throw new ApplicationError(ErrorCodes.BAD_REQUEST, "organizationId is required");
        }

        const members = await this.orgService.listMembers(ctxUserId(), req.organizationId);
        //TODO pagination
        const response = new ListOrganizationMembersResponse();
        response.members = members.map((member) => this.apiConverter.toOrganizationMember(member));
        response.pagination = new PaginationResponse();
        response.pagination.total = members.length;
        return response;
    }

    async updateOrganizationMember(
        req: UpdateOrganizationMemberRequest,
        _: HandlerContext,
    ): Promise<UpdateOrganizationMemberResponse> {
        if (!uuidValidate(req.organizationId)) {
            throw new ApplicationError(ErrorCodes.BAD_REQUEST, "organizationId is required");
        }
        if (!uuidValidate(req.userId)) {
            throw new ApplicationError(ErrorCodes.BAD_REQUEST, "userId is required");
        }
        if (req.role === undefined) {
            throw new ApplicationError(ErrorCodes.BAD_REQUEST, "nothing to update");
        }

        await this.orgService.addOrUpdateMember(
            ctxUserId(),
            req.organizationId,
            req.userId,
            this.apiConverter.fromOrgMemberRole(req.role),
        );
        const member = await this.orgService
            .listMembers(ctxUserId(), req.organizationId)
            .then((members) => members.find((member) => member.userId === req.userId));
        return new UpdateOrganizationMemberResponse({
            member: member && this.apiConverter.toOrganizationMember(member),
        });
    }

    async deleteOrganizationMember(
        req: DeleteOrganizationMemberRequest,
        _: HandlerContext,
    ): Promise<DeleteOrganizationMemberResponse> {
        if (!uuidValidate(req.organizationId)) {
            throw new ApplicationError(ErrorCodes.BAD_REQUEST, "organizationId is required");
        }
        if (!uuidValidate(req.userId)) {
            throw new ApplicationError(ErrorCodes.BAD_REQUEST, "userId is required");
        }

        await this.orgService.removeOrganizationMember(ctxUserId(), req.organizationId, req.userId);
        return new DeleteOrganizationMemberResponse();
    }

    async getOrganizationSettings(
        req: GetOrganizationSettingsRequest,
        _: HandlerContext,
    ): Promise<GetOrganizationSettingsResponse> {
        if (!uuidValidate(req.organizationId)) {
            throw new ApplicationError(ErrorCodes.BAD_REQUEST, "organizationId is required");
        }

        const settings = await this.orgService.getSettingsWithResolvedWelcomeMessage(ctxUserId(), req.organizationId);
        const response = new GetOrganizationSettingsResponse();
        response.settings = this.apiConverter.toOrganizationSettings(settings);

        return response;
    }

    async updateOrganizationSettings(
        req: UpdateOrganizationSettingsRequest,
        _: HandlerContext,
    ): Promise<UpdateOrganizationSettingsResponse> {
        if (!uuidValidate(req.organizationId)) {
            throw new ApplicationError(ErrorCodes.BAD_REQUEST, "organizationId is required");
        }

        if (req.restrictedEditorNames.length > 0 && !req.updateRestrictedEditorNames) {
            throw new ApplicationError(
                ErrorCodes.BAD_REQUEST,
                "updateRestrictedEditorNames is required to be true to update restrictedEditorNames",
            );
        }

        if (req.allowedWorkspaceClasses.length > 0 && !req.updateAllowedWorkspaceClasses) {
            throw new ApplicationError(
                ErrorCodes.BAD_REQUEST,
                "updateAllowedWorkspaceClasses is required to be true to update allowedWorkspaceClasses",
            );
        }

        if (
            req.pinnedEditorVersions &&
            Object.keys(req.pinnedEditorVersions).length > 0 &&
            !req.updatePinnedEditorVersions
        ) {
            throw new ApplicationError(
                ErrorCodes.BAD_REQUEST,
                "updatePinnedEditorVersions is required to be true to update pinnedEditorVersions",
            );
        }

        if (req.roleRestrictions.length > 0 && !req.updateRoleRestrictions) {
            throw new ApplicationError(
                ErrorCodes.BAD_REQUEST,
                "updateRoleRestrictions is required to be true when updating roleRestrictions",
            );
        }
        if (
            req.onboardingSettings &&
            req.onboardingSettings.recommendedRepositories.length > 0 &&
            !req.onboardingSettings.updateRecommendedRepositories
        ) {
            throw new ApplicationError(
                ErrorCodes.BAD_REQUEST,
                "recommendedRepositories can only be set when updateRecommendedRepositories is true",
            );
        }

        // convert to internal type, mapping any errors to BAD_REQUEST as it's only doing conversions anyway
        let update: OrganizationSettings;
        try {
            update = this.apiConverter.fromOrganizationSettings(req);
        } catch (err) {
            let msg = "conversion error";
            if (err.message) {
                msg += ": " + err.message;
            }
            throw new ApplicationError(ErrorCodes.BAD_REQUEST, msg);
        }

        const updatedSettings = await this.orgService.updateSettings(ctxUserId(), req.organizationId, update);
        return new UpdateOrganizationSettingsResponse({
            settings: this.apiConverter.toOrganizationSettings(updatedSettings),
        });
    }

    async getOrganizationMaintenanceMode(
        req: GetOrganizationMaintenanceModeRequest,
        _: HandlerContext,
    ): Promise<GetOrganizationMaintenanceModeResponse> {
        if (!uuidValidate(req.organizationId)) {
            throw new ApplicationError(ErrorCodes.BAD_REQUEST, "organizationId is required");
        }

        const enabled = await this.orgService.getMaintenanceMode(ctxUserId(), req.organizationId);
        return new GetOrganizationMaintenanceModeResponse({
            enabled,
        });
    }

    async setOrganizationMaintenanceMode(
        req: SetOrganizationMaintenanceModeRequest,
        _: HandlerContext,
    ): Promise<SetOrganizationMaintenanceModeResponse> {
        if (!uuidValidate(req.organizationId)) {
            throw new ApplicationError(ErrorCodes.BAD_REQUEST, "organizationId is required");
        }

        const enabled = await this.orgService.setMaintenanceMode(ctxUserId(), req.organizationId, req.enabled);
        return new SetOrganizationMaintenanceModeResponse({
            enabled,
        });
    }

    async getMaintenanceNotification(
        req: GetMaintenanceNotificationRequest,
        _: HandlerContext,
    ): Promise<GetMaintenanceNotificationResponse> {
        if (!uuidValidate(req.organizationId)) {
            throw new ApplicationError(ErrorCodes.BAD_REQUEST, "organizationId is required");
        }

        const settings = await this.orgService.getMaintenanceNotification(ctxUserId(), req.organizationId);
        return new GetMaintenanceNotificationResponse({
            isEnabled: settings.enabled,
            message: settings.message,
        });
    }

    async setMaintenanceNotification(
        req: SetMaintenanceNotificationRequest,
        _: HandlerContext,
    ): Promise<SetMaintenanceNotificationResponse> {
        if (!uuidValidate(req.organizationId)) {
            throw new ApplicationError(ErrorCodes.BAD_REQUEST, "organizationId is required");
        }

        const settings = await this.orgService.setMaintenanceNotification(
            ctxUserId(),
            req.organizationId,
            req.isEnabled,
            req.customMessage,
        );

        return new SetMaintenanceNotificationResponse({
            isEnabled: settings.enabled,
            message: settings.message,
        });
    }
}
