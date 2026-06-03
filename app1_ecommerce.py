# backend/app1_ecommerce.py
# ── Must be first, before any other imports ──────────────
import os
os.environ["OTEL_SERVICE_NAME"] = "ecommerce-api"
os.environ["OTEL_RESOURCE_ATTRIBUTES"] = "service.version=1.0,deployment.environment=learning"

import time, random, structlog, requests
from flask import Flask, jsonify, request, g
from prometheus_flask_exporter import PrometheusMetrics
from prometheus_client import Counter, Histogram, Gauge
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.flask import FlaskInstrumentor
from opentelemetry.instrumentation.celery import CeleryInstrumentor
from opentelemetry.propagate import inject
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

# --- Middleware (Flask before/after requests) ---
@app.before_request
def start_timer():
    g.start_time = time.time()
    # Log incoming request metadata
    trace_id = trace.format_trace_id(trace.get_current_span().get_span_context().trace_id)
    log.info("incoming_request", path=request.path, method=request.method, trace_id=trace_id)

@app.after_request
def log_response(response):
    if hasattr(g, 'start_time'):
        elapsed = time.time() - g.start_time
        trace_id = trace.format_trace_id(trace.get_current_span().get_span_context().trace_id)
        log.info("request_completed", path=request.path, status=response.status_code, duration_seconds=round(elapsed, 4), trace_id=trace_id)
    return response

# --- API Routes ---

@app.route("/api/inventory", methods=["GET"])
def get_inventory():
    with tracer.start_as_current_span("gateway.get_inventory") as span:
        headers = {}
        inject(headers)  # Inject W3C Trace context
        try:
            res = requests.get("http://localhost:5001/inventory/check", headers=headers, timeout=2.0)
            if res.status_code == 200:
                return jsonify(res.json())
            return jsonify({"error": "Failed to fetch inventory from service"}), res.status_code
        except Exception as e:
            log.error("inventory_service_error", error=str(e))
            return jsonify({"error": "Inventory service unreachable"}), 503

@app.route("/api/order", methods=["POST"])
def create_order():
    with tracer.start_as_current_span("create_order") as span:
        data = request.get_json(silent=True) or {}
        items = data.get("items", [])
        customer = data.get("customer", {})
        
        email = customer.get("email", "unknown@example.com")
        name = customer.get("name", "Guest")
        address = customer.get("address", "N/A")
        
        product_summary = ", ".join([f"{item['name']} (x{item['quantity']})" for item in items])
        price = data.get("price", 0.0)

        span.set_attribute("order.product_summary", product_summary)
        span.set_attribute("order.value", price)
        span.set_attribute("order.customer_email", email)

        # 1. Call Inventory Service to reserve stock
        with tracer.start_as_current_span("gateway.call_inventory") as inv_span:
            headers = {}
            inject(headers)
            try:
                inv_res = requests.post(
                    "http://localhost:5001/inventory/reserve",
                    headers=headers,
                    json={"items": items},
                    timeout=2.0
                )
                if inv_res.status_code != 200:
                    error_msg = inv_res.json().get("error", "Inventory check failed")
                    orders_total.labels(status="failed_inventory", product="grocery").inc()
                    log.error("order_inventory_failed", reason=error_msg)
                    return jsonify({"error": error_msg}), inv_res.status_code
            except Exception as e:
                log.error("inventory_service_error", error=str(e))
                return jsonify({"error": "Inventory service unreachable during checkout"}), 503

        # 2. Call Payment Service to process charges
        with tracer.start_as_current_span("gateway.call_payment") as pay_span:
            headers = {}
            inject(headers)
            try:
                pay_res = requests.post(
                    "http://localhost:5002/payment/process",
                    headers=headers,
                    json={"email": email, "amount": price},
                    timeout=2.0
                )
                if pay_res.status_code != 200:
                    error_msg = pay_res.json().get("error", "Payment declined")
                    orders_total.labels(status="failed_payment", product="grocery").inc()
                    log.error("order_payment_failed", reason=error_msg)
                    return jsonify({"error": error_msg}), pay_res.status_code
                tx_id = pay_res.json().get("transaction_id", "N/A")
            except Exception as e:
                log.error("payment_service_error", error=str(e))
                return jsonify({"error": "Payment service unreachable during checkout"}), 503

        # 3. Simulate DB order record creation
        with tracer.start_as_current_span("db.insert_order"):
            latency = random.uniform(0.005, 0.04)
            time.sleep(latency)
            db_query_time.observe(latency)

        orders_total.labels(status="success", product="grocery").inc()
        order_value.observe(price)
        log.info("order_created", items=product_summary, price=round(price, 2), customer=name, email=email)

        # 4. Dispatch async notifications via Celery task
        task = celery_app.send_task(
            "app2_worker.process_email",
            kwargs={
                "email": email,
                "name": name,
                "items_summary": product_summary,
                "price": round(price, 2)
            }
        )

        return jsonify({
            "order_id": random.randint(1000, 9999), 
            "price": round(price, 2),
            "status": "success",
            "transaction_id": tx_id,
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

        task = celery_app.send_task("app2_worker.generate_report", kwargs={"report_id": report_id})

        log.info("report_requested", report_id=report_id, celery_task_id=task.id)
        return jsonify({
            "report_id": report_id,
            "status": "triggered",
            "celery_task_id": task.id
        })

@app.route("/api/logs")
def get_logs():
    log_paths = [
        ("app1.log", "../logs/app1.log"),
        ("app2.log", "../logs/app2.log"),
        ("app3.log", "../logs/app3.log"),
        ("app4.log", "../logs/app4.log"),
        ("app1.log", "./logs/app1.log"),
        ("app2.log", "./logs/app2.log"),
        ("app3.log", "./logs/app3.log"),
        ("app4.log", "./logs/app4.log"),
        ("app1.log", os.path.expanduser("~/logs/app1.log")),
        ("app2.log", os.path.expanduser("~/logs/app2.log")),
        ("app3.log", os.path.expanduser("~/logs/app3.log")),
        ("app4.log", os.path.expanduser("~/logs/app4.log"))
    ]
    
    log_lines = []
    seen_lines = set()
    for name, path in log_paths:
        if os.path.exists(path):
            try:
                with open(path, "r") as f:
                    lines = f.readlines()[-15:]  # Read last 15 lines of each file
                    for line in lines:
                        cleaned = line.strip()
                        unique_key = f"{name}-{cleaned}"
                        if cleaned and unique_key not in seen_lines:
                            seen_lines.add(unique_key)
                            log_lines.append({
                                "app": name,
                                "content": cleaned,
                                "time": os.path.getmtime(path)
                            })
            except Exception as e:
                log_lines.append({
                    "app": name,
                    "content": f"Error reading {name}: {str(e)}",
                    "time": time.time()
                })
    # Sort logs by execution/modification time so they interleave properly in the terminal console
    log_lines.sort(key=lambda x: x["time"])
    return jsonify({"logs": log_lines})

@app.route("/api/health")
def health():
    return jsonify({"status": "ok"})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
