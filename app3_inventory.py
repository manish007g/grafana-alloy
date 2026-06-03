# backend/app3_inventory.py
import os
os.environ["OTEL_SERVICE_NAME"] = "inventory-service"
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

# --- Tracing setup ---
provider = TracerProvider()
provider.add_span_processor(BatchSpanProcessor(
    OTLPSpanExporter(endpoint="http://localhost:4317", insecure=True)
))
trace.set_tracer_provider(provider)
tracer = trace.get_tracer("inventory-service")

# --- Structured logging ---
structlog.configure(processors=[structlog.processors.JSONRenderer()])
log = structlog.get_logger()

app = Flask(__name__)
metrics = PrometheusMetrics(app)
FlaskInstrumentor().instrument_app(
    app,
    excluded_urls="metrics,health"
)

# Mock in-memory database of groceries
INVENTORY = {
    "organic-bananas": {"name": "Organic Bananas", "stock": 80, "price": 1.99, "category": "Produce"},
    "whole-milk": {"name": "Organic Whole Milk", "stock": 45, "price": 4.49, "category": "Dairy"},
    "fresh-sourdough": {"name": "Fresh Sourdough Bread", "stock": 20, "price": 3.99, "category": "Bakery"},
    "brown-eggs": {"name": "Free Range Brown Eggs", "stock": 35, "price": 4.99, "category": "Dairy"},
    "avocados": {"name": "Hass Avocados", "stock": 60, "price": 5.49, "category": "Produce"},
    "greek-yogurt": {"name": "Greek Yogurt", "stock": 25, "price": 3.89, "category": "Dairy"},
    "coffee-beans": {"name": "Premium Coffee Beans", "stock": 30, "price": 12.99, "category": "Pantry"},
    "dark-chocolate": {"name": "Dark Chocolate Bar", "stock": 50, "price": 2.99, "category": "Pantry"}
}

inventory_reservations = Counter("inventory_reservations_total", "Total stock reservations", ["product", "status"])

@app.route("/inventory/check", methods=["GET"])
def check_inventory():
    return jsonify(INVENTORY)

@app.route("/inventory/reserve", methods=["POST"])
def reserve_inventory():
    with tracer.start_as_current_span("inventory.reserve") as span:
        data = request.get_json(silent=True) or {}
        items = data.get("items", [])
        span.set_attribute("inventory.items_count", len(items))
        
        # Simulate DB latency
        latency = random.uniform(0.01, 0.04)
        time.sleep(latency)
        
        # Verify and deduct items
        reserved = []
        for item in items:
            name = item.get("name")
            qty = item.get("quantity", 1)
            
            # Find item
            matched_key = None
            for key, info in INVENTORY.items():
                if info["name"] == name:
                    matched_key = key
                    break
            
            if not matched_key:
                log.warning("inventory_item_not_found", name=name)
                return jsonify({"error": f"Item '{name}' not found in catalog"}), 400
                
            if INVENTORY[matched_key]["stock"] < qty:
                log.error("inventory_out_of_stock", name=name, stock=INVENTORY[matched_key]["stock"], requested=qty)
                inventory_reservations.labels(product=name, status="out_of_stock").inc()
                return jsonify({"error": f"Insufficient stock for {name}"}), 400
            
            # Deduct stock
            INVENTORY[matched_key]["stock"] -= qty
            reserved.append({"name": name, "quantity": qty, "remaining": INVENTORY[matched_key]["stock"]})
            inventory_reservations.labels(product=name, status="reserved").inc()
            log.info("inventory_reserved", name=name, quantity=qty, remaining=INVENTORY[matched_key]["stock"])

        return jsonify({"status": "reserved", "items": reserved})

@app.route("/health")
def health():
    return jsonify({"status": "ok"})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001)
