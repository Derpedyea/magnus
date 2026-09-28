import { createFileRoute } from "@tanstack/react-router";
import { Centered } from "../components/Centered";

export const Route = createFileRoute("/_app/$view/")({
	component: () => <Centered>Select a conversation</Centered>,
});
