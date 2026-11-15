import * as RadixDialog from "@radix-ui/react-dialog";
import * as RadixMenu from "@radix-ui/react-dropdown-menu";
import * as RadixPopover from "@radix-ui/react-popover";
import * as RadixTabs from "@radix-ui/react-tabs";
import { Fragment, type ReactNode } from "react";
import { Button } from "./button.js";

// Radix UI's headless primitives, each wrapped once and styled by our classes (docs/ui.md § Component conventions).
// Radix handles focus, dismissal and keyboard use; these wrappers only give them Cronk's look.

/** A floating panel anchored to `trigger`, such as a picker's list. */
export function Popover(props: { trigger: ReactNode; children: ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void; label?: string }) {
  return (
    <RadixPopover.Root {...(props.open === undefined ? {} : { open: props.open })} {...(props.onOpenChange ? { onOpenChange: props.onOpenChange } : {})}>
      <RadixPopover.Trigger asChild>{props.trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content className="popover" align="start" sideOffset={4} aria-label={props.label}>
          {props.children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}

/** One entry of a `Menu`; `danger` marks a destructive one, such as Archive or Delete. Entries sharing a `group` sit under its label. */
export interface MenuItem {
  label: string;
  group?: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

/** A menu of actions opened from `trigger`, such as the "…" menu that holds a page's destructive actions. */
export function Menu(props: { trigger: ReactNode; items: MenuItem[]; label?: string }) {
  return (
    <RadixMenu.Root>
      <RadixMenu.Trigger asChild>{props.trigger}</RadixMenu.Trigger>
      <RadixMenu.Portal>
        <RadixMenu.Content className="menu" align="end" sideOffset={4} aria-label={props.label}>
          {props.items.map((item, i) => (
            <Fragment key={`${item.group ?? ""}/${item.label}`}>
              {item.group !== undefined && item.group !== props.items[i - 1]?.group && (
                <RadixMenu.Label className="menu-label">{item.group}</RadixMenu.Label>
              )}
              <RadixMenu.Item
                className={`menu-item${item.danger ? " danger" : ""}`}
                {...(item.disabled ? { disabled: true } : {})}
                onSelect={item.onSelect}
              >
                {item.label}
              </RadixMenu.Item>
            </Fragment>
          ))}
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  );
}

/** What every dialog takes: whether it is open, who hears it close, its title and an optional line under it. */
interface DialogFrame {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
}

/** A modal dialog named by `title`, with an optional line under it and its content. */
export function Dialog(props: DialogFrame & { children: ReactNode }) {
  return (
    <RadixDialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="dialog-overlay" />
        <RadixDialog.Content className="dialog" {...(props.description ? {} : { "aria-describedby": undefined })}>
          <RadixDialog.Title className="dialog-title">{props.title}</RadixDialog.Title>
          {props.description && <RadixDialog.Description className="dialog-description">{props.description}</RadixDialog.Description>}
          {props.children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/** A `Dialog` asking to confirm a destructive action, whose button is the only place the danger variant is used. */
export function ConfirmDialog(props: DialogFrame & { confirmLabel: string; busy?: boolean; onConfirm: () => void }) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange} title={props.title} {...(props.description ? { description: props.description } : {})}>
      <div className="actions dialog-actions">
        <RadixDialog.Close asChild>
          <Button variant="secondary">Cancel</Button>
        </RadixDialog.Close>
        <Button variant="danger" disabled={props.busy} onClick={props.onConfirm}>
          {props.confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}

/** Tabs that switch between panels in place, named by `label`. */
export function Tabs(props: { label: string; tabs: { value: string; title: string; content: ReactNode }[]; value?: string; onValueChange?: (value: string) => void }) {
  const first = props.tabs[0]?.value;
  return (
    <RadixTabs.Root
      className="tabs-root"
      {...(props.value === undefined ? (first === undefined ? {} : { defaultValue: first }) : { value: props.value })}
      {...(props.onValueChange ? { onValueChange: props.onValueChange } : {})}
    >
      <RadixTabs.List className="tabs" aria-label={props.label}>
        {props.tabs.map((t) => (
          <RadixTabs.Trigger key={t.value} value={t.value} className="tab">
            {t.title}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {props.tabs.map((t) => (
        <RadixTabs.Content key={t.value} value={t.value}>
          {t.content}
        </RadixTabs.Content>
      ))}
    </RadixTabs.Root>
  );
}
