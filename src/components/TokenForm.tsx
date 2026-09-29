import { tokenTemplateUrl } from "#shared";
import { ExternalLinkIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

/** Create a Cloudflare API token (the link fills in every permission), then paste it. */
export function TokenForm(props: { onSubmit: (token: string) => void; pending: boolean; error: string | undefined; submitLabel?: string }) {
	const [token, setToken] = useState("");
	return (
		<form
			className="flex flex-col gap-3"
			onSubmit={(e) => {
				e.preventDefault();
				props.onSubmit(token.trim());
			}}
		>
			<div className="flex flex-col gap-1.5">
				<Button variant="outline" className="self-start" render={<a href={tokenTemplateUrl()} target="_blank" rel="noreferrer" />} nativeButton={false}>
					Create a token
					<ExternalLinkIcon data-icon="inline-end" />
				</Button>
				<p className="text-pretty text-muted-foreground">Magnus keeps it encrypted, so you only do this once.</p>
			</div>
			<div className="flex gap-2">
				<Input
					type="password"
					required
					autoComplete="off"
					spellCheck={false}
					value={token}
					onChange={(e) => setToken(e.target.value)}
					placeholder="Paste the token"
					aria-label="Cloudflare API token"
					aria-invalid={props.error ? true : undefined}
				/>
				<Button type="submit" disabled={props.pending || !token.trim()}>
					{props.pending ? <Spinner data-icon="inline-start" /> : null}
					{props.submitLabel ?? "Connect"}
				</Button>
			</div>
			{props.error ? <FieldError>{props.error}</FieldError> : null}
		</form>
	);
}
