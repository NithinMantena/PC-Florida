# Florida P&C data server: MCP (/mcp) + REST (/api) in one container.
#
#   docker build -t pc-florida .
#   docker run -d -p 8000:8000 -e FLPC_API_KEY=... -v /srv/pc-florida:/data pc-florida
#   docker run -i --rm pc-florida stdio          # MCP over stdio (Claude Desktop)
#
# The quarterly workbooks in the repo are baked in; drop newer ones (and an
# optional carrier_groups.csv override) into the /data volume and the server
# picks them up within a minute — no rebuild or restart needed.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/api \
    FLPC_INPUT_DIRS=/app:/data \
    FLPC_DB=/var/lib/flpc/florida_pc.sqlite

WORKDIR /app
COPY api/requirements.txt api/requirements.txt
RUN pip install --no-cache-dir -r api/requirements.txt

COPY etl/ingest.py etl/ingest.py
COPY config/ config/
COPY api/flpc/ api/flpc/
COPY *.xlsx ./

RUN useradd --system --uid 10001 flpc \
 && mkdir -p /data /var/lib/flpc \
 && python -m flpc build \
 && chown -R flpc /data /var/lib/flpc

USER flpc
VOLUME ["/data"]
EXPOSE 8000
ENTRYPOINT ["python", "-m", "flpc"]
CMD ["serve"]
