import { useState, useRef, useEffect } from 'react'
import { marked } from 'marked'

// Configure marked for markdown rendering
marked.setOptions({
  gfm: true,
  breaks: true,
})

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  model?: string
}

interface ChatSession {
  id: string
  messages: Message[]
  version: number
  versions: Message[][]
}

export default function Chat() {
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [model, setModel] = useState('qwen3.6-plus')
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const activeSession = sessions.find(s => s.id === activeSessionId)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [activeSession?.messages])

  const createSession = () => {
    const newSession: ChatSession = {
      id: `chat_${Date.now()}`,
      messages: [],
      version: 0,
      versions: [[]],
    }
    setSessions(prev => [newSession, ...prev])
    setActiveSessionId(newSession.id)
  }

  const sendMessage = async () => {
    if (!input.trim() || isLoading || !activeSessionId) return

    const userMessage: Message = {
      id: `msg_${Date.now()}`,
      role: 'user',
      content: input.trim(),
      timestamp: Date.now(),
    }

    // Add user message
    setSessions(prev =>
      prev.map(s =>
        s.id === activeSessionId
          ? { ...s, messages: [...s.messages, userMessage] }
          : s
      )
    )
    setInput('')
    setIsLoading(true)

    try {
      const response = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: activeSession?.messages
            .concat(userMessage)
            .map(m => ({ role: m.role, content: m.content })) || [
            { role: 'user', content: userMessage.content },
          ],
          stream: false,
        }),
      })

      const data = await response.json()
      const assistantContent = data.choices?.[0]?.message?.content || 'No response'

      const assistantMessage: Message = {
        id: `msg_${Date.now()}`,
        role: 'assistant',
        content: assistantContent,
        timestamp: Date.now(),
        model: data.model,
      }

      setSessions(prev =>
        prev.map(s =>
          s.id === activeSessionId
            ? {
                ...s,
                messages: [...s.messages, assistantMessage],
                version: s.version + 1,
                versions: [...s.versions, [...s.messages, assistantMessage]],
              }
            : s
        )
      )
    } catch (err) {
      console.error('Chat error:', err)
    } finally {
      setIsLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b border-gray-800 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h2 className="text-lg font-semibold">💬 Chat</h2>
          <button onClick={createSession} className="btn-primary text-sm">
            + New Chat
          </button>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-400">Model:</label>
          <select
            value={model}
            onChange={e => setModel(e.target.value)}
            className="input-field text-sm"
          >
            <option value="qwen3.6-plus">qwen3.6-plus</option>
            <option value="qwen-max">qwen-max</option>
            <option value="qwen-plus">qwen-plus</option>
            <option value="qwen-turbo">qwen-turbo</option>
          </select>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Session List */}
        <div className="w-48 border-r border-gray-800 overflow-auto p-2">
          {sessions.map(session => (
            <button
              key={session.id}
              onClick={() => setActiveSessionId(session.id)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm mb-1 transition-colors ${
                session.id === activeSessionId
                  ? 'bg-primary-600/20 text-primary-400'
                  : 'text-gray-400 hover:bg-gray-800'
              }`}
            >
              {session.messages[0]?.content.slice(0, 30) || 'New Chat'}
            </button>
          ))}
        </div>

        {/* Messages */}
        <div className="flex-1 flex flex-col">
          <div className="flex-1 overflow-auto p-4 space-y-4">
            {!activeSession && (
              <div className="text-center text-gray-500 mt-20">
                <p className="text-4xl mb-4">💬</p>
                <p>Start a new chat to begin</p>
              </div>
            )}

            {activeSession?.messages.map(msg => (
              <div
                key={msg.id}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-2xl rounded-xl px-4 py-3 ${
                    msg.role === 'user'
                      ? 'bg-primary-600 text-white'
                      : 'bg-gray-800 text-gray-100'
                  }`}
                >
                  {msg.role === 'assistant' ? (
                    <div
                      className="markdown-content prose prose-invert prose-sm"
                      dangerouslySetInnerHTML={{
                        __html: marked.parse(msg.content) as string,
                      }}
                    />
                  ) : (
                    <p className="whitespace-pre-wrap">{msg.content}</p>
                  )}
                  {msg.model && (
                    <p className="text-xs text-gray-400 mt-2">{msg.model}</p>
                  )}
                </div>
              </div>
            ))}

            {isLoading && (
              <div className="flex justify-start">
                <div className="bg-gray-800 rounded-xl px-4 py-3">
                  <div className="flex space-x-2">
                    <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" />
                    <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce delay-100" />
                    <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce delay-200" />
                  </div>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="p-4 border-t border-gray-800">
            <div className="flex gap-2">
              <textarea
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type a message..."
                className="flex-1 input-field resize-none"
                rows={2}
                disabled={isLoading || !activeSessionId}
              />
              <button
                onClick={sendMessage}
                disabled={isLoading || !input.trim() || !activeSessionId}
                className="btn-primary px-6"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
