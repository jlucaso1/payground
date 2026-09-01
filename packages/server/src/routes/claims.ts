import { type RouteModule, notImplemented } from './module.ts';

/** Post-purchase claims, messages, evidence and mediation. */
export const claims: RouteModule = {
  name: "claims",
  operations: [],
  pending: notImplemented(
    [
      "getClaim",
      "searchClaims",
      "getClaimReasons",
      "getClaimHistory",
      "getClaimEvidence",
      "getClaimMessages",
      "sendClaimMessage",
      "attachClaimFile",
      "getClaimFile",
      "downloadClaimFile",
      "requestClaimMediation",
      "getClaimMediationResolutions",
      "uploadShippingEvidence",
    ],
    'not implemented yet',
  ),
  routes: () => ({}),
};
