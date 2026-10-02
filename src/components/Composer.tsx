import {
	type Address,
	type AttachmentMeta,
	formatBytes,
	isValidAddress,
	MAX_UPLOAD_BYTES,
	makeSnippet,
	planAttachments,
	type SendAttachmentRef,
} from "#shared";
import { noteBody } from "#shared/markdown";
import { useForm, useSelector } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { shallow } from "@tanstack/react-store";
import { CheckIcon, CloudOffIcon, ForwardIcon, LinkIcon, PaperclipIcon, Trash2Icon, XIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast-manager";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { api, errorMessage, type Identity } from "../api";
import { closeDraft, openLocalDraft, withSignature } from "../compose";
import { hasDraftContent, type Draft, type SavedDraft } from "#shared/drafts";
import { useDraftEntries, useDraftSync } from "../drafts";
import { normalizeMarkdown } from "../markdown";
import { currentSession } from "../session";
import { MarkdownEditor } from "./MarkdownEditor";
import { RecipientField } from "./RecipientField";
import { toastUndoSend } from "./UndoToast";

export type { Draft } from "#shared/drafts";

const UNDO_SECONDS = 10;

export function Composer(props: {
	/** Every identity the user can send as, across mailboxes. */
	identities: Identity[];
	/** This opening (compose.ts). A send outlives it: the draft can be closed, or another opened, while it goes. */
	id: number;
	draftId: string;
	saved?: SavedDraft;
	initial: Draft;
	/** Came back through Undo or Reopen (compose.ts). */
	restored: boolean;
}) {
	const qc = useQueryClient();
	const sync = useDraftSync();
	const entry = useDraftEntries().find((entry) => entry.id === props.draftId);
	const close = () => {
		const draft = sync.get(props.draftId);
		if (draft?.state === "active" && !draft.removing) void sync.flush(props.draftId).catch((error: unknown) => toast.add({ title: `Draft hasn't synced. ${errorMessage(error)}`, type: "error", timeout: 0 }));
		closeDraft(props.id);
	};
	const send = useMutation({
		mutationFn: async (draft: Draft) => {
			const session = currentSession();
			if (sync.get(props.draftId)?.state !== "sending") sync.update(props.draftId, draft);
			const saved = await sync.flush(props.draftId);
			if (session !== currentSession()) throw new Error("Your session ended before this message was sent");
			sync.lock(props.draftId);
			return api.send(draft.mailboxId, {
				draft: { id: props.draftId, revision: saved.revision },
				from: draft.from,
				to: draft.to,
				cc: draft.cc,
				bcc: draft.bcc,
				subject: draft.subject,
				text: draft.text,
				replyToMessageId: draft.replyToMessageId,
				forward: draft.forward && {
					messageId: draft.forward.message.id,
					attachmentIds: draft.forward.files.map((f) => f.id),
					timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
				},
				attachments: draft.attachments,
				delaySeconds: UNDO_SECONDS,
			});
		},
		onMutate: currentSession,
		onSuccess: (queued, draft, session) => {
			if (session !== currentSession()) return;
			sync.sent(props.draftId);
			// The live socket reports this too, but it may be reconnecting.
			void qc.invalidateQueries({ queryKey: ["mail"] });
			// Whoever this went to is suggested next time.
			void qc.invalidateQueries({ queryKey: ["contacts"] });
			closeDraft(props.id);
			toastUndoSend(queued, draft, qc);
		},
		onError: async (_error, _draft, session) => {
			if (session !== currentSession()) return;
			// Release the local lock only on the server's word. An uncertain send retains its stable id for retry.
			try {
				const saved = await api.draft(props.draftId);
				if (session === currentSession()) sync.confirm(saved);
			} catch (error) {
				if (session === currentSession()) toast.add({ title: `Couldn't check this send: ${errorMessage(error)}. Retry Send to check again.`, type: "error", timeout: 0 });
			}
		},
	});
	const form = useForm({ defaultValues: props.initial, onSubmit: ({ value }) => send.mutate(value) });
	useEffect(() => {
		const session = currentSession();
		if (props.saved) sync.adopt(props.saved);
		const persist = () => {
			if (session !== currentSession()) return;
			const draft = form.state.values;
			const initial = { ...props.initial, text: normalizeMarkdown(props.initial.text) };
			if (sync.get(props.draftId) || props.restored || hasDraftContent(draft, initial)) sync.update(props.draftId, draft);
		};
		persist();
		const unsubscribe = form.store.subscribe(persist);
		return () => { persist(); unsubscribe.unsubscribe(); };
	}, [form, sync, props.draftId, props.initial, props.restored, props.saved]);
	const discard = useMutation({
		mutationFn: () => sync.discard(props.draftId),
		onMutate: currentSession,
		onSuccess: (_result, _variables, session) => {
			if (session !== currentSession()) return;
			closeDraft(props.id);
			void qc.invalidateQueries({ queryKey: ["drafts"] });
		},
	});
	// Uploads only feed the draft's own attachment list; no cached query reads them.
	// react-doctor-disable-next-line react-doctor/query-mutation-missing-invalidation
	const upload = useMutation({
		mutationFn: async (files: File[]) => {
			const tooBig = files.find((f) => f.size > MAX_UPLOAD_BYTES);
			if (tooBig) throw new Error(`Files can be up to ${formatBytes(MAX_UPLOAD_BYTES)}. ${tooBig.name} is ${formatBytes(tooBig.size)}.`);
			const session = currentSession();
			const mailboxId = form.getFieldValue("mailboxId");
			// Successful files survive a sibling's failure and finish saving even after the composer closes.
			const results = await Promise.allSettled(files.map(async (file) => {
				const ref = await api.upload(mailboxId, file);
				if (session !== currentSession()) return;
				form.setFieldValue("attachments", (previous) => [...previous, ref]);
				sync.update(props.draftId, form.state.values);
			}));
			const failures = results.filter((result) => result.status === "rejected");
			if (failures.length) throw new Error(failures.map((failure) => errorMessage(failure.reason)).join("; "));
		},
	});
	const [showCc, setShowCc] = useState(Boolean(props.initial.cc.length + props.initial.bcc.length || props.initial.recipientInputs?.cc || props.initial.recipientInputs?.bcc));
	const filePicker = useRef<HTMLInputElement>(null);
	const sheet = useRef<HTMLFormElement>(null);
	// Phones: the composer fills what the on-screen keyboard leaves of the screen. The keyboard only shrinks the
	// visual viewport, so without this Send and the caret could end up behind it.
	useEffect(() => {
		const viewport = window.visualViewport;
		const form = sheet.current;
		if (!viewport || !form) return;
		const fit = () => {
			form.style.setProperty("--visible-top", `${viewport.offsetTop}px`);
			form.style.setProperty("--visible-height", `${viewport.height}px`);
		};
		fit();
		viewport.addEventListener("resize", fit);
		viewport.addEventListener("scroll", fit);
		return () => {
			viewport.removeEventListener("resize", fit);
			viewport.removeEventListener("scroll", fit);
		};
	}, []);
	const mailboxId = useSelector(form.store, (s) => s.values.mailboxId);
	// Replies, forwards, and uploads belong to one mailbox, so From can't move them to another.
	const pinned = useSelector(form.store, (s) => Boolean(s.values.replyToMessageId || s.values.forward) || s.values.attachments.length > 0);
	// Same split the server makes on send: whatever doesn't fit in the message goes as a download link. A forward's
	// HTML isn't loaded here, so a file right at the limit may still go as a link.
	const linked = new Set(
		useSelector(form.store, (s) => {
			const forward = s.values.forward;
			const files = [...s.values.attachments, ...(forward?.files ?? [])];
			if (files.length === 0) return [];
			const note = noteBody(s.values.text);
			const body = { text: note.text + (forward?.message.text ?? ""), html: note.html };
			const embedded = forward?.message.hasHtml ? forward.message.attachments.reduce((n, a) => n + (a.inline && a.contentId ? a.size : 0), 0) : 0;
			return planAttachments(files, body, `${location.origin}/f/${s.values.mailboxId}/`, embedded).linked.map(fileKey);
		}),
	);
	const fromOptions = pinned || upload.isPending ? props.identities.filter((i) => i.mailboxId === mailboxId) : props.identities;
	const key = (mailboxId: string, address: string) => `${mailboxId}/${address}`;
	const error = send.error ?? upload.error ?? discard.error;
	const locked = send.isPending || discard.isPending || entry?.state === "sending" || entry?.removing;
	// Anyone in To, Cc, or Bcc isn't suggested for another.
	const recipients = useSelector(form.store, (s) => [...s.values.to, ...s.values.cc, ...s.values.bcc], { compare: shallow });
	const recipientInputs = useSelector(form.store, (s) => s.values.recipientInputs);
	const taken = new Set(recipients.map((a) => a.address.toLowerCase()));

	const recipientField = (name: "to" | "cc" | "bcc", label: string, after?: ReactNode) => (
		<form.Field
			name={name}
			validators={{
				onChange: ({ value }) => invalidAddresses(value),
				onSubmit: ({ value }) => (name === "to" && value.length === 0 ? "Add a recipient" : invalidAddresses(value)),
			}}
		>
			{(f) => (
				<>
					<RecipientField
						label={label}
						value={f.state.value}
						inputValue={recipientInputs?.[name] ?? ""}
						onInputChange={(input) => form.setFieldValue("recipientInputs", (previous) => ({ to: previous?.to ?? "", cc: previous?.cc ?? "", bcc: previous?.bcc ?? "", [name]: input }))}
						onChange={f.handleChange}
						onBlur={f.handleBlur}
						taken={taken}
						invalid={!f.state.meta.isValid}
						// A new message starts at To; one reopened by Undo, at its text.
						autoFocus={name === "to" && !props.initial.replyToMessageId && props.initial.to.length === 0}
					>
						{after}
					</RecipientField>
					{f.state.meta.isValid ? null : <FieldError className="border-b px-3 py-1 text-xs">{f.state.meta.errors.join(", ")}</FieldError>}
				</>
			)}
		</form.Field>
	);

	// On phones it leads the title bar, where the keyboard can't cover it, as in Apple Mail; elsewhere it leads the footer.
	const sendButton = (className: string) => (
		<form.Subscribe selector={(s) => s.values.from !== ""}>
			{(ready) => (
				<Button type="submit" disabled={!ready || send.isPending || upload.isPending || discard.isPending || entry?.removing || entry?.status === "conflict"} className={cn("px-4", className)}>
					{send.isPending ? <Spinner data-icon="inline-start" /> : null}
					{entry?.state === "sending" && !send.isPending ? "Retry Send" : "Send"}
				</Button>
			)}
		</form.Subscribe>
	);

	return (
		// A sheet over the whole screen on phones, like every phone mail app's; a window docked bottom right elsewhere.
		<form
			ref={sheet}
			onSubmit={(e) => {
				e.preventDefault();
				void form.handleSubmit();
			}}
			aria-label="Message composer"
			className="fixed z-30 flex flex-col overflow-hidden bg-popover text-popover-foreground max-md:inset-x-0 max-md:top-[var(--visible-top,0px)] max-md:h-[var(--visible-height,100dvh)] max-md:bg-background md:right-6 md:bottom-0 md:max-h-[100dvh] md:w-[36rem] md:max-w-[calc(100vw-3rem)] md:rounded-t-xl md:border md:shadow-2xl"
		>
			<div className="flex shrink-0 items-center justify-between gap-2 border-b bg-muted/50 py-1 pr-1 pl-3 max-md:h-14 max-md:bg-transparent max-md:px-2">
				<span className="truncate font-medium max-md:flex-1">{props.initial.forward ? "Forward" : props.initial.replyToMessageId ? "Reply" : "New message"}</span>
				{sendButton("h-9 md:hidden")}
				<Tooltip>
					<TooltipTrigger
						render={
							<Button variant="ghost" size="icon-sm" onClick={close} disabled={discard.isPending} aria-label="Close and save draft" className="max-md:order-first max-md:size-10">
								<XIcon className="size-4 max-md:size-5" />
							</Button>
						}
					/>
					<TooltipContent>Save and close</TooltipContent>
				</Tooltip>
			</div>
			{/* On phones a column, so the message takes whatever height the fields leave. */}
			<fieldset disabled={locked} className="min-h-0 overflow-y-auto max-md:flex max-md:flex-1 max-md:flex-col">
			<form.Field name="from">
				{(f) => (
					<div className="flex items-center border-b pl-3 focus-within:border-ring">
						<span className="w-9 shrink-0 text-muted-foreground">From</span>
						<Select
							items={fromOptions.map((i) => ({ value: key(i.mailboxId, i.address), label: identityLabel(i) }))}
							value={key(mailboxId, f.state.value)}
							onValueChange={(value) => {
								const picked = fromOptions.find((i) => key(i.mailboxId, i.address) === value);
								if (!picked) return;
								const current = props.identities.find((i) => i.mailboxId === mailboxId && i.address === f.state.value);
								form.setFieldValue("text", (text) => withSignature(text, current?.signature ?? null, picked.signature, normalizeMarkdown));
								form.setFieldValue("mailboxId", picked.mailboxId);
								f.handleChange(picked.address);
							}}
						>
							<SelectTrigger aria-label="From" className="h-9 flex-1 rounded-none border-0 pr-3 pl-0 focus-visible:ring-0 data-[size=default]:h-9 dark:bg-transparent">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectGroup>
								{fromOptions.map((i) => (
									<SelectItem key={key(i.mailboxId, i.address)} value={key(i.mailboxId, i.address)}>
										{identityLabel(i)}
									</SelectItem>
								))}
								</SelectGroup>
							</SelectContent>
						</Select>
					</div>
				)}
			</form.Field>
			{recipientField(
				"to",
				"To",
				showCc ? null : (
					<Button variant="ghost" size="xs" onClick={() => setShowCc(true)} className="mt-1.5 text-muted-foreground">
						Cc/Bcc
					</Button>
				),
			)}
			{showCc ? (
				<>
					{recipientField("cc", "Cc")}
					{recipientField("bcc", "Bcc")}
				</>
			) : null}
			<form.Field name="subject">
				{(f) => <Input aria-label="Subject" value={f.state.value} onChange={(e) => f.handleChange(e.target.value)} placeholder="Subject" className={FIELD} />}
			</form.Field>
			<form.Field name="text">
				{(f) => (
					<MarkdownEditor
						value={f.state.value}
						onChange={f.handleChange}
						aria-label="Message"
						editable={!locked}
						// The height of 14 lines, or 8 above a forward; on phones, whatever the fields leave.
						className={cn("overflow-y-auto px-3 py-2.5 text-base max-md:min-h-24 max-md:flex-1 md:text-sm", props.initial.forward ? "md:h-45" : "md:h-75")}
						autoFocus={!props.initial.replyToMessageId && props.initial.to.length > 0}
					/>
				)}
			</form.Field>
			{props.initial.forward ? <Forwarded message={props.initial.forward.message} /> : null}
			<ul className="flex flex-wrap gap-1.5 px-3 pb-2 empty:hidden">
				<form.Field name="forward">
					{(f) =>
						f.state.value?.files.map((a) => (
							<FileChip
								key={a.id}
								file={a}
								linked={linked.has(a.id)}
								onRemove={() => f.handleChange((prev) => prev && { ...prev, files: prev.files.filter((x) => x !== a) })}
							/>
						))
					}
				</form.Field>
				<form.Field name="attachments">
					{(f) =>
						f.state.value.map((a) => (
							<FileChip key={a.r2Key} file={a} linked={linked.has(a.r2Key)} onRemove={() => f.handleChange((prev) => prev.filter((x) => x !== a))} />
						))
					}
				</form.Field>
			</ul>
			</fieldset>
			{error ? <p className="px-3 pb-2 text-destructive">{error.message}</p> : null}
			{entry?.state === "sending" && !send.isPending ? <p className="px-3 pb-2 text-xs text-muted-foreground">Send wasn't confirmed. Retry Send to check its status.</p> : null}
			{entry?.status === "conflict" ? <p className="px-3 pb-2 text-xs text-destructive">{entry.error}</p> : null}
			{entry?.status === "error" ? <p role="alert" className="px-3 pb-2 text-xs text-destructive">{entry.error}</p> : null}
			<div className="flex shrink-0 items-center gap-1 border-t px-3 py-2">
				{sendButton("mr-1 max-md:hidden")}
				<Tooltip>
					<TooltipTrigger
						render={
							<Button variant="ghost" size="icon" aria-label="Attach files" disabled={upload.isPending || locked} onClick={() => filePicker.current?.click()}>
								{upload.isPending ? <Spinner /> : <PaperclipIcon />}
							</Button>
						}
					/>
					<TooltipContent>Attach files</TooltipContent>
				</Tooltip>
				<input ref={filePicker} type="file" multiple hidden onChange={(e) => { if (e.target.files?.length) upload.mutate([...e.target.files]); e.target.value = ""; }} />
				<div className="ml-auto flex min-w-0 items-center gap-1.5">
					<span role="status" aria-live="polite" title={entry?.status === "saved" ? `Saved to your account at ${new Date(entry.updatedAt).toLocaleTimeString()}` : undefined} className={cn("flex items-center gap-1.5 text-xs", entry?.status === "error" || entry?.status === "conflict" ? "text-destructive" : "text-muted-foreground")}>
						{entry?.status === "saving" || entry?.status === "pending" ? <><Spinner className="size-3.5" />Saving…</> : entry?.status === "saved" ? <><CheckIcon className="size-3.5" />Saved</> : entry?.status === "error" || entry?.status === "conflict" ? <><CloudOffIcon className="size-3.5" />Not synced</> : null}
					</span>
					{entry?.status === "error" ? <Button variant="ghost" size="xs" onClick={() => {
						if (entry.removing) discard.mutate();
						else void sync.flush(props.draftId).catch((error: unknown) => toast.add({ title: errorMessage(error), type: "error" }));
					}}>Retry</Button> : null}
					{entry?.status === "conflict" ? <Button variant="outline" size="xs" onClick={() => {
						const id = sync.copy(props.draftId);
						const copy = sync.get(id);
						if (copy) openLocalDraft(id, copy.content);
					}}>Save a copy</Button> : null}
					<Tooltip>
						<TooltipTrigger render={<Button variant="ghost" size="icon" aria-label="Discard draft" disabled={upload.isPending || locked || entry?.status === "conflict"} onClick={() => discard.mutate()}><Trash2Icon /></Button>} />
						<TooltipContent>Discard draft</TooltipContent>
					</Tooltip>
				</div>
			</div>
				{linked.size > 0 ? (
					<span className="flex items-center gap-1 px-3 pb-2 text-xs text-muted-foreground">
						<LinkIcon className="size-3 shrink-0" />
						Too big to attach, so sent as {linked.size === 1 ? "a link" : "links"}
					</span>
				) : null}
		</form>
	);
}

/** The forwarded message, which goes below the note untouched: who it's from and how it starts. */
function Forwarded({ message: m }: { message: NonNullable<Draft["forward"]>["message"] }) {
	const snippet = makeSnippet(m.text);
	return (
		<blockquote className="mx-3 mb-3 border-l-2 pl-3 text-xs text-muted-foreground">
			<p className="flex items-center gap-1.5">
				<ForwardIcon className="size-3.5 shrink-0" />
				<span className="truncate">
					<span className="font-medium text-foreground">{m.from.name || m.from.address}</span> · {new Date(m.date).toLocaleString()}
				</span>
			</p>
			{snippet ? <p className="mt-1 line-clamp-2">{snippet}</p> : null}
		</blockquote>
	);
}

function FileChip(props: { file: { filename: string; size: number }; linked: boolean; onRemove: () => void }) {
	return (
		<li>
			<Badge variant="secondary" className="h-6 pr-0.5">
				{props.linked ? <LinkIcon data-icon="inline-start" aria-label="Sent as a link" /> : null}
				{props.file.filename} <span className="text-muted-foreground">{formatBytes(props.file.size)}</span>
				<Button variant="ghost" size="icon-xs" className="size-5 rounded-full" aria-label={`Remove ${props.file.filename}`} onClick={props.onRemove}>
					<XIcon />
				</Button>
			</Badge>
		</li>
	);
}

/** Uploads are told apart by storage key, a forward's files by id. */
const fileKey = (f: SendAttachmentRef | AttachmentMeta) => ("r2Key" in f ? f.r2Key : f.id);

const identityLabel = (i: Identity) => (i.displayName ? `${i.displayName} <${i.address}>` : i.address);

/** Borderless rows split by rules, so the header fields read as one sheet. */
const FIELD = "h-9 rounded-none border-0 border-b px-3 focus-visible:border-ring focus-visible:ring-0 aria-invalid:ring-0 dark:bg-transparent";

/** Field error for a recipient list, or undefined when every entry is an address. */
function invalidAddresses(list: Address[]): string | undefined {
	const bad = list.filter((a) => !isValidAddress(a.address));
	return bad.length ? `Not an email address: ${bad.map((a) => a.address).join(", ")}` : undefined;
}
