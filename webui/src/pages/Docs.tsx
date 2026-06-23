import { useState } from 'react'
import { marked } from 'marked'

type Protocol = 'openai' | 'anthropic' | 'gemini' | 'admin' | 'public'

const DOCS: Record<Protocol, { title: string; content: string }> = {
  openai: {
    title: 'OpenAI Compatible',
    content: `
## POST /v1/chat/completions

OpenAI-compatible chat completions endpoint.

### Request Body

\`\`\`json
{
  "model": "qwen3.6-plus",
  "messages": [
    { "role": "user", "content": "Hello!" }
  ],
  "stream": true,
  "temperature": 0.7
}
\`\`\`

### cURL Example

\`\`\`bash
curl -X POST http://localhost:3000/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{
    "model": "qwen3.6-plus",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
\`\`\`

### Model Suffixes

- \`-thinking\` — Enable chain-of-thought reasoning
- \`-search\` — Enable search-augmented generation
- \`-image\` — Image generation
- \`-video\` — Video generation
    `,
  },
  anthropic: {
    title: 'Anthropic Messages',
    content: `
## POST /v1/messages

Anthropic Messages API compatible endpoint.

### Request Body

\`\`\`json
{
  "model": "claude-3-opus-20240229",
  "max_tokens": 1024,
  "messages": [
    { "role": "user", "content": "Hello!" }
  ]
}
\`\`\`

### cURL Example

\`\`\`bash
curl -X POST http://localhost:3000/v1/messages \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{
    "model": "claude-3-opus-20240229",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
\`\`\`
    `,
  },
  gemini: {
    title: 'Google Gemini',
    content: `
## POST /v1beta/models/{model}:generateContent

Google Gemini API compatible endpoint.

### Request Body

\`\`\`json
{
  "contents": [
    { "role": "user", "parts": [{ "text": "Hello!" }] }
  ],
  "generationConfig": {
    "maxOutputTokens": 1024
  }
}
\`\`\`

### cURL Example

\`\`\`bash
curl -X POST http://localhost:3000/v1beta/models/gemini-pro:generateContent \\
  -H "Content-Type: application/json" \\
  -H "x-goog-api-key: YOUR_API_KEY" \\
  -d '{
    "contents": [{"role": "user", "parts": [{"text": "Hello!"}]}]
  }'
\`\`\`
    `,
  },
  admin: {
    title: 'Admin API',
    content: `
## Health Check

\`\`\`bash
curl http://localhost:3000/health
\`\`\`

## Metrics

\`\`\`bash
curl http://localhost:3000/metrics
\`\`\`

## Performance Stats

\`\`\`bash
curl http://localhost:3000/v1/performance
\`\`\`

## Proxy Management

\`\`\`bash
# List proxies
curl http://localhost:3000/api/proxy/status

# Add proxy
curl -X POST http://localhost:3000/api/proxy/add \\
  -H "Content-Type: application/json" \\
  -d '{"url": "socks5://user:pass@host:port"}'

# Remove proxy
curl -X DELETE http://localhost:3000/api/proxy \\
  -H "Content-Type: application/json" \\
  -d '{"host": "host", "port": 1080}'
\`\`\`

## Config Toggle

\`\`\`bash
# Get config
curl http://localhost:3000/v1/config

# Toggle fast stream proxy
curl -X PUT http://localhost:3000/v1/config/fastStreamProxy \\
  -H "Content-Type: application/json" \\
  -d '{"value": true}'
\`\`\`
    `,
  },
  public: {
    title: 'Public Endpoints',
    content: `
## GET /v1/models

List available models.

\`\`\`bash
curl http://localhost:3000/v1/models \\
  -H "Authorization: Bearer YOUR_API_KEY"
\`\`\`

## POST /v1/upload

Upload a file to Qwen's OSS storage.

\`\`\`bash
curl -X POST http://localhost:3000/v1/upload \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -F "file=@image.png"
\`\`\`

## POST /v1/images/generations

Generate an image from text prompt.

\`\`\`bash
curl -X POST http://localhost:3000/v1/images/generations \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{
    "prompt": "A sunset over mountains",
    "model": "wanx2.1-t2i-turbo-image",
    "size": "1024x1024"
  }'
\`\`\`

## POST /v1/videos

Generate a video from text prompt.

\`\`\`bash
curl -X POST http://localhost:3000/v1/videos \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{
    "prompt": "A cat playing with a ball",
    "model": "wanx2.1-t2v-turbo-video"
  }'
\`\`\`
    `,
  },
}

export default function Docs() {
  const [activeProtocol, setActiveProtocol] = useState<Protocol>('openai')

  return (
    <div className="p-6">
      <h2 className="text-2xl font-bold mb-6">📚 API Documentation</h2>

      {/* Protocol Tabs */}
      <div className="flex gap-2 mb-6">
        {(['openai', 'anthropic', 'gemini', 'admin', 'public'] as Protocol[]).map(protocol => (
          <button
            key={protocol}
            onClick={() => setActiveProtocol(protocol)}
            className={`px-4 py-2 rounded-lg ${
              activeProtocol === protocol
                ? 'bg-primary-600 text-white'
                : 'bg-gray-800 text-gray-400 hover:text-gray-200'
            }`}
          >
            {protocol === 'openai' && '🤖 '}
            {protocol === 'anthropic' && '🧠 '}
            {protocol === 'gemini' && '💎 '}
            {protocol === 'admin' && '⚙️ '}
            {protocol === 'public' && '🌐 '}
            {DOCS[protocol].title}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="glass-card">
        <div
          className="markdown-content prose prose-invert prose-sm max-w-none"
          dangerouslySetInnerHTML={{
            __html: marked.parse(DOCS[activeProtocol].content) as string,
          }}
        />
      </div>
    </div>
  )
}
