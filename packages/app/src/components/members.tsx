import { useState, type FormEvent } from "react";
import type { OrgRole, SpaceRole } from "@docleus/sdk";
import { api } from "../lib/api.ts";
import {
  ORG_ROLES,
  ROLE_LABELS,
  SPACE_ROLES,
  useMe,
  type Member,
} from "../lib/auth.tsx";
import { navigate } from "../lib/router.ts";
import { useLoad } from "../lib/use-load.ts";
import { ErrorView } from "./error-view.tsx";
import { Time } from "./time.tsx";

interface InvitationRow {
  readonly id: string;
  readonly email: string | null | undefined;
  readonly role: OrgRole;
  readonly createdAt: number;
  readonly expiresAt: number;
}

interface CreatedInvitation {
  readonly url: string;
  readonly emailed: boolean;
}

function RoleSelect<Role extends OrgRole | SpaceRole>(props: {
  label?: string;
  roles: readonly Role[];
  value: NoInfer<Role>;
  disabled?: boolean;
  onChange(role: NoInfer<Role>): void;
}) {
  return (
    <select
      aria-label={props.label}
      value={props.value}
      disabled={props.disabled}
      onChange={(event) => {
        const role = props.roles.find((r) => r === event.target.value);
        if (role) props.onChange(role);
      }}
    >
      {props.roles.map((role) => (
        <option key={role} value={role}>
          {ROLE_LABELS[role]}
        </option>
      ))}
    </select>
  );
}

/** Runs member changes one at a time and keeps the last error and status. */
function useMemberAction(onDone: () => void) {
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [status, setStatus] = useState("");
  const run = async (action: () => Promise<string>) => {
    setIsBusy(true);
    setError(undefined);
    setStatus("");
    try {
      setStatus(await action());
    } catch (cause) {
      setError(cause);
    } finally {
      setIsBusy(false);
      onDone();
    }
  };
  return { isBusy, error, status, run };
}

function InviteForm(props: {
  orgId: string;
  roles: readonly OrgRole[];
  onCreated(): void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrgRole>("member");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [created, setCreated] = useState<
    (CreatedInvitation & { email: string }) | undefined
  >();
  const [copyStatus, setCopyStatus] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setIsSending(true);
    setError(undefined);
    setCopyStatus("");
    try {
      const value = email.trim();
      const result = await api<CreatedInvitation>(
        "POST",
        `/api/orgs/${props.orgId}/invitations`,
        { ...(value !== "" && { email: value }), role },
      );
      setCreated({ ...result, email: value });
      setEmail("");
      props.onCreated();
    } catch (cause) {
      setError(cause);
    } finally {
      setIsSending(false);
    }
  };
  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.url);
      setCopyStatus("Link copied.");
    } catch {
      setCopyStatus("Copying failed; select the link and copy it.");
    }
  };
  return (
    <>
      <form className="inline-form" onSubmit={submit} aria-label="Invite">
        <label>
          Email (optional)
          <input
            type="email"
            value={email}
            placeholder="name@example.com"
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label>
          Role
          <RoleSelect roles={props.roles} value={role} onChange={setRole} />
        </label>
        <button type="submit" disabled={isSending}>
          {isSending ? "Inviting…" : "Invite"}
        </button>
        {error !== undefined && <ErrorView error={error} />}
      </form>
      {created && (
        <div className="invitation-link">
          <p role="status">
            {created.emailed
              ? `Invitation emailed to ${created.email}. You can also share the link.`
              : "Invitation created. Copy the link and send it."}
          </p>
          <p className="inline-form">
            <label>
              Invitation link
              <input
                readOnly
                value={created.url}
                onFocus={(event) => event.target.select()}
              />
            </label>
            <button type="button" onClick={copy}>
              Copy link
            </button>
            <span role="status" className="notice">
              {copyStatus}
            </span>
          </p>
        </div>
      )}
    </>
  );
}

function PendingInvitations(props: { orgId: string; version: number }) {
  const base = `/api/orgs/${props.orgId}/invitations`;
  const invitations = useLoad(`${base}#${props.version}`, () =>
    api<{ invitations: InvitationRow[] }>("GET", base),
  );
  const action = useMemberAction(invitations.reload);
  if (invitations.error !== undefined) {
    return <ErrorView error={invitations.error} />;
  }
  if (!invitations.data) return null;
  return (
    <>
      {invitations.data.invitations.length === 0 ? (
        <p>No pending invitations.</p>
      ) : (
        <table className="table members" aria-label="Pending invitations">
          <thead>
            <tr>
              <th>Email</th>
              <th>Role</th>
              <th>Expires</th>
              <th>
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {invitations.data.invitations.map((invitation) => {
              const who = invitation.email ?? "Anyone with the link";
              return (
                <tr key={invitation.id}>
                  <td>{who}</td>
                  <td>{ROLE_LABELS[invitation.role]}</td>
                  <td>
                    <Time at={invitation.expiresAt} />
                  </td>
                  <td>
                    <button
                      type="button"
                      disabled={action.isBusy}
                      aria-label={`Revoke invitation for ${who}`}
                      onClick={() =>
                        action.run(async () => {
                          await api("DELETE", `${base}/${invitation.id}`);
                          return "Invitation revoked.";
                        })
                      }
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <span role="status" className="notice">
        {action.status}
      </span>
      {action.error !== undefined && <ErrorView error={action.error} />}
    </>
  );
}

/** The org's members and invitations. */
export function OrgMembers(props: { orgId: string }) {
  const me = useMe();
  const base = `/api/orgs/${props.orgId}/members`;
  const members = useLoad(base, () =>
    api<{ members: Member<OrgRole>[] }>("GET", base),
  );
  const [invitationsVersion, setInvitationsVersion] = useState(0);
  const action = useMemberAction(members.reload);
  if (members.error !== undefined) return <ErrorView error={members.error} />;
  if (!members.data) return null;

  const userId = me?.user?.id;
  const ownRole = members.data.members.find(
    (member) => member.user.id === userId,
  )?.role;
  const isInstanceAdmin = me?.isAdmin === true;
  const canManage =
    isInstanceAdmin || ownRole === "owner" || ownRole === "admin";
  const canManageOwners = isInstanceAdmin || ownRole === "owner";
  const grantable = canManageOwners
    ? ORG_ROLES
    : ORG_ROLES.filter((role) => role !== "owner");

  const setRole = (member: Member<OrgRole>, role: OrgRole) =>
    action.run(async () => {
      await api("PUT", `${base}/${member.user.id}`, { role });
      return `${member.user.email} is now ${ROLE_LABELS[role].toLowerCase()}.`;
    });
  const remove = (member: Member<OrgRole>) =>
    action.run(async () => {
      await api("DELETE", `${base}/${member.user.id}`);
      if (member.user.id === userId) {
        navigate("/");
        return "You left the organization.";
      }
      return `Removed ${member.user.email}.`;
    });

  return (
    <section className="members-settings" aria-label="Members">
      <h2>Members</h2>
      <table className="table members" aria-label="Organization members">
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Role</th>
            <th>
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {members.data.members.map((member) => {
            const isSelf = member.user.id === userId;
            const canEdit =
              canManage && (member.role !== "owner" || canManageOwners);
            return (
              <tr key={member.user.id}>
                <td>{member.user.name}</td>
                <td>{member.user.email}</td>
                <td>
                  {canEdit ? (
                    <RoleSelect
                      label={`Role of ${member.user.email}`}
                      roles={grantable}
                      value={member.role}
                      disabled={action.isBusy}
                      onChange={(role) => setRole(member, role)}
                    />
                  ) : (
                    ROLE_LABELS[member.role]
                  )}
                </td>
                <td>
                  {(canEdit || isSelf) && (
                    <button
                      type="button"
                      disabled={action.isBusy}
                      aria-label={
                        isSelf
                          ? "Leave organization"
                          : `Remove ${member.user.email}`
                      }
                      onClick={() => remove(member)}
                    >
                      {isSelf ? "Leave" : "Remove"}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <span role="status" className="notice">
        {action.status}
      </span>
      {action.error !== undefined && <ErrorView error={action.error} />}
      {canManage && (
        <>
          <h3>Invite</h3>
          <InviteForm
            orgId={props.orgId}
            roles={grantable}
            onCreated={() => setInvitationsVersion((n) => n + 1)}
          />
          <h3>Pending invitations</h3>
          <PendingInvitations
            orgId={props.orgId}
            version={invitationsVersion}
          />
        </>
      )}
    </section>
  );
}

function AddSpaceMemberForm(props: {
  candidates: readonly Member<OrgRole>[];
  onAdd(userId: string, role: SpaceRole): Promise<void>;
}) {
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<SpaceRole>("editor");
  const selected = props.candidates.some(
    (candidate) => candidate.user.id === userId,
  )
    ? userId
    : "";
  if (props.candidates.length === 0) {
    return <p>Every organization member already has a role here.</p>;
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (selected === "") return;
    await props.onAdd(selected, role);
  };
  return (
    <form className="inline-form" onSubmit={submit} aria-label="Add member">
      <label>
        Member
        <select
          value={selected}
          onChange={(event) => setUserId(event.target.value)}
        >
          <option value="" disabled>
            Choose a member…
          </option>
          {props.candidates.map((candidate) => (
            <option key={candidate.user.id} value={candidate.user.id}>
              {candidate.user.name} ({candidate.user.email})
            </option>
          ))}
        </select>
      </label>
      <label>
        Role
        <RoleSelect roles={SPACE_ROLES} value={role} onChange={setRole} />
      </label>
      <button type="submit" disabled={selected === ""}>
        Add
      </button>
    </form>
  );
}

/** Direct role grants on a space. */
export function SpaceMembers(props: { orgId: string; spaceId: string }) {
  const base = `/api/orgs/${props.orgId}/spaces/${props.spaceId}/members`;
  const members = useLoad(base, () =>
    api<{ members: Member<SpaceRole>[] }>("GET", base),
  );
  const orgMembers = useLoad(props.orgId, () =>
    api<{ members: Member<OrgRole>[] }>(
      "GET",
      `/api/orgs/${props.orgId}/members`,
    ),
  );
  const action = useMemberAction(members.reload);
  if (members.error !== undefined) return <ErrorView error={members.error} />;
  if (!members.data) return null;
  const direct = new Set(members.data.members.map((member) => member.user.id));
  const candidates =
    orgMembers.data?.members.filter((member) => !direct.has(member.user.id)) ??
    [];

  const setRole = (userId: string, email: string, role: SpaceRole) =>
    action.run(async () => {
      await api("PUT", `${base}/${userId}`, { role });
      return `${email} is now ${ROLE_LABELS[role].toLowerCase()}.`;
    });

  return (
    <section className="members-settings" aria-label="Members">
      <h2>Members</h2>
      <p className="notice">
        Organization owners and admins manage every space; organization members
        can read it. Roles here apply to this space only.
      </p>
      {members.data.members.length === 0 ? (
        <p>No one has a role in this space yet.</p>
      ) : (
        <table className="table members" aria-label="Space members">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {members.data.members.map((member) => (
              <tr key={member.user.id}>
                <td>{member.user.name}</td>
                <td>{member.user.email}</td>
                <td>
                  <RoleSelect
                    label={`Role of ${member.user.email}`}
                    roles={SPACE_ROLES}
                    value={member.role}
                    disabled={action.isBusy}
                    onChange={(role) =>
                      setRole(member.user.id, member.user.email, role)
                    }
                  />
                </td>
                <td>
                  <button
                    type="button"
                    disabled={action.isBusy}
                    aria-label={`Remove ${member.user.email}`}
                    onClick={() =>
                      action.run(async () => {
                        await api("DELETE", `${base}/${member.user.id}`);
                        return `Removed ${member.user.email}.`;
                      })
                    }
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <span role="status" className="notice">
        {action.status}
      </span>
      {action.error !== undefined && <ErrorView error={action.error} />}
      <h3>Add a member</h3>
      {orgMembers.error !== undefined ? (
        <ErrorView error={orgMembers.error} />
      ) : (
        orgMembers.data && (
          <AddSpaceMemberForm
            candidates={candidates}
            onAdd={async (userId, role) => {
              const email =
                candidates.find((candidate) => candidate.user.id === userId)
                  ?.user.email ?? userId;
              await setRole(userId, email, role);
            }}
          />
        )
      )}
    </section>
  );
}
