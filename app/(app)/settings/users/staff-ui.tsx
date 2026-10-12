"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ActionResult } from "@/lib/types/action-result";

type Action = (key: string, input: unknown) => Promise<ActionResult<unknown>>;

export function StaffForm({ action }: { action: Action }) {
  const router = useRouter();
  const keyRef = useRef<string>(crypto.randomUUID());
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  async function onSubmit(formData: FormData) {
    setPending(true);
    setMessage(null);
    setFieldErrors({});

    const result = await action(keyRef.current, {
      email: String(formData.get("email") ?? ""),
      name: String(formData.get("name") ?? ""),
      password: String(formData.get("password") ?? ""),
      role: String(formData.get("role") ?? "salesperson"),
    });
    setPending(false);

    if (result.ok) {
      keyRef.current = crypto.randomUUID();
      formRef.current?.reset();
      setMessage({
        tone: "ok",
        text: "Account created. Give them the password you just set — it is not shown again.",
      });
      router.refresh();
    } else {
      setFieldErrors(result.fieldErrors ?? {});
      setMessage({ tone: "bad", text: result.message });
    }
  }

  return (
    <form ref={formRef} action={onSubmit} className="space-y-3 rounded-lg border p-4">
      <h2 className="font-medium">Add someone</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" name="name" errors={fieldErrors.name} required />
        <Field label="Email" name="email" type="email" errors={fieldErrors.email} required />
        <Field
          label="Password"
          name="password"
          type="password"
          errors={fieldErrors.password}
          hint="At least 10 characters. Shown only now — write it down before saving."
          required
        />
        <div className="space-y-1.5">
          <label htmlFor="role" className="text-sm font-medium">Role</label>
          <select
            id="role"
            name="role"
            defaultValue="salesperson"
            className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
          >
            <option value="salesperson">Salesperson — sells, never sees cost</option>
            <option value="owner">Owner — full access</option>
          </select>
        </div>
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
        {pending ? "Creating…" : "Create account"}
      </Button>
    </form>
  );
}

/**
 * Generate a password in the BROWSER rather than asking the server for one.
 *
 * A server-generated password would have to come back in the action's return value, which means it
 * exists in a response payload and anywhere that payload is logged. Generating it here keeps it in
 * one place — the screen in front of the owner — and the server only ever sees its hash.
 *
 * The alphabet omits characters that are misread when a password is written on paper and typed in
 * by someone else, which is exactly how this one is going to travel.
 */
function generatePassword(): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint32Array(16));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export function StaffList({
  staff,
  currentUserId,
  setActive,
  updateDetails,
  resetPassword,
}: {
  staff: Array<{ id: string; email: string; name: string; role: string; isActive: boolean }>;
  currentUserId: string;
  setActive: Action;
  updateDetails: Action;
  resetPassword: Action;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ name: string; email: string }>({ name: "", email: "" });
  const [newPassword, setNewPassword] = useState<{ userId: string; value: string } | null>(null);

  async function toggle(userId: string, isActive: boolean) {
    setBusy(userId);
    setError(null);
    const result = await setActive(crypto.randomUUID(), { userId, isActive });
    setBusy(null);
    if (result.ok) router.refresh();
    // The "last active owner" refusal arrives here — shown verbatim, because the message
    // explains both the problem and the way out.
    else setError(result.message);
  }

  async function saveDetails(userId: string) {
    setBusy(userId);
    setError(null);
    const result = await updateDetails(crypto.randomUUID(), {
      userId,
      name: draft.name,
      email: draft.email,
    });
    setBusy(null);
    if (result.ok) {
      setEditing(null);
      router.refresh();
    } else {
      setError(result.message);
    }
  }

  async function reset(userId: string) {
    const value = generatePassword();
    setBusy(userId);
    setError(null);
    setNewPassword(null);
    const result = await resetPassword(crypto.randomUUID(), { userId, password: value });
    setBusy(null);
    // Shown ONLY on success. Displaying a password the server rejected would have the owner hand
    // over one that does not work.
    if (result.ok) setNewPassword({ userId, value });
    else setError(result.message);
  }

  return (
    <section className="space-y-2">
      <h2 className="font-medium">Everyone with access</h2>
      {error ? (
        <p role="alert" className="text-destructive text-sm">{error}</p>
      ) : null}
      <ul className="divide-y rounded-lg border">
        {staff.map((person) => (
          <li key={person.id} className="px-4 py-3">
            <div className="flex items-center justify-between gap-4">
              <div className="text-sm">
                <span className={person.isActive ? "font-medium" : "text-muted-foreground"}>
                  {person.name}
                </span>
                {person.id === currentUserId ? (
                  <span className="text-muted-foreground"> (you)</span>
                ) : null}
                <span className="text-muted-foreground block text-xs">
                  {person.email} · {person.role}
                  {person.isActive ? "" : " · deactivated"}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setError(null);
                    setNewPassword(null);
                    if (editing === person.id) {
                      setEditing(null);
                    } else {
                      setEditing(person.id);
                      setDraft({ name: person.name, email: person.email });
                    }
                  }}
                >
                  {editing === person.id ? "Cancel" : "Edit"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy === person.id}
                  onClick={() => void toggle(person.id, !person.isActive)}
                >
                  {person.isActive ? "Deactivate" : "Reactivate"}
                </Button>
              </div>
            </div>

            {editing === person.id ? (
              <div className="mt-3 space-y-3 rounded-lg border p-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <label htmlFor={`name-${person.id}`} className="text-sm font-medium">
                      Name
                    </label>
                    <Input
                      id={`name-${person.id}`}
                      value={draft.name}
                      onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor={`email-${person.id}`} className="text-sm font-medium">
                      Email
                    </label>
                    <Input
                      id={`email-${person.id}`}
                      type="email"
                      value={draft.email}
                      onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))}
                    />
                    <p className="text-muted-foreground text-xs">
                      This is how they sign in. Changing it signs them out everywhere.
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    disabled={busy === person.id}
                    onClick={() => void saveDetails(person.id)}
                  >
                    {busy === person.id ? "Saving…" : "Save"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy === person.id}
                    onClick={() => void reset(person.id)}
                  >
                    Reset password
                  </Button>
                </div>

                {newPassword?.userId === person.id ? (
                  <div
                    role="status"
                    className="space-y-1 rounded-md border border-green-700/40 p-3 text-sm"
                  >
                    <p className="font-medium">New password for {person.name}</p>
                    <code className="block font-mono text-base select-all">
                      {newPassword.value}
                    </code>
                    <p className="text-muted-foreground text-xs">
                      Write this down now — it is not shown again, and it is stored only as a
                      hash. Their existing sessions have been ended.
                    </p>
                  </div>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground text-xs">
        Accounts are deactivated, never deleted — their name stays attached to every sale and
        adjustment they recorded. Deactivating ends their sessions immediately.
      </p>
    </section>
  );
}

function Field({
  label,
  name,
  type = "text",
  errors,
  hint,
  required,
}: {
  label: string;
  name: string;
  type?: string;
  errors?: string[];
  hint?: string;
  required?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={name} className="text-sm font-medium">{label}</label>
      <Input id={name} name={name} type={type} required={required}
        autoComplete={type === "password" ? "new-password" : undefined} />
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
      {errors?.length ? <p className="text-destructive text-xs">{errors.join(". ")}</p> : null}
    </div>
  );
}
