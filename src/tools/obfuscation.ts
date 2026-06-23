/**
 * Tool Name Obfuscation - Bypasses Qwen's rejection of certain tool names
 *
 * Qwen upstream may reject tool names that look like system commands or
 * file operations. This module maps client tool names to safe aliases
 * before sending to Qwen, and maps them back in responses.
 *
 * Adapted from upstream Qwen-Proxy toolcall.js
 */

// ─── Outbound Map: Client name → Qwen-safe name ──────────────────────────────

const TOOL_ALIAS_OUT: Record<string, string> = {
  // File operations
  'Read': 'fs_open_file',
  'Write': 'fs_create_file',
  'Edit': 'fs_modify_file',
  'Glob': 'fs_find_files',
  'Grep': 'text_search',

  // Shell operations
  'Bash': 'shell_run',
  'PowerShell': 'ps_execute',

  // Agent operations
  'Agent': 'delegate_task',
  'TaskOutput': 'task_get_output',
  'TaskStop': 'task_stop',

  // Other
  'WebSearch': 'web_search',
  'WebFetch': 'web_fetch',
  'NotebookEdit': 'notebook_modify',
  'TodoWrite': 'todo_update',
  'CronCreate': 'schedule_create',
  'CronDelete': 'schedule_delete',
  'CronList': 'schedule_list',
  'SendMessage': 'message_send',
}

// ─── Inbound Map: Qwen name → Client name (auto-generated) ───────────────────

const TOOL_ALIAS_IN: Record<string, string> = Object.fromEntries(
  Object.entries(TOOL_ALIAS_OUT).map(([clientName, alias]) => [alias, clientName])
)

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Obfuscate a tool name before sending to Qwen
 * If the name is in the alias map, return the safe alias
 * Otherwise, return the original name
 */
export function obfuscateToolName(name: string): string {
  return TOOL_ALIAS_OUT[name] || name
}

/**
 * Deobfuscate a tool name received from Qwen
 * If the name is in the reverse alias map, return the original client name
 * Otherwise, return the original name
 *
 * Also handles backward compatibility: if name starts with "t_", strip the prefix
 * (for stale prompt caches from older versions)
 */
export function deobfuscateToolName(name: string): string {
  if (TOOL_ALIAS_IN[name]) {
    return TOOL_ALIAS_IN[name]
  }

  // Backward compatibility: strip t_ prefix
  if (name.startsWith('t_')) {
    return name.slice(2)
  }

  return name
}

/**
 * Get all outbound aliases (for debugging/logging)
 */
export function getToolAliases(): Record<string, string> {
  return { ...TOOL_ALIAS_OUT }
}
