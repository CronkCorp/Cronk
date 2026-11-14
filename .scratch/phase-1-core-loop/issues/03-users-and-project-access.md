# 03: Users and Project access

**What to build:** An Admin can invite Users by email, promote or demote them between Admin and Member, and deactivate them. Projects are open (all Members) or private (invited Members only), and each Member has Read or Write access per Project. A single access check is enforced by every API operation, so a Member with Read access cannot change anything and nobody sees a private Project they weren't invited to.

**Blocked by:** 02 (Projects and Tickets)

**Status:** ready-for-agent

- [ ] Admin can invite a User by email; the invitee sets a password and signs in
- [ ] Admin can promote/demote between Admin and Member, and deactivate a User (who can no longer sign in)
- [ ] Projects can be switched between open and private; private Projects have an explicit member list
- [ ] Each Member has Read or Write access in a Project
- [ ] Every existing API operation goes through one access check
- [ ] API tests: Read-only Member is refused writes; non-member cannot see a private Project; deactivated User is refused
