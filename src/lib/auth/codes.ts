/** LifeInvader contractor build - business permission codes only. */
export const CODES = {
  BUSINESS_ADMIN: "business.admin",
  BUSINESS_MARGIN: "business.margin",
} as const;

export type PermissionCode = (typeof CODES)[keyof typeof CODES];
