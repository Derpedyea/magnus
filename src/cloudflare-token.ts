import { createStore } from "@tanstack/react-store";

/** The Cloudflare API token an admin pasted, kept in this tab's memory only: reloading forgets it. */
export const cloudflareToken = createStore("");

export const setCloudflareToken = (token: string) => cloudflareToken.setState(() => token);
