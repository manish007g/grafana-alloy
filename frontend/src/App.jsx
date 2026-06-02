import React, { useState, useEffect, useRef } from 'react';

export default function App() {
  const [cart, setCart] = useState([]);
  const [autoLoadActive, setAutoLoadActive] = useState(false);
  const [grafanaUrl, setGrafanaUrl] = useState(() => {
    return localStorage.getItem('grafana_url') || 'https://your-org.grafana.net';
  });
  const [logs, setLogs] = useState([
    { app: 'system', content: 'Terminal connected. Event logs will appear here.', time: Date.now() }
  ]);
  const [currentTrace, setCurrentTrace] = useState({
    traceId: 'N/A',
    spanId: '',
    header: '',
    action: 'None'
  });
  const [nodes, setNodes] = useState({
    browser: { status: '', time: '-' },
    api: { status: '', time: '-' },
    db: { status: '', time: '-' },
    worker: { status: '', time: '-' }
  });

  const terminalEndRef = useRef(null);

  // Sync Grafana URL to localStorage
  const handleGrafanaUrlChange = (e) => {
    const val = e.target.value.trim();
    setGrafanaUrl(val);
    localStorage.setItem('grafana_url', val);
  };

  // W3C Traceparent generation
  const generateTraceContext = (actionName) => {
    const hex = '0123456789abcdef';
    let traceId = '';
    for (let i = 0; i < 32; i++) {
      traceId += hex[Math.floor(Math.random() * 16)];
    }
    let spanId = '';
    for (let i = 0; i < 16; i++) {
      spanId += hex[Math.floor(Math.random() * 16)];
    }
    
    const context = {
      traceId,
      spanId,
      header: `00-${traceId}-${spanId}-01`,
      action: actionName
    };
    
    setCurrentTrace(context);
    return context;
  };

  // Get deep-link to Grafana Cloud explore Tempo UI
  const getGrafanaExploreUrl = () => {
    const baseUrl = grafanaUrl || 'https://your-org.grafana.net';
    const traceId = currentTrace.traceId || '';
    if (traceId === 'N/A') return '#';
    
    const exploreParam = [
      'now-1h',
      'now',
      'Tempo',
      { query: traceId },
      { mode: 'TraceQL' }
    ];
    return `${baseUrl}/explore?orgId=1&left=${encodeURIComponent(JSON.stringify(exploreParam))}`;
  };

  // Helpers to adjust visual flowchart statuses
  const resetFlowchart = () => {
    setNodes({
      browser: { status: '', time: '-' },
      api: { status: '', time: '-' },
      db: { status: '', time: '-' },
      worker: { status: '', time: '-' }
    });
  };

  const updateNode = (nodeName, status, latency) => {
    setNodes(prev => ({
      ...prev,
      [nodeName]: { status, time: latency }
    }));
  };

  // Fetch structured logs from backend
  const fetchLogs = async () => {
    try {
      const res = await fetch('/api/logs');
      if (res.ok) {
        const data = await res.json();
        if (data.logs && data.logs.length > 0) {
          // Sort logs chronologically
          const sorted = data.logs.sort((a, b) => a.time - b.time);
          setLogs(sorted);
        }
      }
    } catch (err) {
      console.error('Failed to retrieve logs', err);
    }
  };

  // Poll logs periodically
  useEffect(() => {
    fetchLogs();
    const interval = setInterval(fetchLogs, 3000);
    return () => clearInterval(interval);
  }, []);

  // Auto Scroll the log console to bottom when new logs arrive
  useEffect(() => {
    if (terminalEndRef.current) {
      terminalEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  // Handle Cart updates (triggers flask /api/cart/add)
  const addToCart = async (name, price) => {
    setCart(prev => [...prev, { name, price }]);

    const ctx = generateTraceContext(`Add to Cart: ${name}`);
    resetFlowchart();
    updateNode('browser', 'success', '1ms');
    updateNode('api', 'active', 'pending...');

    try {
      const res = await fetch('/api/cart/add', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'traceparent': ctx.header
        },
        body: JSON.stringify({ item: name })
      });
      if (res.ok) {
        updateNode('api', 'success', '~7ms');
        setTimeout(fetchLogs, 1000);
      } else {
        updateNode('api', 'failed', 'err');
      }
    } catch (err) {
      updateNode('api', 'failed', 'failed');
    }
  };

  const clearCart = async () => {
    setCart([]);

    const ctx = generateTraceContext('Clear Cart');
    resetFlowchart();
    updateNode('browser', 'success', '1ms');
    updateNode('api', 'active', 'pending...');

    try {
      const res = await fetch('/api/cart/clear', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'traceparent': ctx.header
        }
      });
      if (res.ok) {
        updateNode('api', 'success', '~5ms');
        setTimeout(fetchLogs, 1000);
      } else {
        updateNode('api', 'failed', 'err');
      }
    } catch (err) {
      updateNode('api', 'failed', 'failed');
    }
  };

  // Place Order flow (Distributed Trace Browser -> API -> DB -> Worker)
  const placeOrder = async () => {
    if (cart.length === 0) {
      alert('Add products to your cart before checking out!');
      return;
    }

    const itemsText = cart.map(i => i.name).join(', ');
    const totalPrice = cart.reduce((sum, item) => sum + item.price, 0);

    const ctx = generateTraceContext(`Checkout order (${cart.length} items)`);
    resetFlowchart();
    updateNode('browser', 'success', '2ms');
    updateNode('api', 'active', 'processing...');

    try {
      const res = await fetch('/api/order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'traceparent': ctx.header
        },
        body: JSON.stringify({
          product: itemsText,
          price: totalPrice
        })
      });

      if (!res.ok) throw new Error('Order creation failed');

      const data = await res.json();
      updateNode('api', 'success', '~14ms');
      
      // Represent standard simulated DB insert duration
      const dbDelay = Math.floor(Math.random() * 40) + 12;
      updateNode('db', 'success', `${dbDelay}ms`);

      updateNode('worker', 'active', 'dispatched');

      // Clear storefront cart
      setCart([]);

      // Celery task is dispatched - mark complete after short wait represent worker lifecycle
      setTimeout(() => {
        updateNode('worker', 'success', 'processed (Celery)');
        fetchLogs();
      }, 1500);

    } catch (err) {
      updateNode('api', 'failed', 'error');
      updateNode('db', 'failed', 'aborted');
      updateNode('worker', 'failed', 'aborted');
      setTimeout(fetchLogs, 1000);
    }
  };

  // Trigger Celery Heavy Report generator
  const triggerReport = async (e) => {
    e.preventDefault();
    const form = e.target;
    const input = form.elements['reportName'];
    const reportId = input.value.trim() || `Report-${Math.floor(Math.random() * 9000) + 1000}`;
    input.value = ''; // clear

    const ctx = generateTraceContext(`Dispatch heavy report: ${reportId}`);
    resetFlowchart();
    updateNode('browser', 'success', '1ms');
    updateNode('api', 'active', 'dispatching...');

    try {
      const res = await fetch('/api/report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'traceparent': ctx.header
        },
        body: JSON.stringify({ report_id: reportId })
      });
      if (res.ok) {
        updateNode('api', 'success', '~10ms');
        updateNode('db', 'success', 'skipped (non-order path)');
        updateNode('worker', 'active', 'running heavy job...');

        setTimeout(() => {
          updateNode('worker', 'success', 'completed (async task)');
          fetchLogs();
        }, 3000);
      } else {
        updateNode('api', 'failed', 'err');
      }
    } catch (err) {
      updateNode('api', 'failed', 'failed');
      updateNode('worker', 'failed', 'failed');
      setTimeout(fetchLogs, 1000);
    }
  };

  // Auto Load simulator loop
  useEffect(() => {
    if (!autoLoadActive) return;

    const runSim = () => {
      const actions = ['add', 'add', 'checkout', 'report'];
      const choice = actions[Math.floor(Math.random() * actions.length)];

      if (choice === 'add') {
        const goods = [
          { name: 'Cosmic Widget', price: 25.00 },
          { name: 'Quantum Doodad', price: 49.99 },
          { name: 'Hyperstellar Gizmo', price: 99.50 }
        ];
        const product = goods[Math.floor(Math.random() * goods.length)];
        addToCart(product.name, product.price);
      } else if (choice === 'checkout') {
        // Force add a product first if empty
        setCart(prev => {
          if (prev.length === 0) {
            return [{ name: 'Quantum Doodad', price: 49.99 }];
          }
          return prev;
        });
        // Wait briefly for state update to place order
        setTimeout(placeOrder, 100);
      } else if (choice === 'report') {
        const fakeReportId = `Auto-Report-${Math.floor(Math.random() * 9000) + 1000}`;
        const ctx = generateTraceContext(`Dispatch heavy report: ${fakeReportId}`);
        resetFlowchart();
        updateNode('browser', 'success', '1ms');
        updateNode('api', 'active', 'dispatching...');

        fetch('/api/report', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'traceparent': ctx.header
          },
          body: JSON.stringify({ report_id: fakeReportId })
        }).then(res => {
          if (res.ok) {
            updateNode('api', 'success', '~10ms');
            updateNode('db', 'success', 'skipped (non-order path)');
            updateNode('worker', 'active', 'running heavy job...');
            setTimeout(() => {
              updateNode('worker', 'success', 'completed (async task)');
              fetchLogs();
            }, 3000);
          }
        }).catch(() => {});
      }
    };

    const timer = setInterval(runSim, 4000);
    return () => clearInterval(timer);
  }, [autoLoadActive, cart]);

  return (
    <div className="container">
      {/* Header */}
      <header>
        <div className="brand-section">
          <h1>Symphony System Control</h1>
          <p>Observability Sandbox: React App + Celery Distributed stack</p>
        </div>
        
        <div className="config-card">
          <label htmlFor="grafana-url">Grafana URL</label>
          <input 
            type="text" 
            id="grafana-url" 
            placeholder="https://your-org.grafana.net" 
            value={grafanaUrl}
            onChange={handleGrafanaUrlChange}
          />
        </div>
      </header>

      {/* Grid Layout */}
      <div className="dashboard-grid">
        
        {/* Left Side: Store & Worker */}
        <div className="store-section">
          
          {/* Storefront simulator */}
          <div className="glass-card primary-edge">
            <div className="card-header">
              <h2>🛒 Premium Storefront Simulator</h2>
              <span style={{
                fontSize: '0.8rem',
                background: 'var(--primary-glow)',
                padding: '0.2rem 0.6rem',
                borderRadius: '20px',
                color: '#818cf8',
                border: '1px solid rgba(99,102,241,0.2)'
              }}>React Telemetry Active</span>
            </div>

            <div className="products-grid">
              <div className="product-card">
                <div>
                  <div className="product-name">Cosmic Widget</div>
                  <div className="product-desc">Essential orbit widget for localized spatial alignment.</div>
                </div>
                <div>
                  <div className="product-price">$25.00</div>
                  <button className="btn btn-sm btn-secondary" onClick={() => addToCart('Cosmic Widget', 25.00)}>Add to Cart</button>
                </div>
              </div>

              <div className="product-card">
                <div>
                  <div className="product-name">Quantum Doodad</div>
                  <div className="product-desc">Advanced multi-state processor with sub-atomic cores.</div>
                </div>
                <div>
                  <div className="product-price">$49.99</div>
                  <button className="btn btn-sm btn-secondary" onClick={() => addToCart('Quantum Doodad', 49.99)}>Add to Cart</button>
                </div>
              </div>

              <div className="product-card">
                <div>
                  <div className="product-name">Hyperstellar Gizmo</div>
                  <div className="product-desc">High-latency star navigation matrix with custom GPS.</div>
                </div>
                <div>
                  <div className="product-price">$99.50</div>
                  <button className="btn btn-sm btn-secondary" onClick={() => addToCart('Hyperstellar Gizmo', 99.50)}>Add to Cart</button>
                </div>
              </div>
            </div>

            {/* Shopping Cart Bar */}
            <div className="cart-summary">
              <div className="cart-details">
                <div className="cart-count">Cart: {cart.length} item{cart.length !== 1 ? 's' : ''}</div>
                <div className="cart-total">Total: ${cart.reduce((s, i) => s + i.price, 0).toFixed(2)}</div>
              </div>
              <div className="cart-actions">
                <button className="btn btn-danger btn-sm" onClick={clearCart} disabled={cart.length === 0}>Clear</button>
                <button className="btn btn-accent btn-sm" onClick={placeOrder} disabled={cart.length === 0}>Checkout / Place Order</button>
              </div>
            </div>
          </div>

          {/* Celery Background Jobs */}
          <div className="glass-card accent-edge">
            <div className="card-header">
              <h2>⚙️ Heavy Job Generator (Celery Worker)</h2>
              <span style={{
                fontSize: '0.8rem',
                background: 'var(--accent-glow)',
                padding: '0.2rem 0.6rem',
                borderRadius: '20px',
                color: '#34d399',
                border: '1px solid rgba(16,185,129,0.2)'
              }}>Async worker</span>
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginBottom: '1rem' }}>
              Triggers high-latency PDF report generation within the background Celery queue (`app2_worker.py`), executing complex data renders.
            </p>
            <form onSubmit={triggerReport} className="report-form">
              <input 
                type="text" 
                name="reportName"
                placeholder="Enter report ID (e.g. Q2-Financials)"
              />
              <button type="submit" className="btn btn-accent">Generate Heavy Report</button>
            </form>
          </div>

          {/* Automatic Simulator Toggle */}
          <div className="auto-loader-card">
            <div className="loader-info">
              <h3>🚀 Automatic Load Simulator</h3>
              <p>Fires storefront clicks and report builds randomly to populate telemetry logs and metrics.</p>
            </div>
            <label className="switch">
              <input 
                type="checkbox" 
                checked={autoLoadActive}
                onChange={(e) => setAutoLoadActive(e.target.checked)}
              />
              <span className="slider"></span>
            </label>
          </div>

        </div>

        {/* Right Side: Observability Center */}
        <div className="observability-section">
          
          <div className="glass-card diagnostics-panel primary-edge">
            <div className="card-header">
              <h2>👁️ Diagnostics Console</h2>
            </div>

            <div className="diagnostic-row">
              <label>Last Action Context</label>
              <div className="diagnostic-val" style={{ color: '#FFF', fontWeight: 600 }}>{currentTrace.action}</div>
            </div>

            <div className="diagnostic-row">
              <label>W3C Trace ID (Client Initiated)</label>
              <div className="diagnostic-val">
                <span style={{ color: 'var(--primary)' }}>{currentTrace.traceId}</span>
                <button 
                  className="copy-btn" 
                  onClick={() => {
                    if (currentTrace.traceId !== 'N/A') navigator.clipboard.writeText(currentTrace.traceId);
                  }}
                  title="Copy Trace ID"
                >📋</button>
              </div>
            </div>

            <div style={{
              background: 'rgba(99, 102, 241, 0.05)',
              borderColor: 'rgba(99, 102, 241, 0.25)',
              borderWidth: '1px',
              borderStyle: 'solid',
              padding: '0.75rem 1rem',
              borderRadius: '10px',
              marginBottom: '1rem'
            }}>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#a5b4fc', textTransform: 'uppercase' }}>Observability Stack deep link</label>
              <div className="diagnostic-val" style={{ marginTop: '0.25rem' }}>
                <a 
                  href={getGrafanaExploreUrl()} 
                  target="_blank" 
                  rel="noopener noreferrer" 
                  className="btn btn-sm btn-secondary" 
                  style={{ width: '100%', borderColor: 'rgba(99,102,241,0.4)', background: 'rgba(99,102,241,0.15)' }}
                >
                  🔍 Open in Grafana Cloud Tempo
                </a>
              </div>
            </div>

            {/* Trace Visualizer Timeline flowchart */}
            <div className="trace-visualizer">
              <h3>Active Distributed Span Tree</h3>
              <div className="trace-flow">
                <div className={`trace-node ${nodes.browser.status}`}>
                  <span className="node-name">💻 Browser (Trace Initiation)</span>
                  <span className="node-time">{nodes.browser.time}</span>
                </div>
                <div className={`trace-node ${nodes.api.status}`}>
                  <span className="node-name">🐍 Flask API (/api/order)</span>
                  <span className="node-time">{nodes.api.time}</span>
                </div>
                <div className={`trace-node ${nodes.db.status}`}>
                  <span className="node-name">🗄️ Database (Simulated Write)</span>
                  <span className="node-time">{nodes.db.time}</span>
                </div>
                <div className={`trace-node ${nodes.worker.status}`}>
                  <span className="node-name">👷 Celery Worker (process_email)</span>
                  <span className="node-time">{nodes.worker.time}</span>
                </div>
              </div>
            </div>

          </div>

        </div>

      </div>

      {/* Log Console Terminal */}
      <div className="terminal-panel">
        <div className="terminal-header">
          <div className="terminal-title">
            <div className="terminal-dot"></div>
            <span>Live System Log Terminal (app1.log & app2.log tail)</span>
          </div>
          <button className="btn btn-sm btn-secondary" onClick={fetchLogs}>🔄 Refresh Logs</button>
        </div>
        
        <div className="terminal-console">
          {logs.map((log, idx) => {
            const isApp1 = log.app === 'app1.log';
            const isSystem = log.app === 'system';
            const appName = isSystem ? 'system' : (isApp1 ? 'flask-api' : 'celery-worker');
            const appClass = isSystem ? 'system' : (isApp1 ? 'app1' : 'app2');
            
            return (
              <div key={idx} className="log-entry">
                <span className={`log-app ${appClass}`}>[{appName}]</span>
                <span className="log-text">{log.content}</span>
              </div>
            );
          })}
          <div ref={terminalEndRef} />
        </div>
      </div>

    </div>
  );
}
