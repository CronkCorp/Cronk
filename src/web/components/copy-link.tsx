import { useState } from "react";
import { Button } from "./button.js";

/**
 * A secondary button copying `url`, saying "Copied" once it has. Where the browser offers no clipboard, as on a
 * plain-HTTP address, it shows the address to copy by hand instead.
 */
export function CopyLink(props: { url: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy this link", props.url);
    }
  };
  return (
    <Button variant="secondary" onClick={() => void copy()} title={props.url}>
      {copied ? "Copied" : props.label}
    </Button>
  );
}
