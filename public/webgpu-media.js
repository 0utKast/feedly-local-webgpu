// ============================================================================
// Motor WebGPU + WGSL para Procesado y Compensación de Imágenes en Tarjetas
// ============================================================================
// Resuelve el problema de imágenes descompensadas, verticales, iconos pequeños
// o noticias sin imagen utilizando un único GPUDevice compartido y un shader WGSL
// que garantiza proporción 16:9 uniforme y estética sobria (blanco/negro/grises).

const CARD_SHADER_WGSL = /* wgsl */ `
struct CardUniforms {
  img_aspect    : f32,
  canvas_aspect : f32,
  has_image     : f32,
  tone_mode     : f32, // 0.0 = Editorial Suave, 1.0 = Original, 2.0 = Prensa Monocromo
  hover_mix     : f32,
  seed          : f32,
  _pad0         : f32,
  _pad1         : f32,
};

@group(0) @binding(0) var<uniform> u : CardUniforms;
@group(0) @binding(1) var texSampler : sampler;
@group(0) @binding(2) var imgTex     : texture_2d<f32>;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv        : vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vid : u32) -> VSOut {
  // Triángulo a pantalla completa sin buffers de vértices adicionales
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -3.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>( 3.0,  1.0)
  );
  let p = positions[vid];
  var out : VSOut;
  out.pos = vec4<f32>(p, 0.0, 1.0);
  out.uv = vec2<f32>((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);
  return out;
}

fn luma(c : vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

fn apply_editorial_tone(color : vec3<f32>, tone_mode : f32, hover : f32) -> vec3<f32> {
  let gray = vec3<f32>(luma(color));

  if (tone_mode > 1.5) {
    // Modo 2: Prensa Monocromo (escala de grises editorial con recupero parcial en hover)
    let contrasted = clamp((gray - 0.5) * 1.08 + 0.5, vec3<f32>(0.04), vec3<f32>(0.97));
    return mix(contrasted, color, hover * 0.65);
  }

  if (tone_mode < 0.5) {
    // Modo 0: Editorial Suave (doma colores chillones un 18% en reposo, 100% color en hover)
    let desat_amount = mix(0.18, 0.0, hover);
    let toned = mix(color, gray, desat_amount);
    // Evitar blancos o negros estridentes puros
    return clamp((toned - 0.5) * 0.96 + 0.5, vec3<f32>(0.05), vec3<f32>(0.98));
  }

  // Modo 1: Color Original
  return color;
}

// Patrón arquitectónico minimalista en blanco/gris piedra cuando la noticia no trae foto
fn procedural_editorial_placeholder(uv : vec2<f32>, aspect : f32, seed : f32) -> vec3<f32> {
  let p = vec2<f32>(uv.x * aspect, uv.y);

  // Fondo papel neutro muy limpio (#f4f5f7 -> #ebedf0)
  let base_top = vec3<f32>(0.965, 0.968, 0.975);
  let base_bot = vec3<f32>(0.925, 0.930, 0.940);
  var col = mix(base_top, base_bot, uv.y);

  // Retícula editorial sutil
  let grid_freq = 12.0 + floor(fract(seed * 0.173) * 6.0);
  let gx = abs(fract(p.x * grid_freq) - 0.5);
  let gy = abs(fract(p.y * grid_freq) - 0.5);
  let line_mask = smoothstep(0.485, 0.5, max(gx, gy));
  col = mix(col, vec3<f32>(0.86, 0.87, 0.89), line_mask * 0.55);

  // Composición geométrica discreta (estilo maqueta de periódico)
  let offset = fract(seed * 0.317) * 0.25;
  let circle_center = vec2<f32>(aspect * (0.38 + offset), 0.5);
  let d = length(p - circle_center);
  let ring = smoothstep(0.24, 0.236, d) - smoothstep(0.232, 0.228, d);
  col = mix(col, vec3<f32>(0.72, 0.74, 0.77), ring * 0.65);

  // Líneas tipográficas simuladas en el centro-izquierda
  let in_block_x = step(0.14 * aspect, p.x) * step(p.x, 0.62 * aspect);
  let bar1 = in_block_x * step(0.42, uv.y) * step(uv.y, 0.445);
  let bar2 = in_block_x * step(0.50, uv.y) * step(uv.y, 0.518) * step(p.x, 0.48 * aspect);
  let bar3 = in_block_x * step(0.56, uv.y) * step(uv.y, 0.578) * step(p.x, 0.54 * aspect);
  let bars = clamp(bar1 + bar2 + bar3, 0.0, 1.0);
  col = mix(col, vec3<f32>(0.78, 0.80, 0.83), bars * 0.7);

  // Marco interior fino
  let border_x = smoothstep(0.0, 0.004, uv.x) * smoothstep(0.0, 0.004, 1.0 - uv.x);
  let border_y = smoothstep(0.0, 0.007, uv.y) * smoothstep(0.0, 0.007, 1.0 - uv.y);
  let inner_frame = border_x * border_y;
  col = mix(vec3<f32>(0.88, 0.89, 0.91), col, inner_frame);

  return col;
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
  // Zoom óptico muy sutil al pasar el ratón (1.0 -> 1.022)
  let zoom = mix(1.0, 0.978, u.hover_mix);
  let uv = (in.uv - vec2<f32>(0.5, 0.5)) * zoom + vec2<f32>(0.5, 0.5);

  // Si no hay imagen, renderizar placeholder procedural en WGSL
  if (u.has_image < 0.5) {
    let placeholder = procedural_editorial_placeholder(uv, u.canvas_aspect, u.seed);
    return vec4<f32>(placeholder, 1.0);
  }

  let ratio = u.img_aspect / u.canvas_aspect;

  // Si la imagen es vertical, cuadrada o extremadamente panorámica (descompensada),
  // componemos un fondo ambiental desenfocado en gris/papel + la imagen centrada sin mutilar.
  let is_unbalanced = (u.img_aspect < 1.12) || (u.img_aspect > 2.65);

  if (!is_unbalanced) {
    // Encuadre cover 16:9 con sesgo óptico superior (0.40) para no cortar cabezas
    var cover_uv = uv;
    if (ratio > 1.0) {
      // Imagen más ancha que 16:9 -> recortar laterales centrados
      let scale = 1.0 / ratio;
      cover_uv.x = (uv.x - 0.5) * scale + 0.5;
    } else {
      // Imagen más alta que 16:9 -> recortar verticalmente priorizando tercio superior
      let scale = ratio;
      cover_uv.y = (uv.y - 0.40) * scale + 0.40;
    }
    cover_uv = clamp(cover_uv, vec2<f32>(0.001), vec2<f32>(0.999));
    let raw_color = textureSampleLevel(imgTex, texSampler, cover_uv, 0.0).rgb;
    let final_color = apply_editorial_tone(raw_color, u.tone_mode, u.hover_mix);
    return vec4<f32>(final_color, 1.0);
  } else {
    // Composición inteligente de doble capa en GPU para imágenes verticales o logos cuadrados
    // 1. Fondo ambiental desenfocado y suavizado a tono papel
    var bg_uv = (uv - vec2<f32>(0.5)) * vec2<f32>(0.65, 0.65) + vec2<f32>(0.5);
    var blur_acc = vec3<f32>(0.0);
    let step_uv = vec2<f32>(0.018, 0.028);
    blur_acc += textureSampleLevel(imgTex, texSampler, clamp(bg_uv + vec2<f32>(-step_uv.x, -step_uv.y), vec2<f32>(0.01), vec2<f32>(0.99)), 0.0).rgb;
    blur_acc += textureSampleLevel(imgTex, texSampler, clamp(bg_uv + vec2<f32>( 0.0,       -step_uv.y), vec2<f32>(0.01), vec2<f32>(0.99)), 0.0).rgb;
    blur_acc += textureSampleLevel(imgTex, texSampler, clamp(bg_uv + vec2<f32>( step_uv.x, -step_uv.y), vec2<f32>(0.01), vec2<f32>(0.99)), 0.0).rgb;
    blur_acc += textureSampleLevel(imgTex, texSampler, clamp(bg_uv + vec2<f32>(-step_uv.x,  0.0),       vec2<f32>(0.01), vec2<f32>(0.99)), 0.0).rgb;
    blur_acc += textureSampleLevel(imgTex, texSampler, clamp(bg_uv,                                    vec2<f32>(0.01), vec2<f32>(0.99)), 0.0).rgb;
    blur_acc += textureSampleLevel(imgTex, texSampler, clamp(bg_uv + vec2<f32>( step_uv.x,  0.0),       vec2<f32>(0.01), vec2<f32>(0.99)), 0.0).rgb;
    blur_acc += textureSampleLevel(imgTex, texSampler, clamp(bg_uv + vec2<f32>(-step_uv.x,  step_uv.y), vec2<f32>(0.01), vec2<f32>(0.99)), 0.0).rgb;
    blur_acc += textureSampleLevel(imgTex, texSampler, clamp(bg_uv + vec2<f32>( 0.0,        step_uv.y), vec2<f32>(0.01), vec2<f32>(0.99)), 0.0).rgb;
    blur_acc += textureSampleLevel(imgTex, texSampler, clamp(bg_uv + vec2<f32>( step_uv.x,  step_uv.y), vec2<f32>(0.01), vec2<f32>(0.99)), 0.0).rgb;
    let bg_raw = blur_acc / 9.0;
    let bg_gray = vec3<f32>(luma(bg_raw));
    // Fundir el fondo hacia un gris papel limpio (#f1f2f4) para que nunca sea estridente
    let bg_soft = mix(mix(bg_raw, bg_gray, 0.78), vec3<f32>(0.945, 0.948, 0.955), 0.58);

    // 2. Calcular caja interior contain
    var fg_uv = uv;
    var inside = false;
    if (ratio < 1.0) {
      // Imagen más estrecha (vertical/cuadrada)
      let half_w = 0.5 * ratio;
      if (uv.x >= (0.5 - half_w) && uv.x <= (0.5 + half_w)) {
        fg_uv.x = (uv.x - (0.5 - half_w)) / (2.0 * half_w);
        inside = true;
      }
    } else {
      // Imagen muy panorámica (> 2.65)
      let half_h = 0.5 / ratio;
      if (uv.y >= (0.5 - half_h) && uv.y <= (0.5 + half_h)) {
        fg_uv.y = (uv.y - (0.5 - half_h)) / (2.0 * half_h);
        inside = true;
      }
    }

    if (inside) {
      let fg_raw = textureSampleLevel(imgTex, texSampler, clamp(fg_uv, vec2<f32>(0.001), vec2<f32>(0.999)), 0.0).rgb;
      let fg_toned = apply_editorial_tone(fg_raw, u.tone_mode, u.hover_mix);
      // Sutil línea separadora de 1px en los bordes de la foto interior
      let edge_dist = min(min(fg_uv.x, 1.0 - fg_uv.x), min(fg_uv.y, 1.0 - fg_uv.y));
      let border_mix = smoothstep(0.0, 0.008, edge_dist);
      let bordered = mix(vec3<f32>(0.82, 0.83, 0.85), fg_toned, border_mix);
      return vec4<f32>(bordered, 1.0);
    }

    return vec4<f32>(bg_soft, 1.0);
  }
}
`;

export class WebGpuCardMediaEngine {
  constructor() {
    this.supported = false;
    this.device = null;
    this.pipeline = null;
    this.sampler = null;
    this.uniformBuffer = null;
    this.dummyTexture = null;
    this.renderCanvas = null;
    this.gpuContext = null;
    this.format = null;
    this.toneMode = 0; // 0 = Editorial Suave, 1 = Original, 2 = Prensa Monocromo
    this.bitmapCache = new Map();
    this.cardRegistry = new Map();
    this.width = 640;
    this.height = 360;
  }

  async init() {
    if (!navigator.gpu) {
      console.warn('WebGPU no disponible en este navegador; usando renderizado Canvas 2D de respaldo.');
      return false;
    }

    try {
      const adapter = await navigator.gpu.requestAdapter({
        powerPreference: 'high-performance'
      });
      if (!adapter) return false;

      this.device = await adapter.requestDevice();
      this.format = navigator.gpu.getPreferredCanvasFormat();

      this.renderCanvas = document.createElement('canvas');
      this.renderCanvas.width = this.width;
      this.renderCanvas.height = this.height;

      this.gpuContext = this.renderCanvas.getContext('webgpu');
      this.gpuContext.configure({
        device: this.device,
        format: this.format,
        alphaMode: 'opaque'
      });

      const shaderModule = this.device.createShaderModule({
        label: 'FeedlyLocalCardWGSL',
        code: CARD_SHADER_WGSL
      });

      this.pipeline = this.device.createRenderPipeline({
        label: 'FeedlyLocalCardPipeline',
        layout: 'auto',
        vertex: {
          module: shaderModule,
          entryPoint: 'vs_main'
        },
        fragment: {
          module: shaderModule,
          entryPoint: 'fs_main',
          targets: [{ format: this.format }]
        },
        primitive: {
          topology: 'triangle-list'
        }
      });

      this.sampler = this.device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge'
      });

      this.uniformBuffer = this.device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });

      this.dummyTexture = this.device.createTexture({
        size: [4, 4, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
      });

      this.supported = true;
      return true;
    } catch (err) {
      console.warn('Error inicializando WebGPU:', err);
      this.supported = false;
      return false;
    }
  }

  hashString(str) {
    let h = 2166136261;
    const s = String(str || 'feed');
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return Math.abs(h % 1000) / 10.0;
  }

  setToneMode(mode) {
    this.toneMode = Number(mode) || 0;
    for (const [canvasEl, meta] of this.cardRegistry.entries()) {
      if (canvasEl.isConnected) {
        this.renderToTargetCanvas(canvasEl, meta.bitmap, meta.seed, meta.hoverMix || 0);
      } else {
        this.cardRegistry.delete(canvasEl);
      }
    }
  }

  async loadBitmap(imageUrl) {
    if (!imageUrl || imageUrl === 'none') return null;
    if (this.bitmapCache.has(imageUrl)) {
      return this.bitmapCache.get(imageUrl);
    }

    const proxiedUrl = `/api/image-proxy?url=${encodeURIComponent(imageUrl)}`;
    try {
      const res = await fetch(proxiedUrl);
      if (!res.ok) return null;
      const blob = await res.blob();
      // Descartar iconos minúsculos (< 36px) que suelen ser trackers o favicons rotos
      const bitmap = await createImageBitmap(blob);
      if (bitmap.width < 36 || bitmap.height < 36) {
        bitmap.close();
        return null;
      }
      if (this.bitmapCache.size > 150) {
        const oldestKey = this.bitmapCache.keys().next().value;
        const oldBmp = this.bitmapCache.get(oldestKey);
        if (oldBmp && oldBmp.close) oldBmp.close();
        this.bitmapCache.delete(oldestKey);
      }
      this.bitmapCache.set(imageUrl, bitmap);
      return bitmap;
    } catch {
      return null;
    }
  }

  async attachCardCanvas(targetCanvas, imageUrl, seedSource) {
    const seed = this.hashString(seedSource);
    const meta = { imageUrl, seed, bitmap: null, hoverMix: 0 };
    this.cardRegistry.set(targetCanvas, meta);

    // 1. Pintar inmediatamente el placeholder editorial WGSL para que no haya parpadeo ni hueco vacío
    this.renderToTargetCanvas(targetCanvas, null, seed, 0);

    // 2. Si hay URL de imagen, cargarla y renderizarla con el shader WGSL de encuadre inteligente
    if (imageUrl && imageUrl !== 'none') {
      const bitmap = await this.loadBitmap(imageUrl);
      if (bitmap && targetCanvas.isConnected) {
        meta.bitmap = bitmap;
        this.renderToTargetCanvas(targetCanvas, bitmap, seed, meta.hoverMix);
      }
    }
  }

  setCardHover(targetCanvas, isHovered) {
    const meta = this.cardRegistry.get(targetCanvas);
    if (!meta) return;
    meta.hoverMix = isHovered ? 1.0 : 0.0;
    this.renderToTargetCanvas(targetCanvas, meta.bitmap, meta.seed, meta.hoverMix);
  }

  renderToTargetCanvas(targetCanvas, bitmap, seed, hoverMix = 0) {
    if (!this.supported || !this.device) {
      this.renderFallback2D(targetCanvas, bitmap);
      return;
    }

    let texture = this.dummyTexture;
    let imgAspect = 16 / 9;
    let hasImage = 0.0;

    if (bitmap) {
      hasImage = 1.0;
      imgAspect = bitmap.width / Math.max(1, bitmap.height);
      texture = this.device.createTexture({
        size: [bitmap.width, bitmap.height, 1],
        format: 'rgba8unorm',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT
      });
      this.device.queue.copyExternalImageToTexture(
        { source: bitmap },
        { texture },
        [bitmap.width, bitmap.height]
      );
    }

    const uniforms = new Float32Array([
      imgAspect,
      this.width / this.height,
      hasImage,
      this.toneMode,
      hoverMix,
      seed,
      0,
      0
    ]);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);

    const bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: texture.createView() }
      ]
    });

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.gpuContext.getCurrentTexture().createView(),
          loadOp: 'clear',
          clearValue: { r: 0.96, g: 0.96, b: 0.97, a: 1.0 },
          storeOp: 'store'
        }
      ]
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3, 1, 0, 0);
    pass.end();

    this.device.queue.submit([encoder.finish()]);

    // Copiar frame renderizado por WebGPU al canvas de la tarjeta
    const ctx2d = targetCanvas.getContext('2d');
    if (ctx2d) {
      ctx2d.drawImage(this.renderCanvas, 0, 0, targetCanvas.width, targetCanvas.height);
    }

    if (bitmap && texture !== this.dummyTexture) {
      texture.destroy();
    }
  }

  renderFallback2D(targetCanvas, bitmap) {
    const ctx = targetCanvas.getContext('2d');
    if (!ctx) return;
    const w = targetCanvas.width;
    const h = targetCanvas.height;

    ctx.fillStyle = '#f3f4f6';
    ctx.fillRect(0, 0, w, h);

    if (!bitmap) {
      ctx.strokeStyle = '#e5e7eb';
      ctx.lineWidth = 1;
      for (let x = 0; x < w; x += 32) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      return;
    }

    const imgRatio = bitmap.width / bitmap.height;
    const canvasRatio = w / h;
    let sx = 0, sy = 0, sw = bitmap.width, sh = bitmap.height;
    if (imgRatio > canvasRatio) {
      sw = bitmap.height * canvasRatio;
      sx = (bitmap.width - sw) * 0.5;
    } else {
      sh = bitmap.width / canvasRatio;
      sy = (bitmap.height - sh) * 0.35;
    }
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, w, h);
  }
}
