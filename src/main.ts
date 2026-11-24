import { waitForEvenAppBridge, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { fetchState, isStaticBrowserMode, subscribeStateStream } from './api/client.js'
import { mountCompanionPanel } from './companion/panel.js'
import { PulseHudController } from './hud/controller.js'
import './styles.css'

declare global {
  interface Window {
    flutter_inappwebview?: {
      callHandler?: (...args: unknown[]) => Promise<unknown>
    }
    __pulseHud?: PulseHudController
  }
}

async function resolveEvenBridge(): Promise<EvenAppBridge | null> {
  if (isStaticBrowserMode() && typeof window.flutter_inappwebview?.callHandler !== 'function') {
    return null
  }
  try {
    const bridge = await Promise.race([
      waitForEvenAppBridge(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
    ])
    if (!bridge) return null
    if (typeof window.flutter_inappwebview?.callHandler !== 'function') {
      console.info('[PulseHUD] Running in standalone browser preview (no Even host WebView detected).')
      return null
    }
    return bridge
  } catch (err) {
    console.warn('[PulseHUD] Bridge unavailable, falling back to standalone preview:', err)
    return null
  }
}

async function bootstrap() {
  const appRoot = document.querySelector<HTMLDivElement>('#app')
  if (!appRoot) throw new Error('Missing #app root element')

  const [bridge, initialState] = await Promise.all([resolveEvenBridge(), fetchState()])
  const controller = new PulseHudController(bridge, initialState)
  window.__pulseHud = controller

  const unsubscribePanel = mountCompanionPanel(appRoot, controller)
  await controller.mount()

  const unsubscribeSse = subscribeStateStream((nextState) => {
    controller.setState(nextState)
  })

  window.addEventListener('beforeunload', () => {
    unsubscribeSse()
    unsubscribePanel()
    controller.destroy()
  })

  console.log(
    `[PulseHUD] Ready | bridge=${bridge ? 'even-g2' : isStaticBrowserMode() ? 'web-sim' : 'standalone'} | HL=${initialState.health.hyperliquid.status} | PM=${initialState.health.polymarket.status} | WATCH=${initialState.watchedWallet.status} | TG=${initialState.health.telegram.mode}`,
  )
}

void bootstrap().catch((err) => {
  console.error('[PulseHUD] Fatal bootstrap error:', err)
  const appRoot = document.querySelector<HTMLDivElement>('#app')
  if (appRoot) {
    appRoot.innerHTML = `<main style="padding:24px;color:#ff6b6b;font-family:monospace;">PulseHUD bootstrap failed: ${String(err)}</main>`
  }
})
