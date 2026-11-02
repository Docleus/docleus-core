import { createContext, useContext } from "react";
import type { OrgRole, ProviderInfo, SpaceRole, User } from "@docleus/sdk";

/** `GET /api/auth/methods`. */
export interface AuthMethods {
  readonly password: boolean;
  readonly dev: boolean;
  readonly providers: readonly ProviderInfo[];
  readonly setupRequired: boolean;
}

/** `GET /api/me`. */
export interface Me {
  readonly user: User | null;
  readonly isAdmin: boolean;
}

/** A user as member and user lists return them. */
export interface UserSummary {
  readonly id: string;
  readonly email: string;
  readonly name: string;
}

export interface Member<Role extends string> {
  readonly user: UserSummary;
  readonly role: Role;
}

export const ORG_ROLES = [
  "owner",
  "admin",
  "member",
] as const satisfies readonly OrgRole[];

export const SPACE_ROLES = [
  "admin",
  "editor",
  "viewer",
] as const satisfies readonly SpaceRole[];

export const ROLE_LABELS: Readonly<Record<OrgRole | SpaceRole, string>> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  editor: "Editor",
  viewer: "Viewer",
};

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 256;

export const MeContext = createContext<Me | undefined>(undefined);

/** The signed-in user, inside the signed-in part of the app. */
export function useMe(): Me | undefined {
  return useContext(MeContext);
}
