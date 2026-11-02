import { useState } from "react";
import { api } from "../lib/api.ts";
import { useMe, type UserSummary } from "../lib/auth.tsx";
import { useLoad } from "../lib/use-load.ts";
import { ErrorView } from "./error-view.tsx";

type UserRow = UserSummary & { readonly isAdmin: boolean };

/** Every user of the instance, with the instance admin role. */
export function UsersSettings() {
  const me = useMe();
  const users = useLoad("users", () =>
    api<{ users: UserRow[] }>("GET", "/api/users"),
  );
  const [pending, setPending] = useState<string | undefined>();
  const [status, setStatus] = useState("");
  const [error, setError] = useState<unknown>();
  const setAdmin = async (user: UserRow, isAdmin: boolean) => {
    setPending(user.id);
    setStatus("");
    setError(undefined);
    try {
      await api("PUT", `/api/users/${user.id}/admin`, { isAdmin });
      setStatus(
        isAdmin
          ? `${user.email} is now an instance admin.`
          : `${user.email} is no longer an instance admin.`,
      );
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(undefined);
      users.reload();
    }
  };
  if (users.error !== undefined) return <ErrorView error={users.error} />;
  if (!users.data) return null;
  return (
    <section className="users" aria-label="Users">
      <h2>Users</h2>
      <table className="table members" aria-label="Users">
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Instance admin</th>
          </tr>
        </thead>
        <tbody>
          {users.data.users.map((user) => (
            <tr key={user.id}>
              <td>
                {user.name}
                {user.id === me?.user?.id && (
                  <span className="notice"> (you)</span>
                )}
              </td>
              <td>{user.email}</td>
              <td>
                <input
                  type="checkbox"
                  aria-label={`Instance admin: ${user.email}`}
                  checked={user.isAdmin}
                  disabled={pending !== undefined}
                  onChange={(event) => setAdmin(user, event.target.checked)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <span role="status" className="notice">
        {status}
      </span>
      {error !== undefined && <ErrorView error={error} />}
    </section>
  );
}
