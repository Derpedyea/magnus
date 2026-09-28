import { createStore } from "@tanstack/react-store";
import type { Draft } from "./components/Composer";

/**
 * The open composer. It floats above whatever route is showing, so any view can start a draft
 * (Compose, Reply, Undo send) without threading callbacks through the router.
 */
export const compose = createStore<Draft | null>(null);

export const openDraft = (draft: Draft) => compose.setState(() => draft);
export const closeDraft = () => compose.setState(() => null);
