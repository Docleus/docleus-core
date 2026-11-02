import { useEffect } from "react";
import { navigate } from "../lib/router.ts";

export function Redirect(props: { to: string }) {
  useEffect(() => navigate(props.to, { replace: true }), [props.to]);
  return null;
}
