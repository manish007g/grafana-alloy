#!/bin/bash
source ~/observability-venv/bin/activate
cd ~

mkdir -p ~/logs

echo "Starting Node Exporter..."
pkill -f node_exporter 2>/dev/null
node_exporter --web.listen-address=":9100" > ~/logs/node_exporter.log 2>&1 &
echo "  Node Exporter PID: $!"

echo "Starting App1 - Ecommerce API Gateway..."
pkill -f app1_ecommerce.py 2>/dev/null
python3 ~/backend/app1_ecommerce.py > ~/logs/app1.log 2>&1 &
echo "  App1 PID: $!"

echo "Starting App3 - Inventory Service..."
pkill -f app3_inventory.py 2>/dev/null
python3 ~/backend/app3_inventory.py > ~/logs/app3.log 2>&1 &
echo "  App3 PID: $!"

echo "Starting App4 - Payment Gateway..."
pkill -f app4_payment.py 2>/dev/null
python3 ~/backend/app4_payment.py > ~/logs/app4.log 2>&1 &
echo "  App4 PID: $!"

echo "Starting Redis..."
sudo service redis start

echo "Starting App2 - Job Processor (Celery)..."
pkill -f "celery.*app2_worker" 2>/dev/null
sleep 1
cd ~/backend && celery -A app2_worker worker --loglevel=info > ~/logs/app2.log 2>&1 &
echo "  App2 Celery PID: $!"

echo "Starting Grafana Alloy..."
pkill -f "alloy run" 2>/dev/null
sleep 1
nohup alloy run ~/.config/alloy/config.alloy > ~/logs/alloy.log 2>&1 &
echo "  Alloy PID: $!"

echo ""
echo "Waiting for services to initialize..."
sleep 5

echo ""
echo "=== Service Status ==="
ps aux | grep -E "node_exporter|app1_ecommerce|app3_inventory|app4_payment|celery|alloy" | grep -v grep

echo ""
echo "=== Health Checks ==="
curl -s -o /dev/null -w "App1 Gateway (5000):   %{http_code}\n" http://localhost:5000/health
curl -s -o /dev/null -w "App3 Inventory (5001): %{http_code}\n" http://localhost:5001/health
curl -s -o /dev/null -w "App4 Payment (5002):   %{http_code}\n" http://localhost:5002/health
curl -s -o /dev/null -w "App1 Metrics:          %{http_code}\n" http://localhost:5000/metrics
curl -s -o /dev/null -w "Node Exporter:         %{http_code}\n" http://localhost:9100/metrics
redis-cli ping | xargs -I{} echo "Redis:                 {}"

echo ""
echo "=== Log tails ==="
echo "-- App1 --"
tail -3 ~/logs/app1.log
echo "-- App3 --"
tail -3 ~/logs/app3.log
echo "-- App4 --"
tail -3 ~/logs/app4.log
echo "-- App2 --"
tail -3 ~/logs/app2.log
echo "-- Alloy --"
tail -3 ~/logs/alloy.log

echo ""
echo "All services started!"