import { ApiError } from "../lib/api.ts";

// A plugin that rejects a commit explains why in its message.
const isRejectedCommit = (code: string) => code.endsWith("/commit-rejected");

export function ErrorView(props: { error: unknown }) {
  const { error } = props;
  const message =
    error instanceof ApiError
      ? error.code === undefined || isRejectedCommit(error.code)
        ? error.message
        : `${error.message} (${error.code})`
      : error instanceof Error
        ? error.message
        : String(error);
  return (
    <p role="alert" className="error">
      {message}
    </p>
  );
}
