"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ActionResult } from "@/lib/types/action-result";

type AnyAction = (key: string, input: unknown) => Promise<ActionResult<unknown>>;

/**
 * One form component for all three catalogue entities.
 *
 * They differ only in their fields, and three near-identical components would drift — the error
 * handling and the idempotency-key discipline are the parts that must stay identical everywhere.
 */
export function CatalogueForm({
  title,
  description,
  fields,
  action,
  submitLabel,
}: {
  title: string;
  description: string;
  fields: Array<{
    name: string;
    label: string;
    type?: "text" | "number" | "select";
    options?: Array<{ value: string; label: string }>;
    required?: boolean;
    hint?: string;
  }>;
  action: AnyAction;
  submitLabel: string;
}) {
  const router = useRouter();
  // One key per form instance, replaced only after success (D9).
  const keyRef = useRef<string>(crypto.randomUUID());
  const formRef = useRef<HTMLFormElement>(null);

  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  async function onSubmit(formData: FormData) {
    setPending(true);
    setMessage(null);
    setFieldErrors({});

    const input: Record<string, unknown> = {};
    for (const field of fields) {
      const raw = formData.get(field.name);
      if (raw === null || raw === "") continue;
      input[field.name] = field.type === "number" ? Number(raw) : String(raw);
    }

    const result = await action(keyRef.current, input);
    setPending(false);

    if (result.ok) {
      keyRef.current = crypto.randomUUID();
      formRef.current?.reset();
      setMessage({ tone: "ok", text: `${title} added.` });
      router.refresh();
    } else {
      // FR-044 — the server's message says what happened and what to do. Shown verbatim rather
      // than replaced with a generic "something went wrong", which would discard that work.
      setFieldErrors(result.fieldErrors ?? {});
      setMessage({
        tone: "bad",
        text: result.correlationId
          ? `${result.message} (ref ${result.correlationId})`
          : result.message,
      });
    }
  }

  return (
    <form ref={formRef} action={onSubmit} className="space-y-3 rounded-lg border p-4">
      <div>
        <h2 className="font-medium">{title}</h2>
        <p className="text-muted-foreground mt-0.5 text-sm">{description}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((field) => (
          <div key={field.name} className="space-y-1.5">
            <label htmlFor={field.name} className="text-sm font-medium">
              {field.label}
            </label>
            {field.type === "select" ? (
              <select
                id={field.name}
                name={field.name}
                required={field.required}
                className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
              >
                {field.options?.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                id={field.name}
                name={field.name}
                type={field.type === "number" ? "number" : "text"}
                required={field.required}
                min={field.type === "number" ? 0 : undefined}
              />
            )}
            {field.hint ? (
              <p className="text-muted-foreground text-xs">{field.hint}</p>
            ) : null}
            {fieldErrors[field.name]?.length ? (
              <p className="text-destructive text-xs">{fieldErrors[field.name].join(". ")}</p>
            ) : null}
          </div>
        ))}
      </div>

      {message ? (
        <p
          role={message.tone === "bad" ? "alert" : "status"}
          className={
            message.tone === "bad"
              ? "text-destructive text-sm"
              : "text-sm text-green-700 dark:text-green-400"
          }
        >
          {message.text}
        </p>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}
