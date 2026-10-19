// ============================================================================
// Motor WebGPU + WGSL para Procesado y Compensación de Imágenes en Tarjetas
// ============================================================================
// Conecta con /api/article-image/:id (que resuelve imagen RSS, og:image o
// fotografía contextual única por titular) y procesa cada miniatura en GPU
// con proporción 16:9 uniforme y estética editorial limpia.

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
    let contrasted = clamp((gray - 0.5) * 1.08 + 0.5, vec3<f32>(0.04), vec3<f32>(0.97));
    return mix(contrasted, color, hover * 0.65);
  }

  if (tone_mode < 0.5) {
    let desat_amount = mix(0.16, 0.0, hover);
    let toned = mix(color, gray, desat_amount);
    return clamp((toned - 0.5) * 0.96 + 0.5, vec3<f32>(0.05), vec3<f32>(0.98));
  }

  return color;
}

// Fondo sutil mientras se descarga la fotografía real de la noticia
fn loading_shimmer_surface(uv : vec2<f32>, aspect : f32, seed : f32) -> vec3<f32> {
  let base_top = vec3<f32>(0.968, 0.970, 0.975);
  let base_bot = vec3<f32>(0.935, 0.938, 0.945);
  var col = mix(base_top, base_bot, uv.y);

  let angle = fract(seed * 0.137) * 3.14159;
  let dir = vec2<f32>(cos(angle), sin(angle));
  let wave = sin(dot(uv * vec2<f32>(aspect, 1.0), dir) * 9.0 + seed) * 0.5 + 0.5;
  col = mix(col, vec3<f32>(0.90, 0.91, 0.925), wave * 0.35);

  return col;
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
  let zoom = mix(1.0, 0.978, u.hover_mix);
  let uv = (in.uv - vec2<f32>(0.5, 0.5)) * zoom + vec2<f32>(0.5, 0.5);

  if (u.has_image < 0.5) {
    let surface = loading_shimmer_surface(uv, u.canvas_aspect, u.seed);
    return vec4<f32>(surface, 1.0);
  }

  let ratio = u.img_aspect / u.canvas_aspect;
  let is_unbalanced = (u.img_aspect < 1.12) || (u.img_aspect > 2.65);

  if (!is_unbalanced) {
    var cover_uv = uv;
    if (ratio > 1.0) {
      let scale = 1.0 / ratio;
      cover_uv.x = (uv.x - 0.5) * scale + 0.5;
    } else {
      let scale = ratio;
      cover_uv.y = (uv.y - 0.40) * scale + 0.40;
    }
    cover_uv = clamp(cover_uv, vec2<f32>(0.001), vec2<f32>(0.999));
    let raw_color = textureSampleLevel(imgTex, texSampler, cover_uv, 0.0).rgb;
    let final_color = apply_editorial_tone(raw_color, u.tone_mode, u.hover_mix);
    return vec4<f32>(final_color, 1.0);
  } else {
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
    let bg_soft = mix(mix(bg_raw, bg_gray, 0.78), vec3<f32>(0.945, 0.948, 0.955), 0.58);

    var fg_uv = uv;
    var inside = false;
    if (ratio < 1.0) {
      let half_w = 0.5 * ratio;
      if (uv.x >= (0.5 - half_w) && uv.x <= (0.5 + half_w)) {
        fg_uv.x = (uv.x - (0.5 - half_w)) / (2.0 * half_w);
        inside = true;
      }
    } else {
      let half_h = 0.5 / ratio;
      if (uv.y >= (0.5 - half_h) && uv.y <= (0.5 + half_h)) {
        fg_uv.y = (uv.y - (0.5 - half_h)) / (2.0 * half_h);
        inside = true;
      }
    }

    if (inside) {
      let fg_raw = textureSampleLevel(imgTex, texSampler, clamp(fg_uv, vec2<f32>(0.001), vec2<f32>(0.999)), 0.0).rgb;
      let fg_toned = apply_editorial_tone(fg_raw, u.tone_mode, u.hover_mix);
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
    this.toneMode = 0;
    this.bitmapCache = new Map();
    this.cardRegistry = new Map();
    this.width = 640;
    this.height = 360;

    // Cola de carga con IntersectionObserver para priorizar las tarjetas visibles en pantalla
    this.queue = [];
    this.activeLoads = 0;
    this.maxConcurrentLoads = 6;

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const canvas = entry.target;
            this.observer.unobserve(canvas);
            this.enqueueCanvasLoad(canvas);
          }
        }
      },
      { rootMargin: '320px 0px' }
    );
  }

  async init() {
    if (!navigator.gpu) {
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

  async loadArticleBitmap(articleId) {
    const cacheKey = `article_${articleId}`;
    if (this.bitmapCache.has(cacheKey)) {
      return this.bitmapCache.get(cacheKey);
    }

    try {
      const res = await fetch(`/api/article-image/${articleId}`);
      if (!res.ok) return null;
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob);
      if (bitmap.width < 32 || bitmap.height < 32) {
        bitmap.close();
        return null;
      }
      if (this.bitmapCache.size > 200) {
        const oldestKey = this.bitmapCache.keys().next().value;
        const oldBmp = this.bitmapCache.get(oldestKey);
        if (oldBmp && oldBmp.close) oldBmp.close();
        this.bitmapCache.delete(oldestKey);
      }
      this.bitmapCache.set(cacheKey, bitmap);
      return bitmap;
    } catch {
      return null;
    }
  }

  attachCardCanvas(targetCanvas, articleId, seedSource) {
    const seed = this.hashString(`${articleId}_${seedSource}`);
    const meta = { articleId, seed, bitmap: null, hoverMix: 0, loaded: false };
    this.cardRegistry.set(targetCanvas, meta);

    // Pintar superficie inicial suave mientras se descarga la fotografía real
    this.renderToTargetCanvas(targetCanvas, null, seed, 0);

    // Observar para cargar prioritariamente las tarjetas en el viewport
    this.observer.observe(targetCanvas);
  }

  enqueueCanvasLoad(targetCanvas) {
    this.queue.push(targetCanvas);
    this.drainQueue();
  }

  async drainQueue() {
    while (this.activeLoads < this.maxConcurrentLoads && this.queue.length > 0) {
      const canvas = this.queue.shift();
      if (!canvas || !canvas.isConnected) continue;
      const meta = this.cardRegistry.get(canvas);
      if (!meta || meta.loaded) continue;

      meta.loaded = true;
      this.activeLoads++;
      this.loadArticleBitmap(meta.articleId)
        .then((bitmap) => {
          if (bitmap && canvas.isConnected) {
            meta.bitmap = bitmap;
            this.renderToTargetCanvas(canvas, bitmap, meta.seed, meta.hoverMix);
          }
        })
        .finally(() => {
          this.activeLoads--;
          this.drainQueue();
        });
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
    if (!bitmap) return;

    const imgRatio = bitmap.width / bitmap.height;
    const canvasRatio = w / h;
    let sx = 0,
      sy = 0,
      sw = bitmap.width,
      sh = bitmap.height;
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
