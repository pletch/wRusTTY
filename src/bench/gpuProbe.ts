/**
 * "Is the WebGL path actually on the GPU?" — Phase 7's third checkbox.
 *
 * WebGL2 can quietly resolve to a software rasterizer (SwiftShader in Chromium,
 * WARP / "Microsoft Basic Render Driver" on Windows, llvmpipe on Linux),
 * especially inside WebView2 with a flaky driver or under remote desktop. A
 * throughput number measured on that path is real but meaningless as a "GPU
 * renderer" result, so the harness refuses to let it pass unlabelled.
 *
 * A throwaway context is enough: every WebGL2 context in a page shares the same
 * underlying device, so the renderer string a probe reads is the same one the
 * engines got.
 */

const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic|warp|mesa offscreen/i

export interface GpuInfo {
  /** Whether a WebGL2 context could be created at all. */
  webgl2: boolean
  /** UNMASKED_VENDOR_WEBGL, or null if the debug extension was blocked. */
  vendor: string | null
  /** UNMASKED_RENDERER_WEBGL — the string we classify. */
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

  // Release the probe context immediately rather than waiting on GC — the
  // context ceiling this whole engine dances around is real.
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
