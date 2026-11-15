import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Popover } from "./overlays.js";

// Ticket fields are edited in place (docs/ui.md § Component conventions, Pickers): clicking the value
// opens a list that filters as the User types. Bare <select> rows are not used for this.

/** One choice in a `FieldPicker`: its value, the text it is filtered by, and how it shows, if not as that text. */
export interface PickerOption {
  value: string;
  label: string;
  content?: ReactNode;
}

/**
 * A field's label beside its value. The value is a button named "<label> <value>" that opens a listbox
 * named `label`, with a "Filter <label>" box above it. Enter in the box picks the first match; the arrow
 * keys move through the list. `selected` marks the chosen values; a picker of one value closes on a pick.
 * `create` offers the typed text as a new value when nothing matches it exactly, as for a new Label.
 */
export function FieldPicker(props: {
  label: string;
  value: ReactNode;
  options: PickerOption[];
  selected: string[];
  onPick: (value: string) => void;
  multiple?: boolean;
  disabled?: boolean;
  create?: (text: string) => string;
  empty?: string;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const labelId = useId();
  const valueId = useId();
  const list = useRef<HTMLUListElement>(null);
  const typed = filter.trim();
  const shown = props.options.filter((o) => o.label.toLowerCase().includes(typed.toLowerCase()));
  const offerNew = props.create && typed && !props.options.some((o) => o.label.toLowerCase() === typed.toLowerCase());
  const choices: PickerOption[] = offerNew ? [...shown, { value: props.create!(typed), label: typed, content: <>Add “{typed}”</> }] : shown;

  const setOpenAndReset = (next: boolean) => {
    setOpen(next);
    if (!next) setFilter("");
  };
  const pick = (value: string) => {
    props.onPick(value);
    if (props.multiple) setFilter("");
    else setOpenAndReset(false);
  };
  const options = () => [...(list.current?.querySelectorAll<HTMLElement>("[role=option]") ?? [])];
  const onFilterKey = (event: KeyboardEvent) => {
    if (event.key === "Enter" && choices[0]) {
      event.preventDefault();
      pick(choices[0].value);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      options()[0]?.focus();
    }
  };
  const onOptionKey = (event: KeyboardEvent<HTMLLIElement>, value: string) => {
    const all = options();
    const at = all.indexOf(event.currentTarget);
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      pick(value);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      all[at + 1]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      (at > 0 ? all[at - 1] : list.current?.parentElement?.querySelector<HTMLElement>(".picker-filter"))?.focus();
    }
  };

  return (
    <div className="side-field">
      <span id={labelId} className="side-field-label">
        {props.label}
      </span>
      <Popover
        open={open}
        onOpenChange={setOpenAndReset}
        label={props.label}
        trigger={
          <button type="button" id={valueId} className="picker-trigger" aria-labelledby={`${labelId} ${valueId}`} disabled={props.disabled}>
            {props.value}
          </button>
        }
      >
        <input
          className="picker-filter"
          aria-label={`Filter ${props.label}`}
          placeholder={props.create ? `Filter or add a ${props.label.replace(/s$/, "")}` : "Filter"}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={onFilterKey}
          autoFocus
        />
        <ul ref={list} role="listbox" aria-label={props.label} aria-multiselectable={props.multiple ? true : undefined} className="picker-list">
          {choices.map((o) => (
            <li
              key={o.value}
              role="option"
              tabIndex={-1}
              aria-selected={props.selected.includes(o.value)}
              className="picker-option"
              onClick={() => pick(o.value)}
              onKeyDown={(e) => onOptionKey(e, o.value)}
            >
              {o.content ?? o.label}
            </li>
          ))}
          {choices.length === 0 && <li className="picker-empty muted">{props.empty ?? "Nothing matches"}</li>}
        </ul>
      </Popover>
    </div>
  );
}
