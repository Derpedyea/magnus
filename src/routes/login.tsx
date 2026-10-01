import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { FieldSeparator } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from "@/components/ui/input-otp";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "../api";
import { configQuery } from "../queries";
import { endSession } from "../session";

export const Route = createFileRoute("/login")({
	validateSearch: (search: Record<string, unknown>): { redirect?: string; error?: string } => ({
		// Only paths on this site, so a crafted link can't bounce you elsewhere after signing in.
		redirect: typeof search.redirect === "string" && /^\/(?!\/)/.test(search.redirect) ? search.redirect : undefined,
		error: typeof search.error === "string" ? search.error : undefined,
	}),
	beforeLoad: async ({ context }) => {
		if ((await context.queryClient.ensureQueryData(configQuery)).setupRequired) throw redirect({ to: "/setup" });
	},
	component: Login,
});

/** Better Auth's error codes when Google sign-in fails; anything else shows its code. */
const ERRORS: Record<string, string> = {
	signup_disabled: "That Google account isn't set up for Magnus Mail.",
	access_denied: "Sign-in was cancelled.",
};

/** Better Auth's email-code errors, in plainer words. */
const CODE_ERRORS: Record<string, string> = {
	"Invalid OTP": "That code isn't right.",
	"OTP expired": "That code has expired. Send a new one.",
	"Too many attempts": "Too many wrong tries. Send a new code.",
};

function Login() {
	const { redirect, error } = Route.useSearch();
	const returnTo = redirect ?? "/";
	const { google: googleEnabled } = useSuspenseQuery(configQuery).data;
	const [email, setEmail] = useState("");
	// Set once a code has been requested: the page switches to entering it.
	const [sentTo, setSentTo] = useState<string | null>(null);
	// Neither touches cached data: Google sign-in leaves the page (Better Auth's client redirects), and codes arrive by email.
	// react-doctor-disable-next-line react-doctor/query-mutation-missing-invalidation
	const google = useMutation({
		mutationFn: () =>
			authClient.signIn.social({ provider: "google", callbackURL: returnTo, errorCallbackURL: `/login?redirect=${encodeURIComponent(returnTo)}` }),
	});
	// react-doctor-disable-next-line react-doctor/query-mutation-missing-invalidation
	const sendCode = useMutation({
		mutationFn: (email: string) => authClient.emailOtp.sendVerificationOtp({ email, type: "sign-in" }),
		onSuccess: (_, to) => setSentTo(to),
	});
	const failure = google.error?.message ?? sendCode.error?.message ?? (error ? (ERRORS[error] ?? `Couldn't sign in (${error}).`) : null);

	return (
		<main className="flex h-full flex-col items-center justify-center gap-6 p-8 text-sm">
			<img src="/favicon.svg" alt="" className="size-10" />
			<h1 className="font-heading text-base font-semibold">Sign in to Magnus Mail</h1>
			{sentTo ? (
				<CodeForm email={sentTo} returnTo={returnTo} onBack={() => setSentTo(null)} />
			) : (
				<div className="flex w-72 flex-col gap-4">
					{googleEnabled ? (
						<>
							<Button
								variant="outline"
								size="lg"
								onClick={() => google.mutate()}
								// Stays disabled while the browser leaves for Google.
								disabled={google.isPending || google.isSuccess}
							>
								<GoogleMark />
								Continue with Google
							</Button>
							<FieldSeparator className="text-xs">or</FieldSeparator>
						</>
					) : null}
					<form
						className="flex flex-col gap-3"
						onSubmit={(e) => {
							e.preventDefault();
							sendCode.mutate(email.trim());
						}}
					>
						<Input
							type="email"
							required
							autoComplete="email"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							placeholder="Email address"
							aria-label="Email address"
							className="h-9"
						/>
						<Button type="submit" size="lg" disabled={sendCode.isPending}>
							{sendCode.isPending ? <Spinner data-icon="inline-start" /> : null}
							Email me a code
						</Button>
					</form>
				</div>
			)}
			{failure && !sentTo ? <p className="max-w-72 text-center text-destructive">{failure}</p> : null}
		</main>
	);
}

function CodeForm(props: { email: string; returnTo: string; onBack: () => void }) {
	const qc = useQueryClient();
	const navigate = useNavigate();
	const [code, setCode] = useState("");
	const verify = useMutation({
		mutationFn: (otp: string) => authClient.signIn.emailOtp({ email: props.email, otp }),
		// The session cookie is set; the app's route guard picks it up from here. Back can bring you to this page
		// still signed in, so whatever that account left in the tab goes first.
		onSuccess: () => {
			endSession(qc);
			return navigate({ href: props.returnTo });
		},
		onError: () => setCode(""),
	});
	// Only emails a new code; nothing cached changes.
	// react-doctor-disable-next-line react-doctor/query-mutation-missing-invalidation
	const resend = useMutation({
		mutationFn: () => authClient.emailOtp.sendVerificationOtp({ email: props.email, type: "sign-in" }),
		onSuccess: () => verify.reset(),
	});
	const failure = verify.error ? (CODE_ERRORS[verify.error.message] ?? verify.error.message) : (resend.error?.message ?? null);

	return (
		<form
			className="flex w-72 flex-col items-center gap-4"
			onSubmit={(e) => {
				e.preventDefault();
				verify.mutate(code);
			}}
		>
			<p className="text-center text-balance text-muted-foreground">
				If <span className="font-medium text-foreground">{props.email}</span> can sign in here, a code is on its way.
			</p>
			<InputOTP
				maxLength={6}
				pattern={REGEXP_ONLY_DIGITS}
				autoFocus
				aria-label="Sign-in code"
				value={code}
				onChange={setCode}
				// Pasting or typing the sixth digit signs in without another click.
				onComplete={(digits: string) => {
					if (!verify.isPending) verify.mutate(digits);
				}}
			>
				<InputOTPGroup>
					{[0, 1, 2].map((i) => (
						<InputOTPSlot key={i} index={i} className="size-10 text-base" />
					))}
				</InputOTPGroup>
				<InputOTPSeparator />
				<InputOTPGroup>
					{[3, 4, 5].map((i) => (
						<InputOTPSlot key={i} index={i} className="size-10 text-base" />
					))}
				</InputOTPGroup>
			</InputOTP>
			<Button type="submit" size="lg" disabled={verify.isPending || code.length !== 6} className="w-full">
				{verify.isPending ? <Spinner data-icon="inline-start" /> : null}
				Sign in
			</Button>
			{failure ? <p className="text-center text-destructive">{failure}</p> : null}
			{!failure && resend.isSuccess ? <p className="text-center text-muted-foreground">A new code is on its way.</p> : null}
			<div className="flex justify-center">
				<Button variant="link" size="sm" onClick={() => resend.mutate()} disabled={resend.isPending} className="text-muted-foreground">
					Send a new code
				</Button>
				<Button variant="link" size="sm" onClick={props.onBack} className="text-muted-foreground">
					Use a different email
				</Button>
			</div>
		</form>
	);
}

function GoogleMark() {
	return (
		<svg viewBox="0 0 48 48" className="size-4" aria-hidden="true">
			<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
			<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
			<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
			<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
		</svg>
	);
}
