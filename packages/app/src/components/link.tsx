import type { AnchorHTMLAttributes, MouseEvent } from "react";
import { navigate } from "../lib/router.ts";

export function Link(
  props: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string },
) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    props.onClick?.(event);
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    navigate(props.href);
  };
  return <a {...props} onClick={onClick} />;
}
