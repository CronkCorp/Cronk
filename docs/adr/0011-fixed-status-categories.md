# Projects customise Statuses within fixed Status Categories

Every Project defines its own Statuses, but each belongs to one of six fixed Status Categories: Backlog, Unstarted, Started, In Review, Completed, Canceled. Rules for Agents, Ready, the Inbox and later Pull Request automation are written against the Categories, so Agents behave the same in every Project however its workflow is named. By default Agents may move Tickets only into Unstarted, Started and In Review Categories; completing and canceling stay with Users, except under Autonomous Delegation (ADR 0002).

## Considered Options

- **One fixed list of Statuses everywhere**: simplest, but Projects can't express steps like "In QA".
- **Fully free Statuses per Project (Jira style)**: Agents would have to learn what each Project's Statuses mean.
