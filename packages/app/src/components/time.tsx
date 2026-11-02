import { fullTime, relativeTime } from "@docleus/sdk";

/** When something happened, with the exact moment on hover. */
export function Time(props: { at: number }) {
  return (
    <time
      dateTime={new Date(props.at).toISOString()}
      title={fullTime(props.at)}
    >
      {relativeTime(props.at)}
    </time>
  );
}
