# syntax=docker/dockerfile:1
# Proton's Export Tool, unmodified, and the wrapper the ProtonImport Durable Object talks to (server.ts).
# Built by `wrangler deploy` from wrangler.jsonc. The tool is GPL-3.0 and runs here as a separate program:
# https://github.com/ProtonMail/proton-mail-export

# Node runs the wrapper's TypeScript as is. The tool is an x86-64 Linux build, which is what Containers run (wrangler
# builds for linux/amd64).
FROM node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

# The tool calls Proton over TLS and needs the system's root certificates.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

# Proton's v1.0.7 release, refused if it isn't byte for byte the one checked. To update, change both lines together.
ADD --checksum=sha256:350b7d9884c1fd75236d2902ecc5e5d4155f829c864817c6ad5e8907c9f06bd6 \
	https://github.com/ProtonMail/proton-mail-export/releases/download/v1.0.7/proton-mail-export-cli-linux_x86_64.tar.gz \
	/tmp/proton-mail-export.tar.gz

# It writes its log beside itself, so its folder is the wrapper user's, as is where it exports to.
RUN mkdir -p /opt/proton-export /export \
	&& tar -xzf /tmp/proton-mail-export.tar.gz -C /opt/proton-export \
	&& rm /tmp/proton-mail-export.tar.gz \
	&& chown -R node:node /opt/proton-export /export

WORKDIR /app
COPY session.ts files.ts server.ts ./
USER node
EXPOSE 8080
CMD ["node", "server.ts"]
