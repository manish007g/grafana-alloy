# backend/app4_payment.py
import os
os.environ["OTEL_SERVICE_NAME"] = "payment-gateway"
os.environ["OTEL_RESOURCE_ATTRIBUTES"] = "service.version=1.0,deployment.environment=learning"

import time, random, structlog
from flask import Flask, jsonify, request
from prometheus_flask_exporter import PrometheusMetrics
from prometheus_client import Counter, Histogram
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.flask import FlaskInstrumentor

# --- Tracing setup ---
provider = TracerProvider()
provider.add_span_processor(BatchSpanProcessor(
    OTLPSpanExporter(endpoint="http://localhost:4317", insecure=True)
))
trace.set_tracer_provider(provider)
tracer = trace.get_tracer("payment-gateway")

# --- Structured logging ---
structlog.configure(processors=[structlog.processors.JSONRenderer()])
log = structlog.get_logger()

app = Flask(__name__)
metrics = PrometheusMetrics(app)
FlaskInstrumentor().instrument_app(
    app,
    excluded_urls="metrics,health"
)

# Custom Metrics
payments_processed = Counter("payments_processed_total", "Processed payments", ["status"])
payment_latency = Histogram("payment_processing_seconds", "Payment processor latency")

@app.route("/payment/process", methods=["POST"])
def process_payment():
    with tracer.start_as_current_span("payment.process") as span:
        data = request.get_json(silent=True) or {}
        email = data.get("email", "unknown@example.com")
        amount = data.get("amount", 0.0)
        
        span.set_attribute("payment.email", email)
        span.set_attribute("payment.amount", amount)
        
        # Simulate payment provider processing time
        latency = random.uniform(0.05, 0.25)
        time.sleep(latency)
        payment_latency.observe(latency)
        
        # Simulate a 3% checkout failure rate for diagnostics
        if random.random() < 0.03:
            payments_processed.labels(status="failed").inc()
            log.error("payment_declined", email=email, amount=amount, reason="insufficient_funds")
            return jsonify({"status": "declined", "error": "Insufficient funds"}), 400
            
        payments_processed.labels(status="success").inc()
        log.info("payment_authorized", email=email, amount=round(amount, 2))
        return jsonify({"status": "success", "transaction_id": f"tx-{random.randint(100000, 999999)}"})

@app.route("/health")
def health():
    return jsonify({"status": "ok"})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5002)
