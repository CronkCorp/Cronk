import { HttpError } from "../context.js";

/** Reading the values an export's frontmatter holds, refusing the import (400) with where a value is wrong. */

/** A file of the export, read: its frontmatter and body, and its path for naming it in refusals. */
export interface File {
  path: string;
  data: Record<string, unknown>;
  body: string;
}

export function refuse(message: string): never {
  throw new HttpError(400, message);
}

/** Orders names as people number them: `2` before `10`. */
export const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** A frontmatter list of mappings, empty if the field is left out. */
export function list(file: File, field: string): Record<string, unknown>[] {
  const value = file.data[field] ?? [];
  if (!Array.isArray(value) || !value.every((v) => v !== null && typeof v === "object")) refuse(`${file.path} ${field} must be a list`);
  return value as Record<string, unknown>[];
}

export function text(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") refuse(`${where} must be text`);
  return value;
}

export function integer(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) refuse(`${where} must be a whole number`);
  return value;
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], where: string): T {
  if (!allowed.includes(value as T)) refuse(`${where} must be one of ${allowed.join(", ")}`);
  return value as T;
}

export function date(value: unknown, where: string): Date {
  const parsed = typeof value === "string" ? new Date(value) : value instanceof Date ? value : undefined;
  if (!parsed || Number.isNaN(parsed.getTime())) refuse(`${where} must be a date and time, such as 2026-01-01T09:00:00Z`);
  return parsed;
}

export function optionalDate(value: unknown, where: string): Date | null {
  return value === null || value === undefined ? null : date(value, where);
}
