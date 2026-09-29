type NavigatorExtras = Navigator & {
  userAgentData?: { platform?: string; mobile?: boolean; brands?: { brand: string }[] };
  deviceMemory?: number;
  connection?: { effectiveType?: string; rtt?: number; downlink?: number; saveData?: boolean };
};

export function browserContext(): Record<string, unknown> {
  const nav = navigator as NavigatorExtras;
  return {
    page: location.pathname,
    userAgent: nav.userAgent,
    platform: nav.userAgentData?.platform ?? nav.platform,
    mobile: nav.userAgentData?.mobile ?? null,
    brands: nav.userAgentData?.brands?.map((one) => one.brand) ?? null,
    languages: [...nav.languages],
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen: `${screen.width}x${screen.height}`,
    viewport: `${innerWidth}x${innerHeight}`,
    devicePixelRatio,
    orientation: screen.orientation?.type ?? null,
    pointer: matchMedia("(pointer: coarse)").matches ? "coarse" : "fine",
    hover: matchMedia("(hover: hover)").matches,
    touchPoints: nav.maxTouchPoints,
    standalone: matchMedia("(display-mode: standalone)").matches,
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    colorScheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    cores: nav.hardwareConcurrency ?? null,
    memoryGb: nav.deviceMemory ?? null,
    network: nav.connection
      ? {
          type: nav.connection.effectiveType ?? null,
          rttMs: nav.connection.rtt ?? null,
          downlinkMbps: nav.connection.downlink ?? null,
          saveData: nav.connection.saveData ?? null,
        }
      : null,
    webgl: webglContext(),
  };
}

/**
 * A throwaway canvas rather than the game's, so this works on any page. The
 * context is released at once because browsers cap how many can be open.
 */
function webglContext(): Record<string, unknown> | null {
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return null;
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const context = {
      renderer: gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER) as string,
      vendor: gl.getParameter(debug ? debug.UNMASKED_VENDOR_WEBGL : gl.VENDOR) as string,
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    };
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return context;
  } catch {
    return null;
  }
}
