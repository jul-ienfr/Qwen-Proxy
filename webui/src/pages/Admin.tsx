import { useState, useEffect } from 'react'

interface HealthStatus {
  status: string
  uptime: number
  memory: { rss: number; heapUsed: number; heapTotal: number }
  browser: { connected: boolean }
  accounts: { total: number; active: number; onCooldown: number }
  proxyPool: { total: number; available: number; failed: number; untested: number }
  tlsPool: { total: number; alive: number; totalRequests: number }
  warmPool: { size: number; active: number }
}

interface ProxyEntry {
  url: string
  protocol: string
  host: string
  port: number
  status: string
  failCount: number
  activeRequests: number
  totalRequests: number
}

export default function Admin() {
  const [health, setHealth] = useState<HealthStatus | null>(null)
  const [proxies, setProxies] = useState<ProxyEntry[]>([])
  const [newProxy, setNewProxy] = useState('')
  const [activeTab, setActiveTab] = useState<'overview' | 'proxies' | 'accounts'>('overview')

  const fetchHealth = async () => {
    try {
      const res = await fetch('/health')
      const data = await res.json()
      setHealth(data)
    } catch (err) {
      console.error('Failed to fetch health:', err)
    }
  }

  const fetchProxies = async () => {
    try {
      const res = await fetch('/v1/proxy/status')
      const data = await res.json()
      setProxies(data.proxies || [])
    } catch (err) {
      console.error('Failed to fetch proxies:', err)
    }
  }

  useEffect(() => {
    fetchHealth()
    fetchProxies()
    const interval = setInterval(fetchHealth, 10000)
    return () => clearInterval(interval)
  }, [])

  const addProxy = async () => {
    if (!newProxy.trim()) return
    try {
      await fetch('/v1/proxy/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: newProxy }),
      })
      setNewProxy('')
      fetchProxies()
    } catch (err) {
      console.error('Failed to add proxy:', err)
    }
  }

  const removeProxy = async (host: string, port: number) => {
    try {
      await fetch('/v1/proxy', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host, port }),
      })
      fetchProxies()
    } catch (err) {
      console.error('Failed to remove proxy:', err)
    }
  }

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
  }

  return (
    <div className="p-6">
      <h2 className="text-2xl font-bold mb-6">⚙️ Admin Dashboard</h2>

      {/* Tabs */}
      <div className="flex gap-2 mb-6">
        {(['overview', 'proxies', 'accounts'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 rounded-lg ${
              activeTab === tab
                ? 'bg-primary-600 text-white'
                : 'bg-gray-800 text-gray-400 hover:text-gray-200'
            }`}
          >
            {tab === 'overview' && '📊 '}
            {tab === 'proxies' && '🌐 '}
            {tab === 'accounts' && '👤 '}
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* Overview Tab */}
      {activeTab === 'overview' && health && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <div className="glass-card">
            <h3 className="text-sm text-gray-400 mb-2">Status</h3>
            <p className={`text-2xl font-bold ${health.status === 'healthy' ? 'text-green-400' : 'text-yellow-400'}`}>
              {health.status}
            </p>
          </div>
          <div className="glass-card">
            <h3 className="text-sm text-gray-400 mb-2">Uptime</h3>
            <p className="text-2xl font-bold">
              {Math.floor(health.uptime / 3600)}h {Math.floor((health.uptime % 3600) / 60)}m
            </p>
          </div>
          <div className="glass-card">
            <h3 className="text-sm text-gray-400 mb-2">Memory</h3>
            <p className="text-2xl font-bold">{formatBytes(health.memory.heapUsed)}</p>
            <p className="text-xs text-gray-500">/ {formatBytes(health.memory.heapTotal)}</p>
          </div>
          <div className="glass-card">
            <h3 className="text-sm text-gray-400 mb-2">Accounts</h3>
            <p className="text-2xl font-bold">{health.accounts.active} active</p>
            <p className="text-xs text-gray-500">{health.accounts.onCooldown} on cooldown</p>
          </div>
          <div className="glass-card">
            <h3 className="text-sm text-gray-400 mb-2">Proxy Pool</h3>
            <p className="text-2xl font-bold">{health.proxyPool.available} available</p>
            <p className="text-xs text-gray-500">{health.proxyPool.total} total</p>
          </div>
          <div className="glass-card">
            <h3 className="text-sm text-gray-400 mb-2">TLS Pool</h3>
            <p className="text-2xl font-bold">{health.tlsPool.alive} alive</p>
            <p className="text-xs text-gray-500">{health.tlsPool.totalRequests} requests</p>
          </div>
        </div>
      )}

      {/* Proxies Tab */}
      {activeTab === 'proxies' && (
        <div>
          <div className="flex gap-2 mb-4">
            <input
              type="text"
              value={newProxy}
              onChange={e => setNewProxy(e.target.value)}
              placeholder="socks5://user:pass@host:port"
              className="flex-1 input-field"
            />
            <button onClick={addProxy} className="btn-primary">
              Add Proxy
            </button>
          </div>

          <div className="glass-card overflow-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left text-sm text-gray-400 border-b border-gray-800">
                  <th className="pb-3">URL</th>
                  <th className="pb-3">Status</th>
                  <th className="pb-3">Active</th>
                  <th className="pb-3">Total</th>
                  <th className="pb-3">Fails</th>
                  <th className="pb-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {proxies.map((proxy, i) => (
                  <tr key={i} className="border-b border-gray-800/50">
                    <td className="py-3 text-sm">{proxy.url}</td>
                    <td className="py-3">
                      <span className={`px-2 py-1 rounded text-xs ${
                        proxy.status === 'available' ? 'bg-green-900/50 text-green-400' :
                        proxy.status === 'failed' ? 'bg-red-900/50 text-red-400' :
                        'bg-yellow-900/50 text-yellow-400'
                      }`}>
                        {proxy.status}
                      </span>
                    </td>
                    <td className="py-3 text-sm">{proxy.activeRequests}</td>
                    <td className="py-3 text-sm">{proxy.totalRequests}</td>
                    <td className="py-3 text-sm">{proxy.failCount}</td>
                    <td className="py-3">
                      <button
                        onClick={() => removeProxy(proxy.host, proxy.port)}
                        className="text-red-400 hover:text-red-300 text-sm"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
                {proxies.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-gray-500">
                      No proxies configured
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Accounts Tab */}
      {activeTab === 'accounts' && (
        <div className="glass-card">
          <p className="text-gray-400">
            Account management is available via the CLI:
          </p>
          <pre className="mt-4 bg-gray-950 rounded-lg p-4 text-sm overflow-auto">
            <code>{`# Add account
npx qwenproxy login

# List accounts
npx qwenproxy login --list

# Remove account
npx qwenproxy login --remove <email>`}</code>
          </pre>
        </div>
      )}
    </div>
  )
}
