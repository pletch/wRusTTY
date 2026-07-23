import { GlyphAtlas } from './GlyphAtlas'
import { parseCell, CELL_BYTES, CELL_INVERSE, type GhosttyWasm } from './wasmBindings'

const VERTEX_SHADER_SRC = `#version 300 es
layout(location = 0) in vec2 a_position; // (0,0) to (1,1)
layout(location = 1) in vec2 a_cellPos;  // (col, row)
layout(location = 2) in vec4 a_fgColor;  // (r,g,b,a)
layout(location = 3) in vec4 a_bgColor;  // (r,g,b,a)
layout(location = 4) in vec4 a_uv;       // (u0,v0, u1,v1)

uniform vec2 u_resolution; // (cols, rows)

out vec4 v_fgColor;
out vec4 v_bgColor;
out vec2 v_uv;

void main() {
    v_fgColor = a_fgColor / 255.0;
    v_bgColor = a_bgColor / 255.0;
    
    v_uv = mix(a_uv.xy, a_uv.zw, a_position);
    
    vec2 pos = a_cellPos + a_position;
    vec2 clip = (pos / u_resolution) * 2.0 - 1.0;
    clip.y = -clip.y; // top-left origin
    
    gl_Position = vec4(clip, 0.0, 1.0);
}
`

const FRAGMENT_SHADER_SRC = `#version 300 es
precision mediump float;

in vec4 v_fgColor;
in vec4 v_bgColor;
in vec2 v_uv;

uniform sampler2D u_atlas;

out vec4 outColor;

void main() {
    float alpha = texture(u_atlas, v_uv).a;
    outColor = mix(v_bgColor, v_fgColor, alpha);
}
`

/**
 * The one place cell metrics are derived. Both the renderer (which sizes the
 * canvas as `cols * cellWidth`) and the engine's fit (which derives cols from
 * the container) have to agree to the pixel: when they measured separately,
 * cols came from one width and the canvas from another, and nothing — not
 * re-fitting, not resizing the window — could reconcile them.
 */
export function measureCell(fontFamily: string, fontSize: number): { width: number; height: number } {
  const ctx = document.createElement('canvas').getContext('2d')!
  ctx.font = `${fontSize}px ${fontFamily}`
  return {
    width: Math.ceil(ctx.measureText('W').width),
    height: Math.ceil(fontSize * 1.2),
  }
}

function compileShader(gl: WebGL2RenderingContext, type: number, src: string) {
  const shader = gl.createShader(type)!
  gl.shaderSource(shader, src)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error(gl.getShaderInfoLog(shader))
    gl.deleteShader(shader)
    return null
  }
  return shader
}

export class WebGLRenderer {
  private canvas: HTMLCanvasElement
  private gl: WebGL2RenderingContext
  private atlas: GlyphAtlas
  private program: WebGLProgram
  
  private instanceBuffer: WebGLBuffer
  private vao: WebGLVertexArrayObject
  
  private cols: number
  private rows: number
  
  private defaultFgR = 200
  private defaultFgG = 200
  private defaultFgB = 200
  
  private cellWidth: number
  private cellHeight: number
  
  // Instance data buffer (floats):
  // cellPos.x, cellPos.y, fgR, fgG, fgB, fgA, bgR, bgG, bgB, bgA, u0, v0, u1, v1 (14 floats = 56 bytes per cell)
  private instanceData: Float32Array
  
  constructor(
    canvas: HTMLCanvasElement,
    cols: number,
    rows: number,
    fontFamily: string,
    fontSize: number
  ) {
    this.canvas = canvas
    this.cols = cols
    this.rows = rows
    
    // This renderer only repaints on damage, so an idle pane goes many frames
    // without a draw. WebGL formally leaves a composited buffer's contents
    // undefined unless it is preserved, so an idle pane is relying on behaviour
    // it isn't promised; preserving costs a copy per frame and makes the buffer
    // mean what it says. The alternative is redrawing every frame, which gives
    // up the zero-cost idle pane this loop is built around.
    this.gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      preserveDrawingBuffer: true,
    })!
    const gl = this.gl
    
    const { width: cellWidth, height: cellHeight } = measureCell(fontFamily, fontSize)
    this.cellWidth = cellWidth
    this.cellHeight = cellHeight
    
    const dpr = window.devicePixelRatio || 1
    canvas.width = cols * cellWidth * dpr
    canvas.height = rows * cellHeight * dpr
    canvas.style.width = `${cols * cellWidth}px`
    canvas.style.height = `${rows * cellHeight}px`
    gl.viewport(0, 0, canvas.width, canvas.height)
    
    this.atlas = new GlyphAtlas(gl, fontFamily, fontSize, cellWidth, cellHeight)
    
    const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SRC)!
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SRC)!
    this.program = gl.createProgram()!
    gl.attachShader(this.program, vs)
    gl.attachShader(this.program, fs)
    gl.linkProgram(this.program)
    
    gl.useProgram(this.program)
    
    const uRes = gl.getUniformLocation(this.program, 'u_resolution')
    gl.uniform2f(uRes, cols, rows)
    
    this.vao = gl.createVertexArray()!
    gl.bindVertexArray(this.vao)
    
    // Quad vertices
    const quadBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      0, 0,
      1, 0,
      0, 1,
      0, 1,
      1, 0,
      1, 1
    ]), gl.STATIC_DRAW)
    
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    
    // Instance buffer
    this.instanceBuffer = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer)
    
    this.instanceData = new Float32Array(cols * rows * 14)
    gl.bufferData(gl.ARRAY_BUFFER, this.instanceData, gl.DYNAMIC_DRAW)
    
    const stride = 14 * 4
    
    // a_cellPos
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 0)
    gl.vertexAttribDivisor(1, 1)
    
    // a_fgColor
    gl.enableVertexAttribArray(2)
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 2 * 4)
    gl.vertexAttribDivisor(2, 1)
    
    // a_bgColor
    gl.enableVertexAttribArray(3)
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 6 * 4)
    gl.vertexAttribDivisor(3, 1)
    
    // a_uv
    gl.enableVertexAttribArray(4)
    gl.vertexAttribPointer(4, 4, gl.FLOAT, false, stride, 10 * 4)
    gl.vertexAttribDivisor(4, 1)
  }
  
  private defaultBgR = 0
  private defaultBgG = 0
  private defaultBgB = 0
  
  setTheme(fr: number, fg: number, fb: number, br: number, bg: number, bb: number) {
    this.defaultFgR = fr
    this.defaultFgG = fg
    this.defaultFgB = fb
    this.defaultBgR = br
    this.defaultBgG = bg
    this.defaultBgB = bb
  }
  
  getCellSize(): { width: number, height: number } {
    return { width: this.cellWidth, height: this.cellHeight }
  }
  
  resize(cols: number, rows: number, force = false) {
    if (this.cols === cols && this.rows === rows && !force) return
    this.cols = cols
    this.rows = rows
    
    const dpr = window.devicePixelRatio || 1
    this.canvas.width = cols * this.cellWidth * dpr
    this.canvas.height = rows * this.cellHeight * dpr
    this.canvas.style.width = `${cols * this.cellWidth}px`
    this.canvas.style.height = `${rows * this.cellHeight}px`
    
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    
    this.gl.useProgram(this.program)
    const uRes = this.gl.getUniformLocation(this.program, 'u_resolution')
    this.gl.uniform2f(uRes, cols, rows)
    
    this.instanceData = new Float32Array(cols * rows * 14)
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.instanceBuffer)
    this.gl.bufferData(this.gl.ARRAY_BUFFER, this.instanceData, this.gl.DYNAMIC_DRAW)
  }
  
  updateStaticGrid(wasm: GhosttyWasm, termPtr: number) {
    const gl = this.gl
    const cols = this.cols
    const rows = this.rows
    const wasmCols = wasm.exports.ghostty_render_state_get_cols(termPtr)
    const wasmRows = wasm.exports.ghostty_render_state_get_rows(termPtr)

    // Sized from the WASM dimensions rather than ours, since a resize can land
    // on one side before the other.
    const cellCount = wasmCols * wasmRows
    const expectedBufSize = cellCount * CELL_BYTES
    const viewportBufPtr = wasm.exports.ghostty_wasm_alloc_u8_array(expectedBufSize)
    if (viewportBufPtr === 0) return

    new Uint8Array(wasm.exports.memory.buffer, viewportBufPtr, expectedBufSize).fill(0)

    // Takes a cell count, not a byte count.
    wasm.exports.ghostty_render_state_get_viewport(termPtr, viewportBufPtr, cellCount)

    const view = new DataView(wasm.exports.memory.buffer, viewportBufPtr, expectedBufSize)

    // The core has no runtime colour setter, so a pane that outlives a theme
    // change would otherwise keep painting default text in the palette it was
    // created with. Its current defaults are queryable and come back on cells
    // byte-for-byte, so cells still sitting on them can be mapped onto the live
    // theme. Explicitly-coloured text is left alone — remapping that would mean
    // guessing which palette slot it came from, which the resolved-RGB ABI
    // deliberately no longer tells us.
    const coreFg = wasm.exports.ghostty_render_state_get_fg_color(termPtr)
    const coreFgR = (coreFg >> 16) & 0xff, coreFgG = (coreFg >> 8) & 0xff, coreFgB = coreFg & 0xff
    const coreBg = wasm.exports.ghostty_render_state_get_bg_color(termPtr)
    const coreBgR = (coreBg >> 16) & 0xff, coreBgG = (coreBg >> 8) & 0xff, coreBgB = coreBg & 0xff

    let outIdx = 0

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let codepoint = 0
        let flags = 0
        // Cells outside the core's grid (a resize we've seen but it hasn't)
        // fall back to the theme's own colors.
        let finalFgR = this.defaultFgR
        let finalFgG = this.defaultFgG
        let finalFgB = this.defaultFgB
        let finalBgR = this.defaultBgR
        let finalBgG = this.defaultBgG
        let finalBgB = this.defaultBgB

        if (r < wasmRows && c < wasmCols) {
          const cell = parseCell(view, (r * wasmCols + c) * CELL_BYTES)
          codepoint = cell.codepoint
          flags = cell.flags
          // Already resolved to RGB by the core against the palette and
          // defaults it was configured with, so the only substitution left is
          // pulling default-coloured cells onto the current theme.
          if (cell.fgR === coreFgR && cell.fgG === coreFgG && cell.fgB === coreFgB) {
            finalFgR = this.defaultFgR; finalFgG = this.defaultFgG; finalFgB = this.defaultFgB
          } else {
            finalFgR = cell.fgR; finalFgG = cell.fgG; finalFgB = cell.fgB
          }
          if (cell.bgR === coreBgR && cell.bgG === coreBgG && cell.bgB === coreBgB) {
            finalBgR = this.defaultBgR; finalBgG = this.defaultBgG; finalBgB = this.defaultBgB
          } else {
            finalBgR = cell.bgR; finalBgG = cell.bgG; finalBgB = cell.bgB
          }
        }

        let u0 = 0, v0 = 0, u1 = 0, v1 = 0
        if (codepoint > 0) {
          const rect = this.atlas.getGlyph(codepoint)
          u0 = rect.u0; v0 = rect.v0; u1 = rect.u1; v1 = rect.v1
        }

        if ((flags & CELL_INVERSE) !== 0) {
          const tempR = finalFgR, tempG = finalFgG, tempB = finalFgB
          finalFgR = finalBgR; finalFgG = finalBgG; finalFgB = finalBgB
          finalBgR = tempR; finalBgG = tempG; finalBgB = tempB
        }

        this.instanceData[outIdx++] = c
        this.instanceData[outIdx++] = r
        
        this.instanceData[outIdx++] = finalFgR
        this.instanceData[outIdx++] = finalFgG
        this.instanceData[outIdx++] = finalFgB
        this.instanceData[outIdx++] = 255
        
        this.instanceData[outIdx++] = finalBgR
        this.instanceData[outIdx++] = finalBgG
        this.instanceData[outIdx++] = finalBgB
        this.instanceData[outIdx++] = 255
        
        this.instanceData[outIdx++] = u0
        this.instanceData[outIdx++] = v0
        this.instanceData[outIdx++] = u1
        this.instanceData[outIdx++] = v1
      }
    }
    
    wasm.exports.ghostty_wasm_free_u8_array(viewportBufPtr, expectedBufSize)

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.instanceData)
    
    gl.clearColor(this.defaultBgR / 255, this.defaultBgG / 255, this.defaultBgB / 255, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    
    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)
    
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.atlas.texture)
    
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, cols * rows)
  }

  dispose() {
    this.atlas.dispose()
    this.gl.deleteProgram(this.program)
    this.gl.deleteBuffer(this.instanceBuffer)
    this.gl.deleteVertexArray(this.vao)
  }
}
