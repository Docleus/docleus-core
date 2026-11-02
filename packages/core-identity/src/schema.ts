import { sql, type Kysely } from "kysely";

export interface UsersTable {
  id: string;
  email: string;
  name: string;
  password_hash: string | null;
}

export interface SessionsTable {
  token_hash: string;
  user_id: string;
  created_at: number;
  expires_at: number;
}

export interface IdentitiesTable {
  provider: string;
  subject: string;
  user_id: string;
}

export interface InvitationsTable {
  id: string;
  token_hash: string;
  email: string | null;
  data: string;
  created_by: string | null;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  used_by: string | null;
}

export interface IdentitySchema {
  users: UsersTable;
  sessions: SessionsTable;
  identities: IdentitiesTable;
  invitations: InvitationsTable;
}

export const identityMigrations = [
  {
    id: "0001-create-tables",
    async up(db: Kysely<unknown>) {
      const typed = db as unknown as Kysely<IdentitySchema>;
      await typed.schema
        .createTable("users")
        .ifNotExists()
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("email", "text", (c) => c.notNull().unique())
        .addColumn("name", "text", (c) => c.notNull())
        .execute();
      await typed.schema
        .createTable("sessions")
        .ifNotExists()
        .addColumn("token", "text", (c) => c.primaryKey())
        .addColumn("user_id", "text", (c) => c.notNull().references("users.id"))
        .addColumn("created_at", "integer", (c) => c.notNull())
        .execute();
      await sql`create index if not exists sessions_user_id on sessions (user_id)`.execute(
        typed,
      );
    },
  },
  {
    // Plain-token sessions from before are dropped: everyone signs in again.
    id: "0002-passwords-hashed-sessions-identities-invitations",
    async up(db: Kysely<unknown>) {
      const typed = db as unknown as Kysely<IdentitySchema>;
      await typed.schema
        .alterTable("users")
        .addColumn("password_hash", "text")
        .execute();
      await sql`update users set email = lower(email) where not exists (select 1 from users other where other.email = lower(users.email) and other.id <> users.id)`.execute(
        typed,
      );
      await typed.schema.dropTable("sessions").ifExists().execute();
      await typed.schema
        .createTable("sessions")
        .addColumn("token_hash", "text", (c) => c.primaryKey())
        .addColumn("user_id", "text", (c) => c.notNull().references("users.id"))
        .addColumn("created_at", "integer", (c) => c.notNull())
        .addColumn("expires_at", "integer", (c) => c.notNull())
        .execute();
      await sql`create index if not exists sessions_user_id on sessions (user_id)`.execute(
        typed,
      );
      await typed.schema
        .createTable("identities")
        .addColumn("provider", "text", (c) => c.notNull())
        .addColumn("subject", "text", (c) => c.notNull())
        .addColumn("user_id", "text", (c) => c.notNull().references("users.id"))
        .addPrimaryKeyConstraint("identities_pk", ["provider", "subject"])
        .execute();
      await typed.schema
        .createTable("invitations")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("token_hash", "text", (c) => c.notNull().unique())
        .addColumn("email", "text")
        .addColumn("data", "text", (c) => c.notNull())
        .addColumn("created_by", "text")
        .addColumn("created_at", "integer", (c) => c.notNull())
        .addColumn("expires_at", "integer", (c) => c.notNull())
        .addColumn("used_at", "integer")
        .addColumn("used_by", "text")
        .execute();
    },
  },
];
