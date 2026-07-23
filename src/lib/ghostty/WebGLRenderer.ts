import { GlyphAtlas } from './GlyphAtlas'
import { parseCell, type GhosttyWasm } from './wasmBindings'

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
    
    this.gl = canvas.getContext('webgl2', { antialias: false, alpha: false })!
    const gl = this.gl
    
    // Measure cell size
    const measureCtx = document.createElement('canvas').getContext('2d')!
    measureCtx.font = `${fontSize}px ${fontFamily}`
    const metrics = measureCtx.measureText('W')
    const cellWidth = Math.ceil(metrics.width)
    const cellHeight = Math.ceil(fontSize * 1.2) // simple approximation
    
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
    const wasmCols = wasm.exports.get_cols(termPtr)
    const wasmRows = wasm.exports.get_rows(termPtr)
    
    // Allocate a temporary buffer for this frame using WASM dimensions
    // because Ghostty might have clamped or delayed the resize!
    const expectedBufSize = wasmCols * wasmRows * 16
    const viewportBufPtr = wasm.exports.alloc_buffer(expectedBufSize)
    
    new Uint8Array(wasm.exports.memory.buffer, viewportBufPtr, expectedBufSize).fill(0)
    
    wasm.exports.get_viewport(termPtr, viewportBufPtr)
    
    const view = new DataView(wasm.exports.memory.buffer, viewportBufPtr, expectedBufSize)
    
    let outIdx = 0
    
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let codepoint = 0
        let hasFg = false, hasBg = false
        let fgR = 0, fgG = 0, fgB = 0
        let bgR = 0, bgG = 0, bgB = 0
        
        let flags = 0
        
        if (r < wasmRows && c < wasmCols) {
          const offset = (r * wasmCols + c) * 16
          const cell = parseCell(view, offset)
          codepoint = cell.codepoint
          hasFg = (cell.colorFlags & 1) !== 0
          hasBg = (cell.colorFlags & 2) !== 0
          fgR = cell.fgR; fgG = cell.fgG; fgB = cell.fgB;
          bgR = cell.bgR; bgG = cell.bgG; bgB = cell.bgB;
          flags = cell.flags
        }
        
        let u0 = 0, v0 = 0, u1 = 0, v1 = 0
        if (codepoint > 0) {
          const rect = this.atlas.getGlyph(codepoint)
          u0 = rect.u0; v0 = rect.v0; u1 = rect.u1; v1 = rect.v1
        }
        
        const isInverse = (flags & 32) !== 0
        
        let finalFgR = hasFg ? fgR : this.defaultFgR
        let finalFgG = hasFg ? fgG : this.defaultFgG
        let finalFgB = hasFg ? fgB : this.defaultFgB
        
        let finalBgR = hasBg ? bgR : this.defaultBgR
        let finalBgG = hasBg ? bgG : this.defaultBgG
        let finalBgB = hasBg ? bgB : this.defaultBgB
        
        if (isInverse) {
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
    
    wasm.exports.free_buffer(viewportBufPtr, expectedBufSize)
    
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
