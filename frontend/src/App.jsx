import React, { useState, useEffect, useRef } from 'react';

export default function App() {
  const [catalog, setCatalog] = useState({});
  const [cart, setCart] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState('All');
  const [isCheckoutOpen, setIsCheckoutOpen] = useState(false);
  const [customer, setCustomer] = useState({ name: '', email: '', address: '' });
  const [autoLoadActive, setAutoLoadActive] = useState(false);
  const [grafanaUrl, setGrafanaUrl] = useState(() => {
    return localStorage.getItem('grafana_url') || 'https://your-org.grafana.net';
  });
  
  const [logs, setLogs] = useState([
    { app: 'system', content: 'Terminal connected. Multihop event logs will appear here.', time: Date.now() }
  ]);
  
  const [currentTrace, setCurrentTrace] = useState({
    traceId: 'N/A',
    spanId: '',
    header: '',
    action: 'None'
  });

  const [nodes, setNodes] = useState({
    browser: { status: '', time: '-' },
    gateway: { status: '', time: '-' },
    inventory: { status: '', time: '-' },
    payment: { status: '', time: '-' },
    worker: { status: '', time: '-' }
  });

  const terminalEndRef = useRef(null);

  // Fetch Inventory Catalog on Load
  const fetchInventory = async () => {
    try {
      const res = await fetch('/api/inventory');
      if (res.ok) {
        const data = await res.json();
        setCatalog(data);
      }
    } catch (err) {
      console.error('Failed to load inventory', err);
    }
  };

  useEffect(() => {
    fetchInventory();
  }, []);

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

  const resetFlowchart = () => {
    setNodes({
      browser: { status: '', time: '-' },
      gateway: { status: '', time: '-' },
      inventory: { status: '', time: '-' },
      payment: { status: '', time: '-' },
      worker: { status: '', time: '-' }
    });
  };

  const updateNode = (nodeName, status, latency) => {
    setNodes(prev => ({
      ...prev,
      [nodeName]: { status, time: latency }
    }));
  };

  // Fetch log lines
  const fetchLogs = async () => {
    try {
      const res = await fetch('/api/logs');
      if (res.ok) {
        const data = await res.json();
        if (data.logs && data.logs.length > 0) {
          setLogs(data.logs);
        }
      }
    } catch (err) {
      console.error('Failed to retrieve logs', err);
    }
  };

  useEffect(() => {
    fetchLogs();
    const interval = setInterval(fetchLogs, 3500);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (terminalEndRef.current) {
      terminalEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  // Cart Adjustments
  const addToCart = (name, price) => {
    setCart(prev => {
      const existing = prev.find(item => item.name === name);
      if (existing) {
        return prev.map(item => item.name === name ? { ...item, quantity: item.quantity + 1 } : item);
      } else {
        return [...prev, { name, price, quantity: 1 }];
      }
    });

    const ctx = generateTraceContext(`Add Item to Cart: ${name}`);
    resetFlowchart();
    updateNode('browser', 'success', '1ms');
    updateNode('gateway', 'success', '~4ms');
    
    // Fire background call to trigger endpoint (metrics track active carts)
    fetch('/api/cart/add', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'traceparent': ctx.header
      },
      body: JSON.stringify({ item: name })
    }).then(fetchLogs);
  };

  const removeFromCart = (name) => {
    setCart(prev => {
      const existing = prev.find(item => item.name === name);
      if (!existing) return prev;
      if (existing.quantity === 1) {
        return prev.filter(item => item.name !== name);
      }
      return prev.map(item => item.name === name ? { ...item, quantity: item.quantity - 1 } : item);
    });
  };

  const clearCart = async () => {
    setCart([]);
    const ctx = generateTraceContext('Clear Storefront Cart');
    resetFlowchart();
    updateNode('browser', 'success', '1ms');
    updateNode('gateway', 'success', '~3ms');

    await fetch('/api/cart/clear', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'traceparent': ctx.header
      }
    });
    fetchLogs();
  };

  // Checkout Placement
  const handleCheckoutSubmit = async (e) => {
    e.preventDefault();
    if (cart.length === 0) return;

    const totalPrice = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const itemsText = cart.map(i => `${i.name} (x${i.quantity})`).join(', ');

    const ctx = generateTraceContext(`Submit Checkout: ${itemsText}`);
    resetFlowchart();
    updateNode('browser', 'success', '1.5ms');
    updateNode('gateway', 'active', 'dispatching...');

    setIsCheckoutOpen(false);

    try {
      const res = await fetch('/api/order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'traceparent': ctx.header
        },
        body: JSON.stringify({
          items: cart.map(i => ({ name: i.name, quantity: i.quantity })),
          price: totalPrice,
          customer: customer
        })
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Checkout transaction failed');
      }

      const data = await res.json();
      
      // Update Span tree statuses representing microservice hops
      updateNode('gateway', 'success', '~22ms');
      
      const inventoryDelay = Math.floor(Math.random() * 15) + 10;
      updateNode('inventory', 'success', `${inventoryDelay}ms (App 3)`);
      
      const paymentDelay = Math.floor(Math.random() * 80) + 90;
      updateNode('payment', 'success', `${paymentDelay}ms (App 4)`);

      updateNode('worker', 'active', 'dispatched notification');

      setCart([]);
      fetchInventory(); // reload updated stock list

      setTimeout(() => {
        updateNode('worker', 'success', 'invoice mailed (Celery)');
        fetchLogs();
      }, 1500);

    } catch (err) {
      updateNode('gateway', 'failed', 'err');
      updateNode('inventory', 'failed', 'aborted');
      updateNode('payment', 'failed', 'declined');
      updateNode('worker', 'failed', 'aborted');
      alert(`Order Failed: ${err.message}`);
      fetchLogs();
    }
  };

  // Heavy Report async generator
  const triggerReport = async (e) => {
    e.preventDefault();
    const form = e.target;
    const input = form.elements['reportName'];
    const reportId = input.value.trim() || `Report-${Math.floor(Math.random() * 9000) + 1000}`;
    input.value = '';

    const ctx = generateTraceContext(`Generate heavy invoice report: ${reportId}`);
    resetFlowchart();
    updateNode('browser', 'success', '1ms');
    updateNode('gateway', 'active', 'enqueuing...');

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
        updateNode('gateway', 'success', '~10ms');
        updateNode('inventory', 'success', 'skipped (non-order path)');
        updateNode('payment', 'success', 'skipped (non-order path)');
        updateNode('worker', 'active', 'running async task...');

        setTimeout(() => {
          updateNode('worker', 'success', 'report completed');
          fetchLogs();
        }, 3000);
      } else {
        updateNode('gateway', 'failed', 'error');
      }
    } catch (err) {
      updateNode('gateway', 'failed', 'failed');
      updateNode('worker', 'failed', 'failed');
      fetchLogs();
    }
  };

  // Automatic load simulator loop
  useEffect(() => {
    if (!autoLoadActive) return;

    const runSim = () => {
      const actions = ['add', 'add', 'checkout', 'report'];
      const choice = actions[Math.floor(Math.random() * actions.length)];

      const itemKeys = Object.keys(catalog);
      if (itemKeys.length === 0) return;

      if (choice === 'add') {
        const randKey = itemKeys[Math.floor(Math.random() * itemKeys.length)];
        const product = catalog[randKey];
        if (product.stock > 0) {
          addToCart(product.name, product.price);
        }
      } else if (choice === 'checkout') {
        // Enforce adding a product if cart is empty
        if (cart.length === 0) {
          const randKey = itemKeys[Math.floor(Math.random() * itemKeys.length)];
          const product = catalog[randKey];
          addToCart(product.name, product.price);
          return;
        }

        const firstNames = ['John', 'Alice', 'Michael', 'Emily', 'Sarah'];
        const lastNames = ['Smith', 'Doe', 'Jones', 'Miller', 'Baker'];
        const domains = ['gmail.com', 'outlook.com', 'yahoo.com', 'example.com'];
        const fname = firstNames[Math.floor(Math.random() * firstNames.length)];
        const lname = lastNames[Math.floor(Math.random() * lastNames.length)];
        
        const customerData = {
          name: `${fname} ${lname}`,
          email: `${fname.toLowerCase()}.${lname.toLowerCase()}@${domains[Math.floor(Math.random() * domains.length)]}`,
          address: `${Math.floor(Math.random() * 800) + 100} Harvest Rd, Grocer City`
        };

        const totalPrice = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
        const itemsText = cart.map(i => `${i.name} (x${i.quantity})`).join(', ');

        const ctx = generateTraceContext(`Simulated Checkout: ${itemsText}`);
        resetFlowchart();
        updateNode('browser', 'success', '1ms');
        updateNode('gateway', 'active', 'submitting...');

        fetch('/api/order', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'traceparent': ctx.header
          },
          body: JSON.stringify({
            items: cart.map(i => ({ name: i.name, quantity: i.quantity })),
            price: totalPrice,
            customer: customerData
          })
        }).then(res => {
          if (res.ok) {
            updateNode('gateway', 'success', '~25ms');
            updateNode('inventory', 'success', '12ms (App 3)');
            updateNode('payment', 'success', '140ms (App 4)');
            updateNode('worker', 'active', 'mailing invoice...');
            setCart([]);
            fetchInventory();
            setTimeout(() => {
              updateNode('worker', 'success', 'sent (Celery)');
              fetchLogs();
            }, 1500);
          } else {
            updateNode('gateway', 'failed', 'checkout failed');
          }
        }).catch(() => {});

      } else if (choice === 'report') {
        const fakeReportId = `Auto-Report-${Math.floor(Math.random() * 9000) + 1000}`;
        const ctx = generateTraceContext(`Simulated Heavy Report: ${fakeReportId}`);
        resetFlowchart();
        updateNode('browser', 'success', '1ms');
        updateNode('gateway', 'active', 'enqueuing...');

        fetch('/api/report', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'traceparent': ctx.header
          },
          body: JSON.stringify({ report_id: fakeReportId })
        }).then(res => {
          if (res.ok) {
            updateNode('gateway', 'success', '~10ms');
            updateNode('inventory', 'success', 'skipped');
            updateNode('payment', 'success', 'skipped');
            updateNode('worker', 'active', 'processing async job...');
            setTimeout(() => {
              updateNode('worker', 'success', 'completed (Celery)');
              fetchLogs();
            }, 3000);
          }
        }).catch(() => {});
      }
    };

    const timer = setInterval(runSim, 4500);
    return () => clearInterval(timer);
  }, [autoLoadActive, catalog, cart]);

  // Catalog Filtration
  const catalogList = Object.values(catalog);
  const filteredProducts = catalogList.filter(product => {
    const matchesSearch = product.name.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCategory = activeCategory === 'All' || product.category === activeCategory;
    return matchesSearch && matchesCategory;
  });

  const cartTotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);

  return (
    <div className="container">
      {/* Header Panel */}
      <header>
        <div className="brand-section">
          <h1>🍎 FreshCart Micro-Services</h1>
          <p>Distributed Grocery Sandbox | Multi-Service Web Application</p>
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
        
        {/* Left Hand: Shop & Catalog */}
        <div className="store-section">
          
          <div className="glass-card primary-edge">
            <div className="card-header">
              <h2>🛒 Fresh Grocery Catalog</h2>
              <span style={{
                fontSize: '0.75rem',
                background: 'var(--primary-glow)',
                padding: '0.2rem 0.6rem',
                borderRadius: '20px',
                color: '#818cf8',
                border: '1px solid rgba(99,102,241,0.2)'
              }}>Telemetry Monitored</span>
            </div>

            {/* Filters */}
            <div className="catalog-controls">
              <input 
                type="text" 
                className="search-input" 
                placeholder="Search fresh groceries..." 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              <div className="category-tabs">
                {['All', 'Produce', 'Dairy', 'Bakery', 'Pantry'].map(cat => (
                  <button 
                    key={cat} 
                    className={`category-tab ${activeCategory === cat ? 'active' : ''}`}
                    onClick={() => setActiveCategory(cat)}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            </div>

            {/* Products Listing */}
            {catalogList.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
                Loading grocery items from Inventory service...
              </div>
            ) : (
              <div className="products-grid">
                {filteredProducts.map(product => {
                  const cartItem = cart.find(i => i.name === product.name);
                  const isOutOfStock = product.stock <= 0;
                  
                  return (
                    <div key={product.name} className="product-card">
                      {/* Stock indicator badge */}
                      <span className={`stock-badge ${isOutOfStock ? 'out-of-stock' : (product.stock < 15 ? 'low-stock' : 'in-stock')}`}>
                        {isOutOfStock ? 'Out of Stock' : `${product.stock} left`}
                      </span>

                      <div>
                        <div className="product-category-label">{product.category}</div>
                        <div className="product-name">{product.name}</div>
                      </div>

                      <div className="product-price-section">
                        <div className="product-price">${product.price.toFixed(2)}</div>
                        
                        {cartItem ? (
                          <div className="quantity-adjuster">
                            <button onClick={() => removeFromCart(product.name)}>-</button>
                            <span>{cartItem.quantity}</span>
                            <button 
                              onClick={() => addToCart(product.name, product.price)}
                              disabled={cartItem.quantity >= product.stock}
                            >+</button>
                          </div>
                        ) : (
                          <button 
                            className="btn btn-sm btn-secondary" 
                            onClick={() => addToCart(product.name, product.price)}
                            disabled={isOutOfStock}
                          >
                            Add to Cart
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Shopping Cart Bar */}
            <div className="cart-summary">
              <div className="cart-details">
                <div className="cart-count">Cart: {cart.length} unique item{cart.length !== 1 ? 's' : ''}</div>
                <div className="cart-total">Total: ${cartTotal.toFixed(2)}</div>
              </div>
              <div className="cart-actions">
                <button className="btn btn-danger btn-sm" onClick={clearCart} disabled={cart.length === 0}>Clear</button>
                <button 
                  className="btn btn-accent btn-sm" 
                  onClick={() => setIsCheckoutOpen(true)} 
                  disabled={cart.length === 0}
                >
                  Proceed to Checkout
                </button>
              </div>
            </div>
          </div>

          {/* Heavy Invoicing Job Generator */}
          <div className="glass-card accent-edge">
            <div className="card-header">
              <h2>⚙️ Invoice PDF Generator (Celery Worker)</h2>
              <span style={{
                fontSize: '0.75rem',
                background: 'var(--accent-glow)',
                padding: '0.2rem 0.6rem',
                borderRadius: '20px',
                color: '#34d399',
                border: '1px solid rgba(16,185,129,0.2)'
              }}>Async Task Queue</span>
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '0.75rem' }}>
              Submits async requests to build compiled PDF reports containing historical transactions via Redis/Celery queue.
            </p>
            <form onSubmit={triggerReport} className="report-form">
              <input 
                type="text" 
                name="reportName"
                placeholder="Enter Invoice Report ID (e.g. INV-904)"
              />
              <button type="submit" className="btn btn-accent btn-sm">Build Invoice PDF</button>
            </form>
          </div>

          {/* Automatic Simulator Toggle */}
          <div className="auto-loader-card">
            <div className="loader-info">
              <h3>🚀 Automatic Store Simulator</h3>
              <p>Simulates customer search, cart adjustments, payments, and invoice creation to populate traces.</p>
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

        {/* Right Hand: Observability Console */}
        <div className="observability-section">
          
          <div className="glass-card diagnostics-panel primary-edge">
            <div className="card-header">
              <h2>👁️ Distributed Trace Diagnostics</h2>
            </div>

            <div className="diagnostic-row">
              <label>Last Event Action</label>
              <div className="diagnostic-val" style={{ color: '#FFF', fontWeight: 600 }}>{currentTrace.action}</div>
            </div>

            <div className="diagnostic-row">
              <label>W3C Correlation Trace ID</label>
              <div className="diagnostic-val">
                <span style={{ color: 'var(--primary)', letterSpacing: '0.5px' }}>{currentTrace.traceId}</span>
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
              background: 'rgba(99, 102, 241, 0.04)',
              borderColor: 'rgba(99, 102, 241, 0.2)',
              borderWidth: '1px',
              borderStyle: 'solid',
              padding: '0.6rem 1rem',
              borderRadius: '10px',
              marginBottom: '1rem'
            }}>
              <label style={{ fontSize: '0.7rem', fontWeight: 600, color: '#a5b4fc', textTransform: 'uppercase' }}>Grafana explore context</label>
              <div className="diagnostic-val" style={{ marginTop: '0.25rem' }}>
                <a 
                  href={getGrafanaExploreUrl()} 
                  target="_blank" 
                  rel="noopener noreferrer" 
                  className="btn btn-sm btn-secondary" 
                  style={{ width: '100%', borderColor: 'rgba(99,102,241,0.3)', background: 'rgba(99,102,241,0.1)' }}
                >
                  🔍 View Distributed Trace in Tempo
                </a>
              </div>
            </div>

            {/* Trace Visualizer Tree */}
            <div className="trace-visualizer">
              <h3>Active Span Hierarchy</h3>
              <div className="trace-flow">
                <div className={`trace-node ${nodes.browser.status}`}>
                  <span className="node-name">💻 Client (W3C Header Init)</span>
                  <span className="node-time">{nodes.browser.time}</span>
                </div>
                <div className={`trace-node ${nodes.gateway.status}`}>
                  <span className="node-name">🐍 Gateway (App 1: /api/order)</span>
                  <span className="node-time">{nodes.gateway.time}</span>
                </div>
                <div className={`trace-node ${nodes.inventory.status}`}>
                  <span className="node-name">📦 Inventory Service (App 3: reserve)</span>
                  <span className="node-time">{nodes.inventory.time}</span>
                </div>
                <div className={`trace-node ${nodes.payment.status}`}>
                  <span className="node-name">💳 Payment Gateway (App 4: process)</span>
                  <span className="node-time">{nodes.payment.time}</span>
                </div>
                <div className={`trace-node ${nodes.worker.status}`}>
                  <span className="node-name">👷 Celery Worker (App 2: process_email)</span>
                  <span className="node-time">{nodes.worker.time}</span>
                </div>
              </div>
            </div>

          </div>

        </div>

      </div>

      {/* Checkout Form Modal */}
      {isCheckoutOpen && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <h3>Secure Grocery Checkout</h3>
              <button className="close-modal-btn" onClick={() => setIsCheckoutOpen(false)}>&times;</button>
            </div>
            
            <form onSubmit={handleCheckoutSubmit}>
              <div className="form-group">
                <label>Customer Name</label>
                <input 
                  type="text" 
                  required
                  placeholder="Jane Doe" 
                  value={customer.name}
                  onChange={(e) => setCustomer(prev => ({ ...prev, name: e.target.value }))}
                />
              </div>

              <div className="form-group">
                <label>Email Address</label>
                <input 
                  type="email" 
                  required
                  placeholder="jane.doe@example.com" 
                  value={customer.email}
                  onChange={(e) => setCustomer(prev => ({ ...prev, email: e.target.value }))}
                />
              </div>

              <div className="form-group">
                <label>Delivery Address</label>
                <input 
                  type="text" 
                  required
                  placeholder="123 Fresh Ave, Grocery Village" 
                  value={customer.address}
                  onChange={(e) => setCustomer(prev => ({ ...prev, address: e.target.value }))}
                />
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Card Number</label>
                  <input 
                    type="text" 
                    required 
                    placeholder="4111 2222 3333 4444" 
                    maxLength="19"
                  />
                </div>
                <div className="form-group">
                  <label>Expiry / CVV</label>
                  <input 
                    type="text" 
                    required 
                    placeholder="12/28 - 999" 
                    maxLength="9"
                  />
                </div>
              </div>

              <div style={{ marginTop: '1rem', padding: '0.5rem', background: 'rgba(255,255,255,0.03)', borderRadius: '6px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' }}>
                  <span>Subtotal:</span>
                  <span>${cartTotal.toFixed(2)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', color: 'var(--accent)' }}>
                  <span>Delivery fee:</span>
                  <span>FREE</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, borderTop: '1px solid var(--border-subtle)', marginTop: '0.5rem', paddingTop: '0.5rem' }}>
                  <span>Order Total:</span>
                  <span>${cartTotal.toFixed(2)}</span>
                </div>
              </div>

              <div className="modal-footer">
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setIsCheckoutOpen(false)}>Cancel</button>
                <button type="submit" className="btn btn-accent btn-sm">Pay and Place Order</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Interleaved Console Terminal */}
      <div className="terminal-panel">
        <div className="terminal-header">
          <div className="terminal-title">
            <div className="terminal-dot"></div>
            <span>Interleaved Microservice Logs (Gateway, Worker, Inventory, Payment logs)</span>
          </div>
          <button className="btn btn-sm btn-secondary" onClick={fetchLogs}>🔄 Refresh Logs</button>
        </div>
        
        <div className="terminal-console">
          {logs.map((log, idx) => {
            let appName = 'system';
            let appClass = 'system';
            
            if (log.app === 'app1.log') {
              appName = 'gateway';
              appClass = 'app1';
            } else if (log.app === 'app2.log') {
              appName = 'worker';
              appClass = 'app2';
            } else if (log.app === 'app3.log') {
              appName = 'inventory';
              appClass = 'app3';
            } else if (log.app === 'app4.log') {
              appName = 'payment';
              appClass = 'app4';
            }
            
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
