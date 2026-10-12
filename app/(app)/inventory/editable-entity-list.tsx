"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ActionResult } from "@/lib/types/action-result";

type Action = (key: string, input: unknown) => Promise<ActionResult<unknown>>;

export type EditableField = {
  name: string;
  label: string;
  type?: "text" | "number";
  /**
   * Whether emptying the box clears the stored value. Required fields (a vendor's name, a grade's
   * label) are not clearable — blanking one submits no change rather than a null the service would
   * have to refuse with a less useful message.
   */
  clearable?: boolean;
};

export type EntityRow = {
  id: number;
  primary: string;
  secondary: string;
  inactive: boolean;
  /** Current values keyed by field name, used to prefill the edit form. */
  values: Record<string, string | number | null>;
};

/**
 * One list component for vendors and grades (FR-045).
 *
 * They differ only in which fields are editable. Two near-identical components would drift, and
 * the parts that must not drift are the idempotency-key discipline and showing the server's
 * refusal verbatim rather than replacing it with something generic.
 */
export function EditableEntityList({
  title,
  rows,
  fields,
  idField,
  action,
  emptyNote,
}: {
  title: string;
  rows: EntityRow[];
  fields: EditableField[];
  /** The id property name the action expects, e.g. "vendorId". */
  idField: string;
  action: Action;
  emptyNote: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startEditing(row: EntityRow) {
    setEditing(row.id);
    setError(null);
    setDraft(
      Object.fromEntries(
        fields.map((f) => [f.name, row.values[f.name] == null ? "" : String(row.values[f.name])]),
      ),
    );
  }

  async function save(row: EntityRow) {
    setPending(true);
    setError(null);

    const input: Record<string, unknown> = { [idField]: row.id };
    for (const field of fields) {
      const raw = draft[field.name] ?? "";
      if (field.type === "number") {
        input[field.name] = raw === "" ? undefined : Number(raw);
      } else if (raw !== "") {
        input[field.name] = raw;
      } else if (field.clearable) {
        // The service distinguishes null (clear it) from undefined (leave it alone).
        input[field.name] = null;
      }
    }

    const result = await action(crypto.randomUUID(), input);
    setPending(false);

    if (result.ok) {
      setEditing(null);
      router.refresh();
    } else {
      // FR-044 — the server's message names the actual conflict. Shown as-is.
      setError(result.message);
    }
  }

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">
        {title} <span className="text-muted-foreground">({rows.length})</span>
      </h2>
      {rows.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border border-dashed p-3 text-xs">
          {emptyNote}
        </p>
      ) : (
        <ul className="divide-y rounded-lg border text-sm">
          {rows.map((row) => (
            <li key={row.id} className="px-3 py-2">
              <div className="flex items-start justify-between gap-2">
                <span className={row.inactive ? "text-muted-foreground line-through" : ""}>
                  {row.primary}
                  {row.secondary ? (
                    <span className="text-muted-foreground block text-xs">{row.secondary}</span>
                  ) : null}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => (editing === row.id ? setEditing(null) : startEditing(row))}
                >
                  {editing === row.id ? "Cancel" : "Edit"}
                </Button>
              </div>

              {editing === row.id ? (
                <div className="mt-2 space-y-2 rounded-md border p-2">
                  {fields.map((field) => (
                    <div key={field.name} className="space-y-1">
                      <label
                        htmlFor={`${idField}-${row.id}-${field.name}`}
                        className="text-xs font-medium"
                      >
                        {field.label}
                      </label>
                      <Input
                        id={`${idField}-${row.id}-${field.name}`}
                        type={field.type === "number" ? "number" : "text"}
                        value={draft[field.name] ?? ""}
                        onChange={(e) =>
                          setDraft((d) => ({ ...d, [field.name]: e.target.value }))
                        }
                      />
                    </div>
                  ))}
                  {error ? (
                    <p role="alert" className="text-destructive text-xs">
                      {error}
                    </p>
                  ) : null}
                  <Button size="sm" disabled={pending} onClick={() => void save(row)}>
                    {pending ? "Saving…" : "Save"}
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
