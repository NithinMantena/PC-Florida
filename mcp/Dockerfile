# Local MCP server (stdio) for the hosted Florida P&C API.
#
#   docker build -f mcp/Dockerfile -t pc-florida-mcp .
#   docker run -i --rm -e FLPC_URL=https://<ref>.supabase.co/functions/v1/flpc -e FLPC_TOKEN=flpc_... pc-florida-mcp
#
# Published by CI as ghcr.io/nithinmantena/pc-florida-mcp:latest.
FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY client/ client/
COPY mcp/ mcp/
COPY supabase/functions/_shared/flpc/operations.json supabase/functions/_shared/flpc/operations.json

USER node
ENTRYPOINT ["node", "mcp/server.mjs"]
