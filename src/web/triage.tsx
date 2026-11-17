import { useEffect } from "react";
import { LiveIndicator, useLiveState } from "./components/live.js";
import { api, watchInboxAndTriage, type TriageFilter, type TriageKind, type User } from "./api.js";
import { GROUPS, InboxSplit, itemId, KindAndProjectFilters, kindNames, viewPath, type Group } from "./inbox.js";
import { navigate } from "./router.js";
import { Show, useLoad } from "./ui.js";

// Triage (docs/ui.md § Inbox and Triage in Phase 2): the shared list of waiting items with no clear User, in the Inbox's split view.

/** Where Triage is: its filter, and the item selected in it, if the address names one. */
export interface TriageAddress {
  filter: TriageFilter;
  item?: string;
}

/** The kinds Triage holds, by the names its chips give them, in the Inbox's order. */
const TRIAGE_KIND_NAMES = kindNames<TriageKind>({ unverified: true, unattended: true, suggestion: true, discovered: true });

/** Triage's groups, in the order they are shown: the Inbox's groups that hold its kinds. */
const TRIAGE_GROUPS: Group[] = GROUPS.filter((group) => group.kind in TRIAGE_KIND_NAMES);

/** The Triage filter and selected item in a page address. */
export function triageAddressFrom(search: URLSearchParams): TriageAddress {
  const kind = search.get("kind");
  const item = search.get("item");
  return {
    filter: {
      ...(kind && kind in TRIAGE_KIND_NAMES ? { kind: kind as TriageKind } : {}),
      ...(search.get("project") ? { project: search.get("project")! } : {}),
    },
    ...(item ? { item } : {}),
  };
}

const triagePath = (address: TriageAddress) => viewPath("/triage", address);

/**
 * Triage: the waiting items with no clear User that the signed-in User could act on (Admins see all), in the Inbox's split view
 * with its keyboard. It loads again whenever the server says it may have changed; acting on an item takes it out for everyone.
 */
export function TriagePage(props: { address: TriageAddress; me: User }) {
  const { filter } = props.address;
  const [items, reload] = useLoad(() => api.triage({ project: filter.project }), [filter.project]);
  const [live, onLive] = useLiveState();
  useEffect(() => watchInboxAndTriage({ ready: reload, onLive, on: { triage: reload } }), [filter.project]);
  const setFilter = (changes: TriageFilter) => navigate(triagePath({ filter: { ...filter, ...changes } }));
  const all = items.kind === "loaded" ? items.value : [];

  return (
    <section className="inbox">
      <div className="page-head">
        <h1>Triage</h1>
        <div className="inbox-filters" role="group" aria-label="Filters">
          <LiveIndicator state={live} />
          <KindAndProjectFilters kinds={TRIAGE_KIND_NAMES} items={all} filter={filter} setFilter={setFilter} />
        </div>
      </div>
      <p className="muted page-intro">Waiting items with nobody clear to go to. You see the ones you could act on.</p>
      <Show state={items}>
        {(loaded) => (
          <InboxSplit
            key={`${filter.project ?? ""}/${filter.kind ?? ""}`}
            items={loaded.filter((item) => !filter.kind || item.kind === filter.kind)}
            item={props.address.item}
            pathTo={(item) => triagePath({ filter, ...(item ? { item: itemId(item) } : {}) })}
            groups={TRIAGE_GROUPS}
            label="Triage items"
            empty={{
              heading: "Nothing in Triage",
              hint:
                "Agents' Unverified completions with no Assignee, Discovered Tickets and delegated or In Review Tickets whose Assignee is missing, " +
                "deactivated or can't see their Project, and Suggestions nobody reviews, such as those on Workspace items, show up here.",
            }}
            keysHint="J / K moves through the list, C Accepts or takes it, S reopens or rejects."
            me={props.me}
            onChanged={reload}
          />
        )}
      </Show>
    </section>
  );
}
