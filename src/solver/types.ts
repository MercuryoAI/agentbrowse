export type BrowserFingerprint = {
  userAgent: string;
  viewport: { width: number; height: number };
  screen: { width: number; height: number; colorDepth: number };
  timezone: string;
  locale: string;
  platform: string;
  webglVendor: string;
  webglRenderer: string;
  hardwareConcurrency: number;
  deviceMemory: number;
  proxy?: ProxyConfig;
  createdAt: string;
};

export type ProxyConfig = {
  server: string;
  username?: string;
  password?: string;
};

export type ProxySetting = string | ProxyConfig;

export type ProfileInfo = {
  name: string;
  fingerprint: BrowserFingerprint;
  userDataDir: string;
  fingerprintPath: string;
};

export type SolverConfig = {
  defaults?: {
    headless?: boolean;
    proxy?: ProxySetting;
  };
};

export type CaptchaType = 'recaptcha-v2' | 'hcaptcha' | 'turnstile';

export type TurnstileVariant = 'standalone' | 'cloudflare-challenge';
export type TurnstileCaptureSource = 'render-hook' | 'api-shim' | 'dom-fallback';

export type DetectedCaptcha = {
  type: CaptchaType;
  siteKey: string;
  pageUrl: string;
  variant?: TurnstileVariant;
  captureSource?: TurnstileCaptureSource;
  challengeReady?: boolean;
  action?: string;
  cData?: string;
  chlPageData?: string;
  callbackId?: string;
  userAgent?: string;
};

export type LaunchOptions = {
  headless?: boolean;
  url?: string;
  cdpPort?: number;
  executablePath?: string;
  stealth?: boolean;
  windowSize?: {
    width: number;
    height: number;
  };
};
