import { getDb } from "./db";

export function audit(actor: string, action: string, detail: Record<string, unknown> = {}): void {
  getDb()
    .prepare("INSERT INTO audit_log (actor, action, detail) VALUES (?, ?, ?)")
    .run(actor, action, JSON.stringify(detail));
}
