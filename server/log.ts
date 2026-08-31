import { randomUUID } from "node:crypto";

export function log(
  level: "info" | "warn" | "error",
  message: string,
  fields: Record<string, unknown> = {}
): void {
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), level, message, ...fields }) + "\n"
  );
}

export function newRequestId(): string {
  return randomUUID();
}
