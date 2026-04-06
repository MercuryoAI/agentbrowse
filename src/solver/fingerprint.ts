import type { BrowserFingerprint, ProxyConfig } from './types.js';

type DevicePreset = {
  platform: string;
  userAgents: string[];
  webglVendors: string[];
  webglRenderers: string[];
  screens: Array<{ width: number; height: number }>;
};

const DEVICE_PRESETS: DevicePreset[] = [
  {
    platform: 'Win32',
    userAgents: [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    ],
    webglVendors: ['Google Inc. (NVIDIA)', 'Google Inc. (Intel)', 'Google Inc. (AMD)'],
    webglRenderers: [
      'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    ],
    screens: [
      { width: 1920, height: 1080 },
      { width: 2560, height: 1440 },
      { width: 1366, height: 768 },
    ],
  },
  {
    platform: 'MacIntel',
    userAgents: [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    ],
    webglVendors: ['Google Inc. (Apple)', 'Google Inc. (Intel)'],
    webglRenderers: [
      'ANGLE (Apple, Apple M1 Pro, OpenGL 4.1)',
      'ANGLE (Apple, Apple M2, OpenGL 4.1)',
      'ANGLE (Intel, Intel(R) Iris(TM) Plus Graphics 655, OpenGL 4.1)',
    ],
    screens: [
      { width: 1440, height: 900 },
      { width: 2560, height: 1600 },
      { width: 1680, height: 1050 },
    ],
  },
  {
    platform: 'Linux x86_64',
    userAgents: [
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    ],
    webglVendors: ['Google Inc. (NVIDIA)', 'Google Inc. (Mesa)'],
    webglRenderers: [
      'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650/PCIe/SSE2, OpenGL 4.5)',
      'ANGLE (Mesa, llvmpipe (LLVM 15.0.7, 256 bits), OpenGL 4.5)',
    ],
    screens: [
      { width: 1920, height: 1080 },
      { width: 2560, height: 1440 },
    ],
  },
];

const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Australia/Sydney',
];

const LOCALES = ['en-US', 'en-GB', 'de-DE', 'fr-FR', 'ja-JP', 'zh-CN', 'pt-BR', 'es-ES'];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export type FingerprintOptions = {
  platform?: string;
  timezone?: string;
  locale?: string;
  proxy?: ProxyConfig;
};

export function generateFingerprint(opts?: FingerprintOptions): BrowserFingerprint {
  const preset = opts?.platform
    ? (DEVICE_PRESETS.find((p) =>
        p.platform.toLowerCase().includes(opts.platform!.toLowerCase())
      ) ?? pick(DEVICE_PRESETS))
    : pick(DEVICE_PRESETS);

  const screen = pick(preset.screens);
  const viewportHeight = screen.height - randomInt(40, 100);

  return {
    userAgent: pick(preset.userAgents),
    viewport: { width: screen.width, height: viewportHeight },
    screen: { ...screen, colorDepth: 24 },
    timezone: opts?.timezone ?? pick(TIMEZONES),
    locale: opts?.locale ?? pick(LOCALES),
    platform: preset.platform,
    webglVendor: pick(preset.webglVendors),
    webglRenderer: pick(preset.webglRenderers),
    hardwareConcurrency: pick([4, 8, 12, 16]),
    deviceMemory: pick([4, 8, 16]),
    proxy: opts?.proxy,
    createdAt: new Date().toISOString(),
  };
}
