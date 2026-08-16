import type { ButtonHTMLAttributes } from "react";

import { Button } from "./button";

export function IconButton({
  "aria-label": ariaLabel,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { "aria-label": string }) {
  return <Button size="icon" variant="ghost" aria-label={ariaLabel} {...props} />;
}
