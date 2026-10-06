import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useId } from "react";
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { SettingsPage } from "../components/SettingsPage";
import { disablePush, enablePush, pushState, pushSupport } from "../push";

export const Route = createFileRoute("/_app/_settings/settings/notifications")({ component: Notifications });

const CANT = {
	install: "iPhone and iPad notify only from the Home Screen: tap Share, then Add to Home Screen, and turn this on there.",
	unsupported: "This browser can't show notifications.",
};

/** Per device, like Fastmail's: notifications go to the browsers they were turned on in, while they're signed in. */
function Notifications() {
	const support = pushSupport();
	return (
		<SettingsPage title="Notifications">
			<FieldGroup className="max-w-xl">{support === "supported" ? <DeviceSwitch /> : <Row checked={false} disabled description={CANT[support]} />}</FieldGroup>
		</SettingsPage>
	);
}

function DeviceSwitch() {
	const qc = useQueryClient();
	const state = useQuery({ queryKey: ["push"], queryFn: pushState });
	const toggle = useMutation({
		mutationFn: async (permission: Promise<NotificationPermission> | null) => {
			if (!permission) return disablePush();
			if (!state.data) throw new Error("Notifications are still loading");
			return enablePush(permission, state.data.publicKey);
		},
		onSettled: () => qc.invalidateQueries({ queryKey: ["push"] }),
	});
	const blocked = state.data?.blocked && !state.data.on;
	return (
		<Row
			checked={state.data?.on ?? false}
			disabled={!state.data || blocked || toggle.isPending}
			// Asked here, inside the click: Safari won't ask from anywhere else.
			onChange={(on) => toggle.mutate(on ? Notification.requestPermission() : null)}
			description={
				blocked ? "Notifications are blocked for this site. Allow them in your browser's settings." : "Shows the sender, subject, and first line of new mail in your inbox."
			}
			error={state.error?.message ?? toggle.error?.message}
		/>
	);
}

function Row(props: { checked: boolean; disabled: boolean; description: string; error?: string; onChange?: (on: boolean) => void }) {
	const id = useId();
	return (
		<Field orientation="horizontal" data-disabled={props.disabled}>
			<FieldContent>
				<FieldLabel htmlFor={id}>New mail on this device</FieldLabel>
				<FieldDescription>{props.description}</FieldDescription>
				{props.error ? <FieldError>{props.error}</FieldError> : null}
			</FieldContent>
			<Switch id={id} checked={props.checked} disabled={props.disabled} onCheckedChange={props.onChange} />
		</Field>
	);
}
