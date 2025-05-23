/**
 * Copyright (c) 2023 Gitpod GmbH. All rights reserved.
 * Licensed under the GNU Affero General Public License (AGPL).
 * See License.AGPL.txt in the project root for license information.
 */

import { BUILTIN_INSTLLATION_ADMIN_USER_ID, TeamDB, UserDB } from "@gitpod/gitpod-db/lib";
import {
    OrgMemberInfo,
    Organization,
    OrganizationSettings,
    TeamMemberRole,
    TeamMembershipInvite,
    WorkspaceTimeoutDuration,
    OrgMemberRole,
    User,
    MaintenanceNotification,
} from "@gitpod/gitpod-protocol";
import { IAnalyticsWriter } from "@gitpod/gitpod-protocol/lib/analytics";
import { ApplicationError, ErrorCodes } from "@gitpod/gitpod-protocol/lib/messaging/error";
import { log } from "@gitpod/gitpod-protocol/lib/util/logging";
import { inject, injectable } from "inversify";
import { Authorizer, SYSTEM_USER, SYSTEM_USER_ID } from "../authorization/authorizer";
import { ProjectsService } from "../projects/projects-service";
import { TransactionalContext } from "@gitpod/gitpod-db/lib/typeorm/transactional-db-impl";
import { DefaultWorkspaceImageValidator } from "./default-workspace-image-validator";
import { getPrimaryEmail } from "@gitpod/public-api-common/lib/user-utils";
import { UserService } from "../user/user-service";
import { SupportedWorkspaceClass } from "@gitpod/gitpod-protocol/lib/workspace-class";
import { InstallationService } from "../auth/installation-service";
import { getExperimentsClientForBackend } from "@gitpod/gitpod-protocol/lib/experiments/configcat-server";
import { runWithSubjectId } from "../util/request-context";
import { IDEService } from "../ide-service";
import { StripeService } from "../billing/stripe-service";
import { AttributionId } from "@gitpod/gitpod-protocol/lib/attribution";
import { UsageService } from "./usage-service";
import { CostCenter_BillingStrategy } from "@gitpod/gitpod-protocol/lib/usage";
import { CreateUserParams, UserAuthentication } from "../user/user-authentication";
import isURL from "validator/lib/isURL";
import { merge } from "ts-deepmerge";
import { EntitlementService } from "../billing/entitlement-service";

@injectable()
export class OrganizationService {
    constructor(
        @inject(TeamDB) private readonly teamDB: TeamDB,
        @inject(UserDB) private readonly userDB: UserDB,
        @inject(UserService) private readonly userService: UserService,
        @inject(ProjectsService) private readonly projectsService: ProjectsService,
        @inject(Authorizer) private readonly auth: Authorizer,
        @inject(IAnalyticsWriter) private readonly analytics: IAnalyticsWriter,
        @inject(InstallationService) private readonly installationService: InstallationService,
        @inject(IDEService) private readonly ideService: IDEService,
        @inject(StripeService) private readonly stripeService: StripeService,
        @inject(UsageService) private readonly usageService: UsageService,
        @inject(DefaultWorkspaceImageValidator)
        private readonly validateDefaultWorkspaceImage: DefaultWorkspaceImageValidator,
        @inject(UserAuthentication) private readonly userAuthentication: UserAuthentication,
        @inject(EntitlementService) private readonly entitlementService: EntitlementService,
    ) {}

    async listOrganizations(
        userId: string,
        req: {
            offset?: number;
            limit?: number;
            orderBy?: keyof Organization;
            orderDir?: "asc" | "desc";
            searchTerm?: string;
        },
        scope?: "member" | "installation",
    ): Promise<{ total: number; rows: Organization[] }> {
        if (scope !== "installation") {
            let result = await this.listOrganizationsByMember(userId, userId);
            result = result.filter((o) => o.name.toLowerCase().includes((req.searchTerm || "").toLowerCase()));
            // apply ordering
            if (req.orderBy) {
                result.sort((a, b) => {
                    const aVal = a[req.orderBy!];
                    const bVal = b[req.orderBy!];
                    if (!aVal && !bVal) {
                        return 0;
                    }
                    if (!aVal) {
                        return req.orderDir === "asc" ? -1 : 1;
                    }
                    if (!bVal) {
                        return req.orderDir === "asc" ? 1 : -1;
                    }
                    if (aVal < bVal) {
                        return req.orderDir === "asc" ? -1 : 1;
                    }
                    if (aVal > bVal) {
                        return req.orderDir === "asc" ? 1 : -1;
                    }
                    return 0;
                });
            }
            return {
                total: result.length,
                rows: result.slice(req.offset || 0, (req.offset || 0) + (req.limit || 50)),
            };
        }
        const result = await this.teamDB.findTeams(
            req.offset || 0,
            req.limit || 50,
            req.orderBy || "creationTime",
            req.orderDir === "asc" ? "ASC" : "DESC",
            req.searchTerm,
        );

        await Promise.all(
            result.rows.map(async (org) => {
                // if the user doesn't see the org, filter it out
                if (!(await this.auth.hasPermissionOnOrganization(userId, "read_info", org.id))) {
                    result.total--;
                    result.rows = result.rows.filter((o) => o.id !== org.id);
                }
            }),
        );

        return result;
    }

    async listOrganizationsByMember(userId: string, memberId: string): Promise<Organization[]> {
        await this.auth.checkPermissionOnUser(userId, "read_info", memberId);
        const orgs = await this.teamDB.findTeamsByUser(memberId);
        const result: Organization[] = [];
        for (const org of orgs) {
            if (await this.auth.hasPermissionOnOrganization(userId, "read_info", org.id)) {
                result.push(org);
            }
        }
        return result;
    }

    async getOrganization(userId: string, orgId: string): Promise<Organization> {
        await this.auth.checkPermissionOnOrganization(userId, "read_info", orgId);
        const result = await this.teamDB.findTeamById(orgId);
        if (!result) {
            throw new ApplicationError(ErrorCodes.NOT_FOUND, `Organization ${orgId} not found`);
        }
        return result;
    }

    async updateOrganization(
        userId: string,
        orgId: string,
        changes: Partial<Pick<Organization, "name" | "maintenanceMode" | "maintenanceNotification">>,
    ): Promise<Organization> {
        await this.auth.checkPermissionOnOrganization(userId, "write_info", orgId);
        return this.teamDB.updateTeam(orgId, changes);
    }

    async createOrganization(userId: string, name: string): Promise<Organization> {
        // TODO(gpl): Should we use the authorization layer to make this decision?
        const user = await this.userDB.findUserById(userId);
        if (!user) {
            throw new ApplicationError(ErrorCodes.NOT_AUTHENTICATED, `User not authenticated. Please login.`);
        }
        const mayCreateOrganization = await this.userAuthentication.mayCreateOrganization(user);
        if (!mayCreateOrganization) {
            throw new ApplicationError(
                ErrorCodes.PERMISSION_DENIED,
                "Organizational accounts are not allowed to create new organizations",
            );
        }

        let result: Organization;
        try {
            result = await this.teamDB.transaction(async (db) => {
                result = await db.createTeam(userId, name);
                const members = await db.findMembersByTeam(result.id);
                await this.auth.addOrganization(userId, result.id, members, []);
                return result;
            });
        } catch (err) {
            if (result! && result.id) {
                await this.auth.removeOrganizationRole(result.id, userId, "member");
            }

            throw err;
        }
        try {
            const invite = await this.teamDB.resetGenericInvite(result.id);
            this.analytics.track({
                userId,
                event: "team_created",
                properties: {
                    id: result.id,
                    name: result.name,
                    created_at: result.creationTime,
                    invite_id: invite.id,
                },
            });
        } catch (error) {
            log.error("Failed to track team_created event.", error);
        }
        return result;
    }

    public async deleteOrganization(userId: string, orgId: string): Promise<void> {
        await this.auth.checkPermissionOnOrganization(userId, "delete", orgId);
        const projects = await this.projectsService.getProjects(userId, orgId);

        const members = await this.teamDB.findMembersByTeam(orgId);
        try {
            await this.teamDB.transaction(async (db, ctx) => {
                for (const project of projects) {
                    await this.projectsService.deleteProject(userId, project.id, ctx);
                }
                for (const member of members) {
                    await db.removeMemberFromTeam(member.userId, orgId);
                }

                await db.deleteTeam(orgId);

                const costCenter = await this.usageService.getCostCenter(userId, orgId);
                if (costCenter.billingStrategy === CostCenter_BillingStrategy.BILLING_STRATEGY_STRIPE) {
                    await this.stripeService.cancelCustomerSubscriptions(AttributionId.createFromOrganizationId(orgId));
                }

                await this.auth.removeAllRelationships(userId, "organization", orgId);
            });
            return this.analytics.track({
                userId: userId,
                event: "team_deleted",
                properties: {
                    team_id: orgId,
                },
            });
        } catch (err) {
            await this.auth.addOrganization(
                userId,
                orgId,
                members,
                projects.map((p) => p.id),
            );
        }
    }

    public async listMembers(userId: string, orgId: string): Promise<OrgMemberInfo[]> {
        await this.auth.checkPermissionOnOrganization(userId, "read_members", orgId);
        const members = await this.teamDB.findMembersByTeam(orgId);

        // TODO(at) remove this workaround once email addresses are persisted under `User.emails`.
        // For now we're avoiding adding `getPrimaryEmail` as dependency to `gitpod-db` module.
        for (const member of members) {
            const user = await this.userDB.findUserById(member.userId);
            if (user) {
                member.primaryEmail = getPrimaryEmail(user);
            }
        }
        return members;
    }

    public async getOrCreateInvite(userId: string, orgId: string): Promise<TeamMembershipInvite> {
        await this.auth.checkPermissionOnOrganization(userId, "invite_members", orgId);
        const invite = await this.teamDB.findGenericInviteByTeamId(orgId);
        if (invite) {
            if (await this.teamDB.hasActiveSSO(orgId)) {
                throw new ApplicationError(ErrorCodes.NOT_FOUND, "Invites are disabled for SSO-enabled organizations.");
            }
            return invite;
        }
        return this.resetInvite(userId, orgId);
    }

    public async resetInvite(userId: string, orgId: string): Promise<TeamMembershipInvite> {
        await this.auth.checkPermissionOnOrganization(userId, "invite_members", orgId);
        if (await this.teamDB.hasActiveSSO(orgId)) {
            throw new ApplicationError(ErrorCodes.NOT_FOUND, "Invites are disabled for SSO-enabled organizations.");
        }
        return this.teamDB.resetGenericInvite(orgId);
    }

    public async joinOrganization(userId: string, inviteId: string): Promise<string> {
        const user = await this.userDB.findUserById(userId);
        if (!user) {
            throw new ApplicationError(ErrorCodes.INTERNAL_SERVER_ERROR, `User ${userId} not found`);
        }

        const mayJoinOrganization = await this.userAuthentication.mayJoinOrganization(user);
        if (!mayJoinOrganization) {
            throw new ApplicationError(
                ErrorCodes.PERMISSION_DENIED,
                "Organizational accounts are not allowed to join other organizations",
            );
        }

        // Invites can be used by anyone, as long as they know the invite ID, hence needs no resource guard
        const invite = await this.teamDB.findTeamMembershipInviteById(inviteId);
        if (!invite || invite.invalidationTime !== "") {
            throw new ApplicationError(ErrorCodes.NOT_FOUND, "The invite link is no longer valid.");
        }
        if (await this.teamDB.hasActiveSSO(invite.teamId)) {
            throw new ApplicationError(ErrorCodes.NOT_FOUND, "Invites are disabled for SSO-enabled organizations.");
        }

        // set skipRoleUpdate=true to avoid member/owner click join link again cause role change
        await runWithSubjectId(SYSTEM_USER, () =>
            this.addOrUpdateMember(SYSTEM_USER_ID, invite.teamId, userId, invite.role, {
                flexibleRole: true,
                skipRoleUpdate: true,
            }),
        );

        try {
            // verify the new member if this org is a paying customer
            if (
                (await this.stripeService.findUncancelledSubscriptionByAttributionId(
                    AttributionId.render({ kind: "team", teamId: invite.teamId }),
                )) !== undefined
            ) {
                await this.userService.markUserAsVerified(user, undefined);
            }
        } catch (e) {
            log.warn("Failed to verify new org member", e);
        }

        this.analytics.track({
            userId: userId,
            event: "team_joined",
            properties: {
                team_id: invite.teamId,
                invite_id: inviteId,
            },
        });

        return invite.teamId;
    }

    /**
     * Convenience method, analogue to UserService.createUser()
``
     */
    public async createOrgOwnedUser(params: CreateUserParams & { organizationId: string }): Promise<User> {
        return this.userDB.transaction(async (_, ctx) => {
            const user = await this.userService.createUser(params, ctx);

            await this.addOrUpdateMember(
                SYSTEM_USER_ID,
                params.organizationId,
                user.id,
                "member",
                { flexibleRole: true },
                ctx,
            );
            return user;
        });
    }

    /**
     * Add or update member to an organization, if there's no `owner` in the organization, target role will be owner
     *
     * @param opts.flexibleRole when target role is not owner, target role is flexible. Is affected by:
     *     - `dataops` feature
     * @param opts.notUpdate don't update role
     */
    public async addOrUpdateMember(
        userId: string,
        orgId: string,
        memberId: string,
        role: OrgMemberRole,
        opts?: { flexibleRole?: boolean; skipRoleUpdate?: true },
        txCtx?: TransactionalContext,
    ): Promise<void> {
        await this.auth.checkPermissionOnOrganization(userId, "write_members", orgId);
        const orgSettings = await this.getSettings(userId, orgId);
        let members: OrgMemberInfo[] = [];
        try {
            await this.teamDB.transaction(txCtx, async (teamDB, txCtx) => {
                members = await teamDB.findMembersByTeam(orgId);
                const hasOtherRegularOwners =
                    members.filter(
                        (m) =>
                            m.userId !== BUILTIN_INSTLLATION_ADMIN_USER_ID && //
                            m.userId !== memberId && //
                            m.role === "owner",
                    ).length > 0;
                if (!hasOtherRegularOwners) {
                    // first regular member is going to be an owner
                    role = "owner";
                    log.info({ userId: memberId }, "First member of organization, setting role to owner.");
                }

                const result = await teamDB.addMemberToTeam(memberId, orgId);
                if (result === "already_member" && opts?.skipRoleUpdate) {
                    return;
                }

                if (role !== "owner" && opts?.flexibleRole) {
                    const isDataOps = await getExperimentsClientForBackend().getValueAsync("dataops", false, {
                        teamId: orgId,
                    });
                    if (isDataOps) {
                        role = "collaborator";
                    } else if (orgSettings.defaultRole) {
                        role = orgSettings.defaultRole;
                    }
                }
                await teamDB.setTeamMemberRole(memberId, orgId, role);
                await this.auth.addOrganizationRole(orgId, memberId, role);
                // we can remove the built-in installation admin if we have added an owner
                if (!hasOtherRegularOwners && members.some((m) => m.userId === BUILTIN_INSTLLATION_ADMIN_USER_ID)) {
                    try {
                        await runWithSubjectId(SYSTEM_USER, async () => {
                            return this.removeOrganizationMember(
                                SYSTEM_USER_ID,
                                orgId,
                                BUILTIN_INSTLLATION_ADMIN_USER_ID,
                                txCtx,
                            );
                        });
                    } catch (error) {
                        log.warn("Failed to remove built-in installation admin from organization.", error);
                    }
                }
            });
        } catch (err) {
            // remove target role and add old role back
            await this.auth.removeOrganizationRole(orgId, memberId, role);
            const oldRole = members.find((m) => m.userId === memberId)?.role;
            if (oldRole) {
                await this.auth.addOrganizationRole(orgId, memberId, oldRole);
            }
            throw err;
        }
    }

    public async removeOrganizationMember(
        userId: string,
        orgId: string,
        memberId: string,
        txCtx?: TransactionalContext,
    ): Promise<void> {
        // The user is leaving a team, if they are removing themselves from the team.
        if (userId === memberId) {
            await this.auth.checkPermissionOnOrganization(userId, "read_info", orgId);
        } else {
            await this.auth.checkPermissionOnOrganization(userId, "write_members", orgId);
        }
        let membership: OrgMemberInfo | undefined;
        try {
            await this.teamDB.transaction(txCtx, async (db) => {
                // Check for existing membership.
                const members = await db.findMembersByTeam(orgId);
                // cannot remove last owner
                if (!members.some((m) => m.userId !== memberId && m.role === "owner")) {
                    throw new ApplicationError(ErrorCodes.CONFLICT, "Cannot remove the last owner of an organization.");
                }

                membership = members.find((m) => m.userId === memberId);
                if (!membership) {
                    throw new ApplicationError(
                        ErrorCodes.NOT_FOUND,
                        `Could not find membership for user '${memberId}' in organization '${orgId}'`,
                    );
                }

                // Check if user's account belongs to the Org.
                const userToBeRemoved = await this.userDB.findUserById(memberId);
                if (!userToBeRemoved) {
                    throw new ApplicationError(ErrorCodes.NOT_FOUND, `Could not find user '${memberId}'`);
                }
                // Only invited members can be removed from the Org, but organizational accounts cannot.
                if (userToBeRemoved.organizationId && orgId === userToBeRemoved.organizationId) {
                    await this.userService.deleteUser(userId, memberId);
                }
                await db.removeMemberFromTeam(userToBeRemoved.id, orgId);
                await this.auth.removeOrganizationRole(orgId, memberId, membership.role);
            });
        } catch (err) {
            if (membership) {
                // Rollback to the original role the user had
                await this.auth.addOrganizationRole(orgId, memberId, membership.role);
            }
            const code = ApplicationError.hasErrorCode(err) ? err.code : ErrorCodes.INTERNAL_SERVER_ERROR;
            const message = ApplicationError.hasErrorCode(err) ? err.message : "" + err;
            throw new ApplicationError(code, message);
        }
        this.analytics.track({
            userId,
            event: "team_user_removed",
            properties: {
                team_id: orgId,
                removed_user_id: memberId,
            },
        });
    }

    async getSettings(userId: string, orgId: string): Promise<OrganizationSettings> {
        await this.auth.checkPermissionOnOrganization(userId, "read_settings", orgId);
        const settings = await this.teamDB.findOrgSettings(orgId);
        return this.toSettings(settings);
    }

    async updateSettings(
        userId: string,
        orgId: string,
        settings: Partial<OrganizationSettings>,
    ): Promise<OrganizationSettings> {
        await this.auth.checkPermissionOnOrganization(userId, "write_settings", orgId);

        if (typeof settings.defaultWorkspaceImage === "string") {
            const defaultWorkspaceImage = settings.defaultWorkspaceImage.trim();
            if (defaultWorkspaceImage) {
                await this.validateDefaultWorkspaceImage(userId, defaultWorkspaceImage, orgId);
            }
            settings = { ...settings, defaultWorkspaceImage };
        }

        if (settings.allowedWorkspaceClasses) {
            if (settings.allowedWorkspaceClasses.length > 0) {
                const allClasses = await this.installationService.getInstallationWorkspaceClasses(userId);
                const availableClasses = allClasses.filter((e) => settings.allowedWorkspaceClasses!.includes(e.id));
                if (availableClasses.length !== settings.allowedWorkspaceClasses.length) {
                    throw new ApplicationError(
                        ErrorCodes.BAD_REQUEST,
                        `items in allowedWorkspaceClasses are not all allowed`,
                    );
                }
                if (availableClasses.length === 0) {
                    throw new ApplicationError(
                        ErrorCodes.BAD_REQUEST,
                        "at least one workspace class has to be selected.",
                    );
                }
            }
        }
        if (settings.pinnedEditorVersions) {
            const ideConfig = await this.ideService.getIDEConfig({ user: { id: userId } });
            for (const [key, version] of Object.entries(settings.pinnedEditorVersions)) {
                if (
                    !ideConfig.ideOptions.options[key] ||
                    !ideConfig.ideOptions.options[key].versions?.find((v) => v.version === version)
                ) {
                    throw new ApplicationError(ErrorCodes.BAD_REQUEST, "invalid ide or ide version.");
                }
            }
        }

        if (settings.restrictedEditorNames) {
            if (settings.restrictedEditorNames.length > 0) {
                await this.ideService.checkEditorsAllowed(userId, settings.restrictedEditorNames);
            }
        }

        if (settings.defaultRole && !TeamMemberRole.isValid(settings.defaultRole)) {
            throw new ApplicationError(ErrorCodes.BAD_REQUEST, "Invalid default role");
        }

        if (settings.timeoutSettings?.inactivity) {
            try {
                WorkspaceTimeoutDuration.validate(settings.timeoutSettings.inactivity);
            } catch (error) {
                throw new ApplicationError(ErrorCodes.BAD_REQUEST, `Invalid inactivity timeout: ${error.message}`);
            }
        }

        if (settings.maxParallelRunningWorkspaces !== undefined) {
            if (settings.maxParallelRunningWorkspaces < 0) {
                throw new ApplicationError(ErrorCodes.BAD_REQUEST, "maxParallelRunningWorkspaces must be >= 0");
            }
            const maxAllowance = await this.entitlementService.getMaxParallelWorkspaces(userId, orgId);
            if (maxAllowance && settings.maxParallelRunningWorkspaces > maxAllowance) {
                throw new ApplicationError(
                    ErrorCodes.BAD_REQUEST,
                    `maxParallelRunningWorkspaces must be <= ${maxAllowance}`,
                );
            }
            if (!Number.isInteger(settings.maxParallelRunningWorkspaces)) {
                throw new ApplicationError(ErrorCodes.BAD_REQUEST, "maxParallelRunningWorkspaces must be an integer");
            }
        }

        if (settings.onboardingSettings) {
            if (settings.onboardingSettings.internalLink) {
                if (settings.onboardingSettings.internalLink.length > 255) {
                    throw new ApplicationError(ErrorCodes.BAD_REQUEST, "internalLink must be <= 255 characters long");
                }

                if (
                    !isURL(settings.onboardingSettings.internalLink, {
                        require_protocol: true,
                        host_blacklist: ["localhost", "127.0.0.1", "::1"],
                    })
                ) {
                    throw new ApplicationError(ErrorCodes.BAD_REQUEST, "Invalid internal link");
                }
            }

            if (settings.onboardingSettings.recommendedRepositories) {
                if (settings.onboardingSettings.recommendedRepositories.length > 3) {
                    throw new ApplicationError(
                        ErrorCodes.BAD_REQUEST,
                        "there can't be more than 3 recommendedRepositories",
                    );
                }
                for (const configurationId of settings.onboardingSettings.recommendedRepositories) {
                    const project = await this.projectsService.getProject(userId, configurationId);
                    if (!project) {
                        throw new ApplicationError(ErrorCodes.BAD_REQUEST, `repository ${configurationId} not found`);
                    }
                }
            }

            if (settings.onboardingSettings.welcomeMessage) {
                const welcomeMessage = settings.onboardingSettings.welcomeMessage;
                if (welcomeMessage.featuredMemberResolvedAvatarUrl) {
                    throw new ApplicationError(
                        ErrorCodes.BAD_REQUEST,
                        "featuredMemberResolvedAvatarUrl is not allowed to be set",
                    );
                }
                if (welcomeMessage.featuredMemberId) {
                    const resolved = await this.resolveMemberAvatarUrl(orgId, settings);
                    if (!resolved) {
                        throw new ApplicationError(
                            ErrorCodes.BAD_REQUEST,
                            "cannot resolve featuredMemberId: user not found",
                        );
                    }
                } else if (welcomeMessage.featuredMemberId === "") {
                    // re-set to default value
                    welcomeMessage.featuredMemberResolvedAvatarUrl = "";
                }
            }
        }

        const mergeSettings = (
            currentSettings: OrganizationSettings,
            partialUpdate: Partial<OrganizationSettings>,
        ): OrganizationSettings => {
            // We want to deep-merge columns that are JSON shapes here.
            // We ignore fields set to undefined, and don't merge arrays to match our API semantics
            const settings = merge.withOptions(
                { mergeArrays: false, allowUndefinedOverrides: false },
                currentSettings,
                partialUpdate,
            );

            // roleRestrictions is an exception: override if set
            if (partialUpdate.roleRestrictions !== undefined) {
                settings.roleRestrictions = partialUpdate.roleRestrictions;
            }

            // pinnedEditorVersions is an exception: override if set
            if (partialUpdate.pinnedEditorVersions !== undefined) {
                settings.pinnedEditorVersions = partialUpdate.pinnedEditorVersions;
            }

            return settings;
        };

        const dbSettings = await this.teamDB.setOrgSettings(orgId, settings, mergeSettings);
        await this.resolveMemberAvatarUrl(orgId, settings);
        return this.toSettings(dbSettings);
    }

    /**
     * In addition to the `getSettings` method, this method also resolves the avatar URL for the featured member in the welcome message.
     */
    async getSettingsWithResolvedWelcomeMessage(userId: string, orgId: string): Promise<OrganizationSettings> {
        const settings = await this.getSettings(userId, orgId);
        await this.resolveMemberAvatarUrl(orgId, settings);
        return settings;
    }

    /**
     * Resolves the avatar URL for a member of an organization.
     * This is not done in methods like `getSettings` directly
     * because we don't need to pay the extra lookup cost for the avatar URL for most requests.
     */
    private async resolveMemberAvatarUrl(orgId: string, settings: OrganizationSettings): Promise<boolean> {
        const featuredMemberId = settings.onboardingSettings?.welcomeMessage?.featuredMemberId;
        if (!featuredMemberId) {
            return false;
        }

        const membership = await this.teamDB.findTeamMembership(featuredMemberId, orgId);
        if (!membership) {
            return false;
        }
        const user = await this.userDB.findUserById(membership.userId);
        if (!user) {
            return false;
        }
        settings.onboardingSettings!.welcomeMessage!.featuredMemberResolvedAvatarUrl = user.avatarUrl;
        return true;
    }

    private async toSettings(settings: OrganizationSettings = {}): Promise<OrganizationSettings> {
        const result: OrganizationSettings = {};
        if (settings.workspaceSharingDisabled) {
            result.workspaceSharingDisabled = settings.workspaceSharingDisabled;
        }
        if (typeof settings.defaultWorkspaceImage === "string") {
            result.defaultWorkspaceImage = settings.defaultWorkspaceImage;
        }
        if (settings.allowedWorkspaceClasses) {
            result.allowedWorkspaceClasses = settings.allowedWorkspaceClasses;
        }
        if (settings.pinnedEditorVersions) {
            result.pinnedEditorVersions = settings.pinnedEditorVersions;
        }
        if (settings.restrictedEditorNames) {
            result.restrictedEditorNames = settings.restrictedEditorNames;
        }
        if (settings.defaultRole) {
            result.defaultRole = settings.defaultRole;
        }
        if (settings.timeoutSettings) {
            result.timeoutSettings = settings.timeoutSettings;
        }
        if (settings.roleRestrictions) {
            result.roleRestrictions = settings.roleRestrictions;
        }
        if (settings.maxParallelRunningWorkspaces) {
            result.maxParallelRunningWorkspaces = settings.maxParallelRunningWorkspaces;
        }
        if (settings.onboardingSettings) {
            result.onboardingSettings = settings.onboardingSettings;
        }
        if (settings.annotateGitCommits) {
            result.annotateGitCommits = settings.annotateGitCommits;
        }

        return result;
    }

    /**
     * To be notified when a project is deleted, so that we can remove it from the list of recommended repositories
     */
    public async onProjectDeletion(userId: string, organizationId: string, projectId: string): Promise<void> {
        const orgSettings = await this.getSettings(userId, organizationId);
        const repoRecommendations = orgSettings.onboardingSettings?.recommendedRepositories;
        if (repoRecommendations) {
            const updatedRepoRecommendations = repoRecommendations.filter((id) => id !== projectId);
            if (updatedRepoRecommendations.length !== repoRecommendations.length) {
                await this.updateSettings(userId, organizationId, {
                    onboardingSettings: { recommendedRepositories: updatedRepoRecommendations },
                });
            }
        }
    }

    public async listWorkspaceClasses(userId: string, orgId: string): Promise<SupportedWorkspaceClass[]> {
        const allClasses = await this.installationService.getInstallationWorkspaceClasses(userId);
        const settings = await this.getSettings(userId, orgId);
        if (settings && !!settings.allowedWorkspaceClasses && settings.allowedWorkspaceClasses.length > 0) {
            const availableClasses = allClasses.filter((e) => settings.allowedWorkspaceClasses!.includes(e.id));
            const defaultIndexInScope = availableClasses.findIndex((e) => e.isDefault);
            if (defaultIndexInScope !== -1) {
                return availableClasses;
            }
            const defaultIndexInAll = allClasses.findIndex((e) => e.isDefault);
            const sortedClasses = [
                ...allClasses.slice(0, defaultIndexInAll).reverse(),
                ...allClasses.slice(defaultIndexInAll, allClasses.length),
            ];
            const nextDefault = sortedClasses.find((e) => settings.allowedWorkspaceClasses!.includes(e.id));
            if (nextDefault) {
                nextDefault.isDefault = true;
            }
            return availableClasses;
        }
        return allClasses;
    }

    /**
     * Gets the maintenance mode status for an organization.
     *
     * @param userId The ID of the user making the request
     * @param orgId The ID of the organization
     * @returns A boolean indicating whether maintenance mode is enabled
     */
    public async getMaintenanceMode(userId: string, orgId: string): Promise<boolean> {
        await this.auth.checkPermissionOnOrganization(userId, "read_info", orgId);

        const team = await this.teamDB.findTeamById(orgId);
        if (!team) {
            throw new ApplicationError(ErrorCodes.NOT_FOUND, `Organization ${orgId} not found`);
        }

        return !!team.maintenanceMode;
    }

    /**
     * Sets the maintenance mode status for an organization.
     *
     * @param userId The ID of the user making the request
     * @param orgId The ID of the organization
     * @param enabled Whether maintenance mode should be enabled
     * @returns A boolean indicating the new maintenance mode status
     */
    public async setMaintenanceMode(userId: string, orgId: string, enabled: boolean): Promise<boolean> {
        await this.auth.checkPermissionOnOrganization(userId, "maintenance", orgId);

        const team = await this.teamDB.findTeamById(orgId);
        if (!team) {
            throw new ApplicationError(ErrorCodes.NOT_FOUND, `Organization ${orgId} not found`);
        }

        await this.teamDB.updateTeam(orgId, { maintenanceMode: enabled });

        // Track the maintenance mode change
        this.analytics.track({
            userId,
            event: enabled ? "maintenance_mode_enabled" : "maintenance_mode_disabled",
            properties: {
                organization_id: orgId,
            },
        });

        return enabled;
    }

    /**
     * Gets the scheduled maintenance notification for an organization.
     *
     * @param userId The ID of the user making the request
     * @param orgId The ID of the organization
     * @returns The notification (enabled status and custom message)
     */
    public async getMaintenanceNotification(userId: string, orgId: string): Promise<MaintenanceNotification> {
        await this.auth.checkPermissionOnOrganization(userId, "read_info", orgId);

        const team = await this.teamDB.findTeamById(orgId);
        if (!team) {
            throw new ApplicationError(ErrorCodes.NOT_FOUND, `Organization ${orgId} not found`);
        }

        // If the maintenanceNotification field doesn't exist or is invalid, return default values
        if (!team.maintenanceNotification) {
            return { enabled: false, message: undefined };
        }

        return {
            enabled: team.maintenanceNotification.enabled,
            message: team.maintenanceNotification.message,
        };
    }

    /**
     * Sets the scheduled maintenance notification for an organization.
     *
     * @param userId The ID of the user making the request
     * @param orgId The ID of the organization
     * @param isEnabled Whether the notification should be enabled
     * @param customMessage Optional custom message for the notification
     * @returns The updated notification
     */
    public async setMaintenanceNotification(
        userId: string,
        orgId: string,
        isEnabled: boolean,
        customMessage?: string,
    ): Promise<MaintenanceNotification> {
        // Using maintenance permission as it's available to owners and installation admins
        await this.auth.checkPermissionOnOrganization(userId, "maintenance", orgId);

        if (customMessage && customMessage.length > 255) {
            throw new ApplicationError(ErrorCodes.BAD_REQUEST, "Custom message exceeds 255 characters");
        }

        const team = await this.teamDB.findTeamById(orgId);
        if (!team) {
            throw new ApplicationError(ErrorCodes.NOT_FOUND, `Organization ${orgId} not found`);
        }

        // Prepare the new notification config
        const newNotificationConfig = {
            enabled: isEnabled,
            message: customMessage?.trim() || undefined,
        };

        // Update the team with the new notification config
        await this.teamDB.updateTeam(orgId, { maintenanceNotification: newNotificationConfig });

        return newNotificationConfig;
    }
}
