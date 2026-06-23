import 'dotenv/config'
import fs from 'fs'
import path from 'path'

const isGuiMode = process.argv.includes('--gui') || process.env.GUI === 'true'

/**
 * Clean up corrupted storageState files at startup.
 * If cookies are all expired or the file is malformed, delete it
 * so Playwright creates a fresh context with auto-login.
 */
function cleanupCorruptedProfiles(): void {
  const profilesDir = path.resolve(process.cwd(), 'qwen_profiles');
  if (!fs.existsSync(profilesDir)) return;

  const now = Math.floor(Date.now() / 1000);
  let cleaned = 0;

  try {
    const files = fs.readdirSync(profilesDir).filter(f => f.endsWith('_state.json'));
    for (const file of files) {
      try {
        const filePath = path.join(profilesDir, file);
        const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const hasValidCookies = state.cookies?.some((c: any) => c.expires < 0 || c.expires > now);
        if (!hasValidCookies) {
          fs.unlinkSync(filePath);
          cleaned++;
        }
      } catch {
        // Malformed JSON — delete it
        try { fs.unlinkSync(path.join(profilesDir, file)); cleaned++; } catch {}
      }
    }
    if (cleaned > 0) {
      console.log(`[Startup] Cleaned ${cleaned} expired/corrupted storageState files`);
    }
  } catch {}
}

async function main() {
  cleanupCorruptedProfiles();

  if (isGuiMode) {
    // Import dynamique : tray-hook et webview ne sont chargés qu'en mode GUI
    const { startServerWithGui } = await import('./gui/index.js')
    await startServerWithGui()
  } else {
    const { startServer } = await import('./api/server.js')
    await startServer()
  }
}

main().catch(error => {
  console.error('Failed to start server:', error)
  process.exit(1)
})
