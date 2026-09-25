/** Builders for Lightning Experience URLs. All paths are documented, stable Lightning routes. */
import type { OrgIdentity } from '../org/identity';

type Host = Pick<OrgIdentity, 'lightningHost'>;

const enc = encodeURIComponent;

export const setupLinks = (org: Host) => {
  const base = `https://${org.lightningHost}/lightning/setup`;
  return {
    setup: `${base}/SetupOneHome/home`,
    objectManager: `${base}/ObjectManager/home`,
    flows: `${base}/Flows/home`,
    debugLogs: `${base}/ApexDebugLogs/home`,
    deploymentStatus: `${base}/DeployStatus/home`,
    users: `${base}/ManageUsers/home`,
    permissionSets: `${base}/PermSets/home`,
    profiles: `${base}/EnhancedProfiles/home`,
    companyInfo: `${base}/CompanyProfileInfo/home`,
    pausedFlows: `${base}/Pausedflows/home`,
    apexJobs: `${base}/AsyncApexJobs/home`,
    sharingSettings: `${base}/SecuritySharing/home`,
  };
};

export function recordUrl(org: Host, objectApiName: string | undefined, id: string): string {
  return objectApiName
    ? `https://${org.lightningHost}/lightning/r/${enc(objectApiName)}/${enc(id)}/view`
    : `https://${org.lightningHost}/lightning/r/${enc(id)}/view`;
}

export function relatedListUrl(org: Host, objectApiName: string, id: string, relationshipName: string): string {
  return `https://${org.lightningHost}/lightning/r/${enc(objectApiName)}/${enc(id)}/related/${enc(relationshipName)}/view`;
}

export function objectManagerUrl(org: Host, objectApiName: string, section: 'Details' | 'FieldsAndRelationships' | 'PageLayouts' | 'ValidationRules' | 'RecordTypes' | 'LightningPages' = 'Details'): string {
  return `https://${org.lightningHost}/lightning/setup/ObjectManager/${enc(objectApiName)}/${section}/view`;
}

export function fieldSetupUrl(org: Host, objectApiName: string, fieldApiName: string): string {
  return `https://${org.lightningHost}/lightning/setup/ObjectManager/${enc(objectApiName)}/FieldsAndRelationships/${enc(fieldApiName)}/view`;
}

export function userDetailUrl(org: Host, userId: string): string {
  return `https://${org.lightningHost}/lightning/setup/ManageUsers/page?address=${enc(`/${userId}?noredirect=1`)}`;
}

export function flowBuilderUrl(org: Host, flowVersionId: string): string {
  return `https://${org.lightningHost}/builder_platform_interaction/flowBuilder.app?flowId=${enc(flowVersionId)}`;
}

const setupPage = (org: Host, page: string, id: string) => `https://${org.lightningHost}/lightning/setup/${page}/page?address=${enc(`/${id}`)}`;
export const profileUrl = (org: Host, profileId: string) => setupPage(org, 'EnhancedProfiles', profileId);
export const permissionSetUrl = (org: Host, id: string) => setupPage(org, 'PermSets', id);
export const permissionSetGroupUrl = (org: Host, id: string) => setupPage(org, 'PermSetGroups', id);
export const roleUrl = (org: Host, id: string) => setupPage(org, 'Roles', id);
