import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor configuration.
 *
 * Native builds load the bundled dist/ assets via capacitor://localhost — NO
 * server.url. Remote-loading the full SPA from a production URL violates
 * App Review Guideline 2.5.2 / 4.7 and breaks on network loss.
 *
 * API calls to Vercel serverless functions route through
 * src/lib/api/baseUrl.ts#apiUrl(), which prefixes VITE_API_BASE_URL on
 * native. Supabase and Stripe SDK calls hit their own origins directly;
 * allowNavigation permits in-app browser navigation to those domains.
 */
const config: CapacitorConfig = {
  appId: 'app.fixup.main',
  appName: 'SaFix',
  webDir: 'dist',
  ios: {
    backgroundColor: '#F5F6FA',
  },
  android: {
    // Parity with iOS: the native window background behind the WebView while it
    // boots, so a slow first paint shows the app tint rather than black/white.
    backgroundColor: '#F5F6FA',
  },
  server: {
    allowNavigation: ['itdntawwuzqfwmcwnwjr.supabase.co', '*.stripe.com'],
  },
  plugins: {
    Keyboard: {
      resize: 'body',
      resizeOnFullScreen: true,
    },
    SplashScreen: {
      // Adaptive hide with a native backstop. AppBootstrap calls
      // SplashScreen.hide() the moment the app settles, so fast boots dismiss the
      // splash well before launchShowDuration — no more fixed 1.5 s wait. We keep
      // launchAutoHide:true so iOS ALSO force-hides at launchShowDuration
      // independent of JS — a backstop a JS timer cannot provide (it would never
      // run if the bundle failed to evaluate, leaving the splash stuck forever).
      // 3 s tolerates a slow boot without a premature blank frame while bounding
      // any stuck-splash failure.
      launchAutoHide: true,
      launchShowDuration: 3000,
      backgroundColor: '#ffffff',
    },
    StatusBar: {
      // Fullscreen: the WebView extends UNDER the status bar app-wide. Each
      // screen renders its own top via env(safe-area-inset-top), so there is
      // no dead grey OS bar. Per-route text style (Light on dark/immersive
      // surfaces, Dark on light screens) is owned by the single
      // StatusBarController — never flip overlay off elsewhere.
      overlaysWebView: true,
      style: 'DARK',
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};

export default config;
