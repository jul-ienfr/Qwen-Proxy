/**
 * QwenDirectClient — Browser-Direct Mode Client
 *
 * Connects to the WebSocket signaling server for credentials,
 * then makes direct HTTPS requests to Qwen's API, bypassing
 * Node.js entirely for the data path.
 *
 * Architecture:
 *   Browser ←——— WebSocket Signaling ———→ Node.js (auth, headers)
 *   Browser ←———————————————————————————→ Qwen API (HTTPS direct)
 *
 * Expected improvement: Complete bypass of Node.js overhead.
 * TTFB: ~60ms (just TLS + first byte from Qwen)
 */

class QwenDirectClient {
  constructor(options = {}) {
    this.wsUrl = options.wsUrl || `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/signaling`;
    this.ws = null;
    this.authenticated = false;
    this.accountId = null;
    this.headers = null;
    this.headerExpiry = 0;
    this.pendingChats = new Map();
    this.pendingAuth = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 1000;

    // Transformer for Qwen → OpenAI format
    this.transformer = null;
  }

  /**
   * Connect to the signaling server.
   */
  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.onopen = () => {
        console.log('[DirectClient] Connected to signaling server');
        this.reconnectAttempts = 0;
        resolve();
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this.handleMessage(msg);
        } catch (err) {
          console.error('[DirectClient] Message parse error:', err);
        }
      };

      this.ws.onclose = () => {
        console.log('[DirectClient] Disconnected from signaling server');
        this.authenticated = false;
        this.scheduleReconnect();
      };

      this.ws.onerror = (err) => {
        console.error('[DirectClient] WebSocket error:', err);
        reject(err);
      };
    });
  }

  /**
   * Authenticate with the signaling server.
   */
  async authenticate(apiKey) {
    return new Promise((resolve, reject) => {
      this.pendingAuth = { resolve, reject };
      this.ws.send(JSON.stringify({ type: 'auth', apiKey }));
    });
  }

  /**
   * Make a chat completion request directly to Qwen.
   */
  async chat(request) {
    if (!this.authenticated || !this.headers) {
      throw new Error('Not authenticated. Call authenticate() first.');
    }

    // 1. Request a chat session from the signaling server
    const session = await this.requestChatSession(request.model);

    // 2. Build Qwen payload
    const payload = this.buildQwenPayload(request, session);

    // 3. Make direct HTTPS request to Qwen
    const response = await fetch(
      `${session.qwenEndpoint}?chat_id=${session.chatId}`,
      {
        method: 'POST',
        headers: {
          'accept': 'text/event-stream',
          'content-type': 'application/json',
          'cookie': session.headers.cookie,
          'origin': 'https://chat.qwen.ai',
          'referer': `https://chat.qwen.ai/c/${session.chatId}`,
          'user-agent': session.headers.userAgent,
          'bx-v': session.headers.bxV,
          'bx-ua': session.headers.bxUa,
          'bx-umidtoken': session.headers.bxUmidtoken,
          'x-request-id': crypto.randomUUID(),
          'timezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        },
        body: JSON.stringify(payload),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Qwen API error: ${response.status} - ${errorText}`);
    }

    // 4. Transform Qwen SSE → OpenAI format client-side
    const transformer = new QwenToOpenAITransformer(
      this.generateCompletionId(),
      request.model
    );

    const openaiStream = transformer.transform(response.body);

    // 5. Notify server that chat is done when stream completes
    openaiStream.getReader().closed.then(() => {
      this.ws.send(JSON.stringify({ type: 'chat:done', chatId: session.chatId }));
    });

    return openaiStream;
  }

  /**
   * Request a chat session from the signaling server.
   */
  requestChatSession(model) {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      this.pendingChats.set(requestId, { resolve, reject });

      this.ws.send(JSON.stringify({
        type: 'chat:request',
        model,
        requestId,
      }));

      // Timeout
      setTimeout(() => {
        if (this.pendingChats.has(requestId)) {
          this.pendingChats.delete(requestId);
          reject(new Error('Chat request timed out'));
        }
      }, 30000);
    });
  }

  /**
   * Build Qwen payload from OpenAI request format.
   */
  buildQwenPayload(request, session) {
    const timestamp = Math.floor(Date.now() / 1000);
    const model = (request.model || 'qwen-plus').replace('-no-thinking', '');

    // Convert OpenAI messages to Qwen format
    const messages = (request.messages || []).map((msg, idx) => ({
      fid: crypto.randomUUID(),
      parentId: idx === 0 ? null : undefined,
      childrenIds: [],
      role: msg.role,
      content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      user_action: 'chat',
      files: [],
      timestamp: timestamp + idx,
      models: [model],
      chat_type: 't2t',
      feature_config: {
        thinking_enabled: request.thinking !== false,
        output_schema: 'phase',
        research_mode: 'normal',
        auto_thinking: false,
        thinking_mode: 'Thinking',
        thinking_format: 'summary',
        auto_search: false,
      },
      extra: { meta: { subChatType: 't2t' } },
      sub_chat_type: 't2t',
      parent_id: idx === 0 ? null : undefined,
    }));

    return {
      stream: request.stream !== false,
      version: '2.1',
      incremental_output: true,
      chat_id: session.chatId,
      chat_mode: 'normal',
      model,
      parent_id: null,
      messages,
      timestamp: timestamp + messages.length,
    };
  }

  /**
   * Handle incoming signaling messages.
   */
  handleMessage(msg) {
    switch (msg.type) {
      case 'welcome':
        console.log(`[DirectClient] Server welcome, version: ${msg.version}`);
        break;

      case 'auth:success':
        this.authenticated = true;
        this.accountId = msg.accountId;
        this.headerExpiry = msg.expiresAt;
        this.headers = msg.headers;
        if (this.pendingAuth) {
          this.pendingAuth.resolve(msg);
          this.pendingAuth = null;
        }
        console.log(`[DirectClient] Authenticated with account: ${msg.accountId}`);
        break;

      case 'headers:update':
        this.headers = msg.headers;
        this.headerExpiry = msg.expiresAt;
        console.log('[DirectClient] Headers refreshed');
        break;

      case 'chat:ready':
        const pending = this.pendingChats.get(msg.requestId);
        if (pending) {
          this.pendingChats.delete(msg.requestId);
          pending.resolve(msg);
        }
        break;

      case 'error':
        console.error(`[DirectClient] Server error: ${msg.code} - ${msg.message}`);
        if (this.pendingAuth) {
          this.pendingAuth.reject(new Error(msg.message));
          this.pendingAuth = null;
        }
        for (const [id, pending] of this.pendingChats) {
          pending.reject(new Error(msg.message));
          this.pendingChats.delete(id);
        }
        break;
    }
  }

  /**
   * Schedule reconnection attempt.
   */
  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[DirectClient] Max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    console.log(`[DirectClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    setTimeout(() => this.connect().catch(() => {}), delay);
  }

  /**
   * Generate a unique completion ID.
   */
  generateCompletionId() {
    return `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
  }

  /**
   * Disconnect from the signaling server.
   */
  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.authenticated = false;
  }
}

// Export
window.QwenDirectClient = QwenDirectClient;
