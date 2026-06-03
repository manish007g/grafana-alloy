# backend/app2_worker.py
# ── Must be first, before any other imports ──────────────
import os
os.environ["OTEL_SERVICE_NAME"] = "job-processor"
os.environ["OTEL_RESOURCE_ATTRIBUTES"] = "service.version=1.0,deployment.environment=learning"

import time, random, structlog
from celery import Celery
from prometheus_client import Counter, Histogram, Gauge, start_http_server
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.celery import CeleryInstrumentor

# --- Tracing ---
provider = TracerProvider()
provider.add_span_processor(BatchSpanProcessor(
    OTLPSpanExporter(endpoint="http://localhost:4317", insecure=True)
))
trace.set_tracer_provider(provider)
CeleryInstrumentor().instrument()

log = structlog.get_logger()
structlog.configure(processors=[structlog.processors.JSONRenderer()])

app = Celery("worker", broker=os.environ.get("REDIS_URL", "redis://localhost:6379/0"))
start_http_server(8001)   # exposes /metrics on port 8001

# Metrics
jobs_processed  = Counter("jobs_processed_total", "Jobs done", ["job_type", "status"])
job_duration    = Histogram("job_duration_seconds", "Job processing time", ["job_type"])
queue_depth     = Gauge("queue_depth", "Jobs waiting in queue")
retry_count     = Counter("job_retries_total", "Retried jobs", ["job_type"])

@app.task(bind=True, max_retries=3)
def process_email(self, email: str, name: str, items_summary: str, price: float):
    tracer = trace.get_tracer("job-processor")
    with tracer.start_as_current_span("process_email") as span:
        span.set_attribute("customer.email", email)
        span.set_attribute("customer.name", name)
        span.set_attribute("order.items", items_summary)
        span.set_attribute("order.price", price)
        start = time.time()
        try:
            # Simulate work
            time.sleep(random.uniform(0.1, 0.6))
            if random.random() < 0.05:
                raise ValueError("SMTP connection refused")
            
            jobs_processed.labels(job_type="email", status="success").inc()
            job_duration.labels(job_type="email").observe(time.time() - start)
            log.info("email_sent", email=email, name=name, summary=items_summary, total_charged=price)
        except Exception as exc:
            retry_count.labels(job_type="email").inc()
            log.error("email_failed", email=email, error=str(exc))
            raise self.retry(exc=exc, countdown=5)

@app.task
def generate_report(report_id: str):
    tracer = trace.get_tracer("job-processor")
    with tracer.start_as_current_span("generate_report") as span:
        span.set_attribute("report.id", report_id)
        start = time.time()
        time.sleep(random.uniform(2, 5))   # simulate heavy work
        jobs_processed.labels(job_type="report", status="success").inc()
        job_duration.labels(job_type="report").observe(time.time() - start)
        log.info("report_generated", report_id=report_id)

# Continuously simulate load (for learning purposes)
if __name__ == "__main__":
    import threading
    def load_gen():
        while True:
            queue_depth.set(random.randint(0, 50))
            time.sleep(5)
    threading.Thread(target=load_gen, daemon=True).start()
    app.worker_main(argv=["worker", "--loglevel=info",
                          "--logfile=../logs/app2.log"])
