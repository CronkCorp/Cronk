import type { ButtonHTMLAttributes } from "react";

/**
 * How a button looks (docs/ui.md § Component conventions): `primary` is filled, one per form or action bar;
 * `secondary` is bordered; `ghost` is accent text, for Reply, Rename and the like; `danger` is filled red,
 * only inside a confirming dialog.
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

/** The classes of a button, for a link or file picker that has to look like one. */
export const buttonClass = (variant: ButtonVariant = "primary", extra?: string) => `btn ${variant}${extra ? ` ${extra}` : ""}`;

/** A button sized to its label. Disabled, it keeps its colours at half opacity. */
export function Button(props: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  const { variant, className, ...rest } = props;
  return <button {...rest} className={buttonClass(variant, className)} />;
}
