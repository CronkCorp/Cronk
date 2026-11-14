import type { FastifyInstance } from "fastify";
import { PRIORITIES, RELATION_KINDS, STATUS_CATEGORIES } from "../shared/values.js";

/** JSON schemas for request fields used by more than one route. */

/** A display name: non-blank, at most 200 characters. Routes trim it before storing. */
export const nameSchema = { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" } as const;

/** Agent Access: the most Agents may do in a Project or the Workspace. */
export const agentAccessSchema = { type: "string", enum: ["none", "read", "write"] } as const;

/** A User's Role in the Workspace. */
export const roleSchema = { type: "string", enum: ["admin", "member"] } as const;

/** A User's access in a Project. */
export const accessSchema = { type: "string", enum: ["read", "write"] } as const;

/** Route schema for an operation anyone may call, signed in or not; the OpenAPI description lists no security for it. */
export const publicRoute = { security: [] } as const;

/*
 * Response shapes shared by several routes. Each is registered once (see `addSharedSchemas`),
 * appears under `components.schemas` in the OpenAPI description, and is referenced with `ref`.
 *
 * Fastify serializes a response with its schema and drops any property the schema doesn't
 * list, so each one must list every field the API returns.
 */

export type SharedSchemaName =
  | "Error"
  | "User"
  | "Invitation"
  | "Workspace"
  | "Agent"
  | "AgentToken"
  | "Project"
  | "Status"
  | "Ticket"
  | "TicketRef"
  | "Relations"
  | "RecordedChange";

/** A reference to a shared schema by name, such as `ref("Ticket")`. */
export const ref = (name: SharedSchemaName) => ({ $ref: `${name}#` }) as const;

const id = { type: "string", format: "uuid" } as const;
const timestamp = { type: "string", format: "date-time" } as const;
/** An object schema whose properties are all required, except those listed as `optional`. */
const object = (properties: Record<string, object>, optional: string[] = []) => ({
  type: "object",
  required: Object.keys(properties).filter((p) => !optional.includes(p)),
  properties,
});
/** A User or Agent as another record names it. */
const named = object({ id, name: { type: "string" } });
const nullable = (schema: object) => ({ anyOf: [schema, { type: "null" }] });
/** Another Ticket as a Ticket's parent and history name it. */
const ticketName = object({ key: { type: "string" }, title: { type: "string" } });
const priority = { type: "string", enum: PRIORITIES } as const;
const labels = { type: "array", items: { type: "string" } } as const;

const sharedSchemas: Record<SharedSchemaName, object> = {
  Error: { description: "Every API error has this shape.", ...object({ error: { type: "string" } }) },
  User: object({
    id,
    email: { type: "string" },
    name: { type: "string" },
    role: roleSchema,
    active: { type: "boolean", description: "False once an Admin has deactivated the User." },
  }),
  Invitation: object({
    id,
    email: { type: "string" },
    role: roleSchema,
    createdAt: timestamp,
    expiresAt: timestamp,
  }),
  Workspace: object({ name: { type: "string" }, agentAccess: agentAccessSchema }),
  Agent: object({ id, name: { type: "string" }, owner: named, createdAt: timestamp }),
  AgentToken: {
    description: "A token an Agent calls the API with. A read-only token is refused every write.",
    ...object({ id, readOnly: { type: "boolean" }, createdAt: timestamp }),
  },
  Project: object({
    id,
    name: { type: "string" },
    key: { type: "string" },
    archived: { type: "boolean" },
    visibility: { type: "string", enum: ["open", "private"] },
    agentAccess: agentAccessSchema,
    access: { ...accessSchema, description: "What the caller may do in the Project." },
  }),
  Status: object({
    id,
    name: { type: "string" },
    category: { type: "string", enum: STATUS_CATEGORIES },
  }),
  Ticket: object({
    id,
    projectId: id,
    projectKey: { type: "string" },
    key: { type: "string", description: "`<Project key>-<number>`, such as `CRONK-12`." },
    number: { type: "integer" },
    title: { type: "string" },
    description: { type: "string", description: "Markdown." },
    status: ref("Status"),
    priority,
    labels,
    assignee: nullable(named),
    parent: { ...nullable(ticketName), description: "Set on a Sub-Ticket." },
    createdAt: timestamp,
    updatedAt: timestamp,
  }),
  TicketRef: {
    description: "Another Ticket, as a Ticket lists it among its Sub-Tickets or relations.",
    ...object({ key: { type: "string" }, title: { type: "string" }, status: ref("Status") }),
  },
  Relations: {
    description: "A Ticket's relations to other Tickets, each list in key order.",
    ...object({
      blocks: { type: "array", items: ref("TicketRef") },
      blockedBy: { type: "array", items: ref("TicketRef") },
      relatesTo: { type: "array", items: ref("TicketRef") },
    }),
  },
  RecordedChange: {
    description: "One change in a Ticket's history. `change` says which; the other fields depend on it.",
    ...object({
      at: timestamp,
      actor: {
        description: "Who made the change: a User, or an Agent with the Owner it acted for.",
        ...object({ kind: { type: "string", enum: ["user", "agent"] }, id, name: { type: "string" }, owner: named }, ["owner"]),
      },
      change: {
        type: "string",
        enum: [
          ...["created", "title", "description", "status", "priority", "labels", "assignee", "parent"],
          ...["relation added", "relation removed"],
        ],
      },
    }),
    anyOf: [
      object({ change: { const: "created" }, title: { type: "string" }, description: { type: "string" }, status: ref("Status") }),
      ...(["title", "description"] as const).map((c) => object({ change: { const: c }, from: { type: "string" }, to: { type: "string" } })),
      object({ change: { const: "status" }, from: ref("Status"), to: ref("Status") }),
      object({ change: { const: "priority" }, from: priority, to: priority }),
      object({ change: { const: "labels" }, from: labels, to: labels }),
      object({ change: { const: "assignee" }, from: nullable(named), to: nullable(named) }),
      object({ change: { const: "parent" }, from: nullable(ticketName), to: nullable(ticketName) }),
      object({
        change: { type: "string", enum: ["relation added", "relation removed"] },
        kind: { type: "string", enum: RELATION_KINDS },
        ticket: ticketName,
      }),
    ],
  },
};

/** Registers the shared response shapes, so routes can `ref` them. */
export function addSharedSchemas(app: FastifyInstance): void {
  for (const [name, schema] of Object.entries(sharedSchemas)) app.addSchema({ $id: name, ...schema });
}

/** A JSON body with one field holding a shared shape, such as `{ ticket: Ticket }`. */
export const holding = (field: string, name: SharedSchemaName) => object({ [field]: ref(name) });

/** A JSON body with one field listing items, such as `{ tickets: Ticket[] }`. */
export const listing = (field: string, items: object) => object({ [field]: { type: "array", items } });

/** A success answer with a JSON body. */
export const answer = (description: string, schema: object) => ({ description, ...schema });

/** A success answer with no body, such as a 204. */
export const noContent = (description: string) => ({ description, type: "null" }) as const;

/** What each error status means, wherever a route answers it. */
const ERROR_MEANINGS = {
  400: "The request is invalid: a field, parameter or value the operation refuses",
  401: "Not signed in, or the Agent token is unknown or revoked",
  403: "The caller may not do this: an Admin-only change, Read access where Write is needed, or an Agent where only a User may act",
  404: "There is no such record, or the caller can't see it",
  409: "The change conflicts with the current state",
} as const;

/** The error answers of a route, each with the shared `Error` shape. */
export const errors = (...codes: (keyof typeof ERROR_MEANINGS)[]) =>
  Object.fromEntries(codes.map((code) => [code, { description: ERROR_MEANINGS[code], ...ref("Error") }]));

/** A route's path parameters; each is required, and each schema should say what it names. */
export const pathParams = <P extends Record<string, { readonly type: string; readonly description: string }>>(properties: P) =>
  object(properties);

/** A Project's key, such as `CRONK`, in any case. */
export const projectKeyParam = { type: "string", description: "The Project's key, such as `CRONK`; any case." } as const;

/** A User's id. */
export const userIdParam = { type: "string", format: "uuid", description: "The User's id." } as const;

/** A Ticket's key, such as `CRONK-12`, in any case. */
export const ticketKeyParam = { type: "string", description: "The Ticket's key, such as `CRONK-12`; any case." } as const;
