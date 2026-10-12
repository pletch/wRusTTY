/**
 * Whether the WebGL path is on the GPU. WebGL2 can resolve to a software
 * rasterizer (SwiftShader, WARP / "Microsoft Basic Render Driver", llvmpipe),
 * especially in WebView2 with a flaky driver or over remote desktop, and the
 * harness labels such results. A throwaway context suffices: all contexts in a
 * page share one device.
 */

const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic|warp|mesa offscreen/i

export interface GpuInfo {
  /** Whether a WebGL2 context could be created at all. */
  webgl2: boolean
  /** UNMASKED_VENDOR_WEBGL, or null if the debug extension was blocked. */
  vendor: string | null
  /** UNMASKED_RENDERER_WEBGL, the string we classify. */
  renderer: string | null
  /** True when the renderer string names a known software rasterizer. */
  software: boolean
  /** The GLSL/driver version string, for the record. */
  version: string | null
}

export function probeGpu(): GpuInfo {
  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null
  if (!gl) {
    return { webgl2: false, vendor: null, renderer: null, software: false, version: null }
  }

  const dbg = gl.getExtension('WEBGL_debug_renderer_info')
  const vendor = dbg ? (gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) as string) : null
  const renderer = dbg ? (gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) as string) : null
  const version = gl.getParameter(gl.VERSION) as string

  // Released immediately rather than on GC; the context ceiling is real.
  gl.getExtension('WEBGL_lose_context')?.loseContext()

  return {
    webgl2: true,
    vendor,
    renderer,
    software: renderer ? SOFTWARE_RENDERER.test(renderer) : false,
    version,
  }
}

/** One-line verdict for the harness banner. */
export function gpuVerdict(info: GpuInfo): { ok: boolean; text: string } {
  if (!info.webgl2) return { ok: false, text: 'WebGL2 unavailable — renderer cannot run on this display at all.' }
  if (info.software) {
    return { ok: false, text: `Software rasterizer (${info.renderer}) — GPU is NOT active. Numbers below do not represent GPU rendering.` }
  }
  if (!info.renderer) {
    return { ok: true, text: 'WebGL2 active; renderer string hidden by the browser, so hardware vs software is unconfirmed.' }
  }
  return { ok: true, text: `GPU active: ${info.renderer}` }
}
