FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UPSC_HOST=0.0.0.0 \
    UPSC_PORT=8000

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && python -m playwright install --with-deps chromium

COPY upsc_intel ./upsc_intel
COPY config ./config
RUN mkdir -p data inbox

EXPOSE 8000
VOLUME ["/app/data", "/app/inbox"]
CMD ["python", "-m", "upsc_intel", "serve"]
