import { Hono } from 'hono'
import { config } from '../core/config.js'
import { getBasicHeaders } from '../services/playwright.js'
import { loadAccounts } from '../core/accounts.js'
import { getAccountCooldownInfo } from '../core/account-manager.js'
import { cache, type CacheKey } from '../cache/memory-cache.js'
import { syncModelContextWindows } from '../core/model-registry.js'

/** Raw model item as returned by the Qwen /api/models endpoint */
interface QwenApiModel {
  id: string
  name: string
  owned_by: string
  info?: {
    created_at?: number
    meta?: {
      max_context_length?: number
      capabilities?: string[]
    }
  }
}

/** A single model entry after formatting for the OpenAI-compatible /v1/models response */
interface FormattedModel {
  id: string
  name: string
  object: 'model'
  owned_by: string
  created: number
  context_window?: number
  capabilities?: string[]
}

/** The full formatted response returned by /v1/models */
interface FormattedModelsResponse {
  object: 'list'
  data: FormattedModel[]
}

// Auto-detect system timezone
const SYSTEM_TIMEZONE = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
})();

const app = new Hono()

app.get('/v1/models', async (c) => {
  try {
    let accountId: string | undefined
    try {
      const accounts = loadAccounts()
      const account = accounts.find(a => !getAccountCooldownInfo(a.id)) || accounts[0]
      if (account) {
        accountId = account.id
      }
    } catch (e) {
      console.warn('Failed to retrieve account for models endpoint:', e)
    }

    const cacheKey: CacheKey = `models:${accountId || 'global'}`
    const cached = await cache.get<FormattedModelsResponse>(cacheKey)
    if (cached) {
      return c.json(cached)
    }

    const { cookie, userAgent, bxV } = await getBasicHeaders(accountId)
    const response = await fetch(`${config.qwen.baseUrl}/api/models`, {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Connection': 'keep-alive',
        'Referer': `${config.qwen.baseUrl}/c/demo`,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'User-Agent': userAgent,
        'X-Request-Id': crypto.randomUUID(),
        'source': 'web',
        'bx-v': bxV,
        'sec-ch-ua': '"Chromium";v="137", "Google Chrome";v="137", "Not/A)Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Timezone': SYSTEM_TIMEZONE,
        'Cookie': cookie,
      },
    })
    
    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.status}`)
    }
    
    const data = await response.json()
    
    const models = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : []
    
    const formatted: FormattedModelsResponse = {
      object: 'list',
      data: models.flatMap((model: QwenApiModel) => [
        {
          id: model.id,
          name: model.name,
          object: 'model' as const,
          owned_by: model.owned_by,
          created: model.info?.created_at || Date.now(),
          context_window: model.info?.meta?.max_context_length,
          capabilities: model.info?.meta?.capabilities,
        },
        {
          id: `${model.id}-no-thinking`,
          name: `${model.name} (No Thinking)`,
          object: 'model' as const,
          owned_by: model.owned_by,
          created: model.info?.created_at || Date.now(),
          context_window: model.info?.meta?.max_context_length,
          capabilities: model.info?.meta?.capabilities,
        },
      ]),
    }

    syncModelContextWindows(formatted.data)
    await cache.set(cacheKey, formatted, 300)

    return c.json(formatted)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('Error fetching models:', error)
    return c.json({ error: message }, 500)
  }
})

app.get('/v1/models/:model', async (c) => {
  try {
    const modelId = c.req.param('model')

    let accountId: string | undefined
    try {
      const accounts = loadAccounts()
      const account = accounts.find(a => !getAccountCooldownInfo(a.id)) || accounts[0]
      if (account) {
        accountId = account.id
      }
    } catch (e) {
      console.warn('Failed to retrieve account for model endpoint:', e)
    }

    const cacheKey: CacheKey = `models:${accountId || 'global'}`
    const formattedList = await cache.get<FormattedModelsResponse>(cacheKey)
    let models = formattedList?.data || []

    if (models.length === 0) {
      const { cookie, userAgent, bxV } = await getBasicHeaders(accountId)
      const response = await fetch(`${config.qwen.baseUrl}/api/models`, {
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
          'Connection': 'keep-alive',
          'Referer': `${config.qwen.baseUrl}/c/demo`,
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
          'User-Agent': userAgent,
          'X-Request-Id': crypto.randomUUID(),
          'source': 'web',
          'bx-v': bxV,
          'sec-ch-ua': '"Chromium";v="137", "Google Chrome";v="137", "Not/A)Brand";v="99"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          'Timezone': SYSTEM_TIMEZONE,
          'Cookie': cookie,
        },
      })
      
      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.status}`)
      }
      
      const data = await response.json()
      const rawModels = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : []
      
      const formatted: FormattedModelsResponse = {
        object: 'list',
        data: rawModels.flatMap((model: QwenApiModel) => [
          {
            id: model.id,
            name: model.name,
            object: 'model' as const,
            owned_by: model.owned_by,
            created: model.info?.created_at || Date.now(),
            context_window: model.info?.meta?.max_context_length,
            capabilities: model.info?.meta?.capabilities,
          },
          {
            id: `${model.id}-no-thinking`,
            name: `${model.name} (No Thinking)`,
            object: 'model' as const,
            owned_by: model.owned_by,
            created: model.info?.created_at || Date.now(),
            context_window: model.info?.meta?.max_context_length,
            capabilities: model.info?.meta?.capabilities,
          },
        ]),
      }

      syncModelContextWindows(formatted.data)
      await cache.set(cacheKey, formatted, 300)
      models = formatted.data
    }

    const model = models.find((m: FormattedModel) => m.id === modelId)

    if (!model) {
      return c.json({ error: 'Model not found' }, 404)
    }

    return c.json(model)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('Error fetching model:', error)
    return c.json({ error: message }, 500)
  }
})

export { app }
