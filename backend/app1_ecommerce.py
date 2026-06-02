# backend/app1_ecommerce.py
# ── Must be first, before any other imports ──────────────
import os
os.environ["OTEL_SERVICE_NAME"] = "ecommerce-api"
os.environ["OTEL_RESOURCE_ATTRIBUTES"] = "service.version=1.0,deployment.environment=learning"

import time, random, structlog
from flask import Flask, jsonify, request
from prometheus_flask_exporter import PrometheusMetrics
from prometheus_client import Counter, Histogram, Gauge
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.flask import FlaskInstrumentor
from opentelemetry.instrumentation.celery import CeleryInstrumentor
from celery import Celery

# --- Tracing setup ---
provider = TracerProvider()
provider.add_span_processor(BatchSpanProcessor(
    OTLPSpanExporter(endpoint="http://localhost:4317", insecure=True)
))
trace.set_tracer_provider(provider)
tracer = trace.get_tracer("ecommerce-api")

# --- Celery Client & Instrumentation ---
celery_app = Celery("worker", broker=os.environ.get("REDIS_URL", "redis://localhost:6379/0"))
CeleryInstrumentor().instrument()

# --- Structured logging ---
structlog.configure(processors=[structlog.processors.JSONRenderer()])
log = structlog.get_logger()

app = Flask(__name__)
metrics = PrometheusMetrics(app)         # auto exposes /metrics
FlaskInstrumentor().instrument_app(
    app,
    excluded_urls="metrics,health"   # don't trace scrape + health endpoints
)

# Custom business metrics
orders_total    = Counter("orders_total", "Total orders", ["status", "product"])
order_value     = Histogram("order_value_dollars", "Order value", buckets=[5,10,25,50,100,200])
active_carts    = Gauge("active_carts", "Carts currently open")
db_query_time   = Histogram("db_query_seconds", "DB query latency")

# --- API Routes for React Frontend ---

@app.route("/api/order", methods=["POST"])
def create_order():
    with tracer.start_as_current_span("create_order") as span:
        data = request.get_json(silent=True) or {}
        product = data.get("product", "widget")
        price   = data.get("price", random.uniform(5, 200))

        span.set_attribute("order.product", product)
        span.set_attribute("order.value",   price)

        # Simulate DB call
        with tracer.start_as_current_span("db.insert_order"):
            latency = random.uniform(0.005, 0.08)
            time.sleep(latency)
            db_query_time.observe(latency)

        # Simulate occasional failures (5% rate)
        if random.random() < 0.05:
            orders_total.labels(status="failed", product=product).inc()
            log.error("order_failed", product=product, reason="payment_timeout")
            return jsonify({"error": "payment timeout"}), 500

        orders_total.labels(status="success", product=product).inc()
        order_value.observe(price)
        log.info("order_created", product=product, price=round(price, 2))

        # Send background job to Celery worker (tracecontext is automatically injected)
        user_id = random.randint(1, 1000)
        task = celery_app.send_task("app2_worker.process_email", kwargs={"user_id": user_id})

        return jsonify({
            "order_id": random.randint(1000, 9999), 
            "price": round(price, 2),
            "status": "success",
            "celery_task_id": task.id
        })

@app.route("/api/cart/add", methods=["POST"])
def add_to_cart():
    active_carts.inc()
    data = request.get_json(silent=True) or {}
    item = data.get("item", "unknown item")
    log.info("cart_updated", action="add", item=item)
    return jsonify({"status": "added", "item": item})

@app.route("/api/cart/clear", methods=["POST"])
def clear_cart():
    active_carts.set(0)
    log.info("cart_cleared")
    return jsonify({"status": "cleared"})

@app.route("/api/report", methods=["POST"])
def create_report():
    with tracer.start_as_current_span("create_report") as span:
        data = request.get_json(silent=True) or {}
        report_id = data.get("report_id", f"report-{random.randint(1000, 9999)}")
        span.set_attribute("report.id", report_id)

        # Send heavy report task to Celery worker
        task = celery_app.send_task("app2_worker.generate_report", kwargs={"report_id": report_id})

        log.info("report_requested", report_id=report_id, celery_task_id=task.id)
        return jsonify({
            "report_id": report_id,
            "status": "triggered",
            "celery_task_id": task.id
        })

@app.route("/api/logs")
def get_logs():
    # Read log files (covering standard local and EC2 directory options)
    log_paths = [
        ("app1.log", os.path.expanduser("~/logs/app1.log")),
        ("app2.log", os.path.expanduser("~/logs/app2.log")),
        ("app1.log", "../logs/app1.log"),
        ("app2.log", "../logs/app2.log"),
        ("app1.log", "./logs/app1.log"),
        ("app2.log", "./logs/app2.log")
      ]
    
    log_lines = []
    for name, path in log_paths:
        if os.path.exists(path):
            try:
                with open(path, "r") as f:
                    lines = f.readlines()[-20:]  # Read last 20 lines
                    for line in lines:
                        log_lines.append({
                            "app": name,
                            "content": line.strip(),
                            "time": time.time()
                        })
            except Exception as e:
                log_lines.append({
                    "app": name,
                    "content": f"Error reading {name}: {str(e)}",
                    "time": time.time()
                })
    return jsonify({"logs": log_lines})

@app.route("/api/health")
def health():
    return jsonify({"status": "ok"})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
