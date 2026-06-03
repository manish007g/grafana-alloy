#!/bin/bash
# Exit on failure of any command
set -e

# Resolve directory paths
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

echo "=========================================================="
echo "🚀 Starting FreshCart Distributed E-Commerce Ecosystem"
echo "=========================================================="

# 1. Start all background services (Gateway, Inventory, Payment, Celery, Redis, Alloy)
echo "📦 Initializing backend microservices..."
cd "$DIR"
chmod +x ./start_observability.sh
./start_observability.sh

# 2. Run React frontend dev server
echo ""
echo "💻 Starting Frontend React (Vite) server..."
cd "$DIR/frontend"
npm run dev
