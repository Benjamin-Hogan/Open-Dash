FROM python:3.12-slim

WORKDIR /app

# Install runtime deps directly (no `pip install .`, which would need the source
# present to build the wheel). Keep this list in sync with pyproject.toml.
RUN pip install --no-cache-dir \
    "fastapi>=0.110" \
    "uvicorn[standard]>=0.27" \
    "pydantic>=2.6" \
    "httpx>=0.27" \
    "pillow>=10.2"

COPY server ./server
COPY web ./web
COPY admin ./admin

# Live config + backups + secrets persist here (mount a volume at /app/data).
ENV DATA_DIR=/app/data

EXPOSE 8081 8082

CMD ["python", "-m", "server.run"]
