import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom'
import Chat from './pages/Chat'
import Admin from './pages/Admin'
import Docs from './pages/Docs'

function App() {
  return (
    <BrowserRouter>
      <div className="flex h-screen">
        {/* Sidebar */}
        <nav className="w-64 bg-gray-900 border-r border-gray-800 flex flex-col">
          <div className="p-6 border-b border-gray-800">
            <h1 className="text-xl font-bold text-primary-400">🔮 QwenProxy</h1>
            <p className="text-xs text-gray-500 mt-1">v1.8.0</p>
          </div>

          <div className="flex-1 p-4 space-y-1">
            <NavLink
              to="/"
              className={({ isActive }) =>
                `nav-link ${isActive ? 'nav-link-active' : ''}`
              }
              end
            >
              💬 Chat
            </NavLink>
            <NavLink
              to="/admin"
              className={({ isActive }) =>
                `nav-link ${isActive ? 'nav-link-active' : ''}`
              }
            >
              ⚙️ Admin
            </NavLink>
            <NavLink
              to="/docs"
              className={({ isActive }) =>
                `nav-link ${isActive ? 'nav-link-active' : ''}`
              }
            >
              📚 API Docs
            </NavLink>
          </div>

          <div className="p-4 border-t border-gray-800">
            <a
              href="/health"
              target="_blank"
              className="text-xs text-gray-500 hover:text-gray-300"
            >
              ● Health Check
            </a>
          </div>
        </nav>

        {/* Main Content */}
        <main className="flex-1 overflow-auto">
          <Routes>
            <Route path="/" element={<Chat />} />
            <Route path="/admin" element={<Admin />} />
            <Route path="/docs" element={<Docs />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}

export default App
