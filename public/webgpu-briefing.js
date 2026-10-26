// ============================================================================
// Motor WebGPU + Compute & Fragment Shaders WGSL para Análisis de Clústeres
// ============================================================================
// 1. Compute Shader WGSL (@workgroup_size(64) con vec4<f32> SIMD) que calcula
//    en paralelo en la GPU la matriz de similitud coseno y energía de impacto
//    entre los vectores léxicos/semánticos de los clústeres de noticias.
// 2. Render Pipeline WGSL que dibuja en tiempo real el espectro visual de
//    intensidad informativa de los grandes temas del informe.

const CLUSTER_SIMILARITY_COMPUTE_WGSL = /* wgsl */ `
struct ComputeParams {
  num_clusters : u32,
  dim_vec4     : u32, // 64 dims = 16 bloques vec4<f32>
  _pad0        : u32,
  _pad1        : u32,
};

@group(0) @binding(0) var<uniform> params : ComputeParams;
@group(0) @binding(1) var<storage, read> vectors : array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> weights : array<f32>;
@group(0) @binding(3) var<storage, read_write> affinity_out : array<f32>;

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let idx = gid.x;
  let n = params.num_clusters;
  if (idx >= n * n) {
    return;
  }

  let row = idx / n;
  let col = idx % n;
  let stride = params.dim_vec4;

  var dot_acc : f32 = 0.0;
  var norm_a  : f32 = 0.0;
  var norm_b  : f32 = 0.0;

  let base_a = row * stride;
  let base_b = col * stride;

  for (var i : u32 = 0u; i < stride; i = i + 1u) {
    let va = vectors[base_a + i];
    let vb = vectors[base_b + i];
    dot_acc = dot_acc + dot(va, vb);
    norm_a = norm_a + dot(va, va);
    norm_b = norm_b + dot(vb, vb);
  }

  let denom = sqrt(max(norm_a * norm_b, 1e-6));
  let cosine = clamp(dot_acc / denom, 0.0, 1.0);
  let boost = sqrt(max(weights[row] * weights[col], 0.01));
  affinity_out[idx] = cosine * 0.7 + clamp(boost, 0.0, 1.0) * 0.3;
}
`;

const BRIEFING_RADAR_RENDER_WGSL = /* wgsl */ `
struct RadarUniforms {
  num_nodes : f32,
  aspect    : f32,
  hover_idx : f32,
  time_sec  : f32,
};

struct NodeData {
  // x: pos_x (0..1), y: pos_y (0..1), z: radius/impact (0..1), w: recency (0..1)
  meta : vec4<f32>,
};

@group(0) @binding(0) var<uniform> u : RadarUniforms;
@group(0) @binding(1) var<storage, read> nodes : array<NodeData>;

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

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
  let uv = in.uv;
  let p = vec2<f32>(uv.x * u.aspect, uv.y);

  // Fondo editorial claro con retícula técnica sutil
  var bg = mix(vec3<f32>(0.976, 0.980, 0.986), vec3<f32>(0.945, 0.952, 0.965), uv.y);
  let grid_x = abs(fract(p.x * 9.0) - 0.5);
  let grid_y = abs(fract(p.y * 4.5) - 0.5);
  let grid_line = smoothstep(0.485, 0.5, max(grid_x, grid_y));
  bg = mix(bg, vec3<f32>(0.88, 0.90, 0.925), grid_line * 0.42);

  let count = u32(clamp(u.num_nodes, 0.0, 16.0));
  var field_energy : f32 = 0.0;
  var highlight_acc = vec3<f32>(0.0);

  for (var i : u32 = 0u; i < count; i = i + 1u) {
    let nd = nodes[i].meta;
    let center = vec2<f32>(nd.x * u.aspect, nd.y);
    let impact = clamp(nd.z, 0.15, 1.0);
    let recency = clamp(nd.w, 0.1, 1.0);

    let d = distance(p, center);
    let base_r = mix(0.055, 0.145, impact);
    let is_hovered = abs(f32(i) - u.hover_idx) < 0.25;
    let r = select(base_r, base_r * 1.18, is_hovered);

    // Campo gaussiano de energía informativa
    let glow = exp(- (d * d) / (2.0 * (r * 0.85) * (r * 0.85)));
    field_energy = field_energy + glow * impact;

    // Anillo concéntrico nítido por clúster (en WGSL smoothstep exige siempre edge0 < edge1)
    let outer_falloff = 1.0 - smoothstep(r, r + 0.009, d);
    let inner_rise = smoothstep(max(0.001, r - 0.016), max(0.002, r - 0.003), d);
    let ring = outer_falloff * inner_rise;
    let core = 1.0 - smoothstep(r * 0.10, r * 0.32, d);

    // Paleta editorial: azul pizarra suave para temas generales, esmeralda para el tema estrella
    let node_col = mix(
      vec3<f32>(0.20, 0.36, 0.54),
      vec3<f32>(0.09, 0.64, 0.36),
      recency * 0.55 + select(0.0, 0.45, i == 0u)
    );

    let alpha_weight = clamp(glow * 0.24 + ring * 0.55 + core * 0.78, 0.0, 1.0);
    bg = mix(bg, node_col, alpha_weight);
  }

  let contour = abs(fract(field_energy * 2.2) - 0.5);
  let iso_line = smoothstep(0.465, 0.498, contour) * clamp(field_energy, 0.0, 1.0);

  var col = mix(bg, vec3<f32>(0.15, 0.23, 0.34), iso_line * 0.18);
  col = clamp(col, vec3<f32>(0.08), vec3<f32>(0.99));

  return vec4<f32>(col, 1.0);
}
`;

export class WebGpuBriefingEngine {
  constructor() {
    this.device = null;
    this.computePipeline = null;
    this.renderPipeline = null;
    this.format = null;
    this.ready = false;
    this.lastComputeMs = 0;
  }

  async init(existingDevice = null) {
    if (this.ready) return true;
    if (!navigator.gpu) return false;

    try {
      if (existingDevice) {
        this.device = existingDevice;
      } else {
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (!adapter) return false;
        this.device = await adapter.requestDevice();
      }

      this.format = navigator.gpu.getPreferredCanvasFormat();

      const csModule = this.device.createShaderModule({
        label: 'BriefingClusterComputeWGSL',
        code: CLUSTER_SIMILARITY_COMPUTE_WGSL
      });

      this.computePipeline = this.device.createComputePipeline({
        label: 'BriefingClusterComputePipeline',
        layout: 'auto',
        compute: {
          module: csModule,
          entryPoint: 'cs_main'
        }
      });

      const rsModule = this.device.createShaderModule({
        label: 'BriefingRadarRenderWGSL',
        code: BRIEFING_RADAR_RENDER_WGSL
      });

      this.renderPipeline = this.device.createRenderPipeline({
        label: 'BriefingRadarRenderPipeline',
        layout: 'auto',
        vertex: {
          module: rsModule,
          entryPoint: 'vs_main'
        },
        fragment: {
          module: rsModule,
          entryPoint: 'fs_main',
          targets: [{ format: this.format }]
        },
        primitive: {
          topology: 'triangle-list'
        }
      });

      this.ready = true;
      return true;
    } catch (err) {
      console.warn('WebGpuBriefingEngine fallback:', err);
      this.ready = false;
      return false;
    }
  }

  // Convierte el texto de un clúster en un vector normalizado de 64 dimensiones (16 x vec4<f32>)
  encodeClusterVector64(cluster) {
    const vec = new Float32Array(64);
    const text = `${cluster.title || ''} ${(cluster.keywords || []).join(' ')} ${cluster.category || ''}`.toLowerCase();
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 17;
      const bucket = ((code * 31 + next * 13 + i * 7) >>> 0) % 64;
      vec[bucket] += 1.0;
    }
    let norm = 0;
    for (let i = 0; i < 64; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < 64; i++) vec[i] /= norm;
    return vec;
  }

  async computeAffinityAndRender(canvas, clusters = [], hoverIndex = -1) {
    if (!canvas) return { computeMs: 0, affinities: [] };
    const n = Math.min(clusters.length, 16);
    if (n === 0) return { computeMs: 0, affinities: [] };

    if (!this.ready) {
      await this.init();
    }

    if (!this.ready || !this.device) {
      this.renderCanvas2DFallback(canvas, clusters, hoverIndex);
      return { computeMs: 0, affinities: [] };
    }

    const t0 = performance.now();
    try {
      const dimVec4 = 16; // 64 floats = 16 vec4<f32>
      const flatVectors = new Float32Array(n * 64);
      const weights = new Float32Array(Math.max(4, n));
      const maxCount = Math.max(...clusters.slice(0, n).map((c) => Number(c.articleCount) || 1), 1);

      for (let i = 0; i < n; i++) {
        const v = this.encodeClusterVector64(clusters[i]);
        flatVectors.set(v, i * 64);
        weights[i] = Math.min(1.0, (Number(clusters[i].articleCount) || 1) / maxCount);
      }

      const paramBuf = this.device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });
      this.device.queue.writeBuffer(paramBuf, 0, new Uint32Array([n, dimVec4, 0, 0]));

      const vecBuf = this.device.createBuffer({
        size: flatVectors.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      });
      this.device.queue.writeBuffer(vecBuf, 0, flatVectors);

      const weightBuf = this.device.createBuffer({
        size: weights.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      });
      this.device.queue.writeBuffer(weightBuf, 0, weights);

      const outByteLen = Math.max(16, n * n * 4);
      const outBuf = this.device.createBuffer({
        size: outByteLen,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
      });
      const readBuf = this.device.createBuffer({
        size: outByteLen,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
      });

      const bindGroup = this.device.createBindGroup({
        layout: this.computePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: paramBuf } },
          { binding: 1, resource: { buffer: vecBuf } },
          { binding: 2, resource: { buffer: weightBuf } },
          { binding: 3, resource: { buffer: outBuf } }
        ]
      });

      const encoder = this.device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.computePipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil((n * n) / 64));
      pass.end();

      encoder.copyBufferToBuffer(outBuf, 0, readBuf, 0, outByteLen);
      this.device.queue.submit([encoder.finish()]);

      await readBuf.mapAsync(GPUMapMode.READ);
      const affinities = Array.from(new Float32Array(readBuf.getMappedRange()).slice(0, n * n));
      readBuf.unmap();

      paramBuf.destroy();
      vecBuf.destroy();
      weightBuf.destroy();
      outBuf.destroy();
      readBuf.destroy();

      this.lastComputeMs = Math.max(0.1, Number((performance.now() - t0).toFixed(2)));
      this.renderRadarWebGPU(canvas, clusters.slice(0, n), weights, hoverIndex);
      return { computeMs: this.lastComputeMs, affinities };
    } catch (err) {
      console.warn('Error en compute shader WGSL:', err);
      this.renderCanvas2DFallback(canvas, clusters, hoverIndex);
      return { computeMs: 0, affinities: [] };
    }
  }

  renderRadarWebGPU(canvas, clusters, weights, hoverIndex = -1) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = canvas.clientWidth || 420;
    const cssH = canvas.clientHeight || 130;
    const w = Math.max(300, Math.round(cssW * dpr));
    const h = Math.max(110, Math.round(cssH * dpr));

    const offscreen = document.createElement('canvas');
    offscreen.width = w;
    offscreen.height = h;

    const gpuCtx = offscreen.getContext('webgpu');
    gpuCtx.configure({
      device: this.device,
      format: this.format,
      alphaMode: 'opaque'
    });

    const n = Math.min(clusters.length, 8);
    const nodeFloats = new Float32Array(16 * 4);
    for (let i = 0; i < n; i++) {
      const col = i % 4;
      const row = Math.floor(i / 4);
      const px = 0.14 + col * 0.24;
      const py = n <= 4 ? 0.44 : 0.27 + row * 0.44;
      const impact = Math.max(0.24, weights[i] || 0.3);
      const recency = Math.max(0.2, 1.0 - i * 0.08);
      nodeFloats[i * 4 + 0] = Math.min(0.88, px);
      nodeFloats[i * 4 + 1] = Math.min(0.80, py);
      nodeFloats[i * 4 + 2] = impact;
      nodeFloats[i * 4 + 3] = recency;
    }

    const uBuf = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(
      uBuf,
      0,
      new Float32Array([n, w / h, hoverIndex, (performance.now() % 10000) / 1000])
    );

    const nBuf = this.device.createBuffer({
      size: nodeFloats.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(nBuf, 0, nodeFloats);

    const bg = this.device.createBindGroup({
      layout: this.renderPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uBuf } },
        { binding: 1, resource: { buffer: nBuf } }
      ]
    });

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: gpuCtx.getCurrentTexture().createView(),
          loadOp: 'clear',
          clearValue: { r: 0.97, g: 0.98, b: 0.99, a: 1 },
          storeOp: 'store'
        }
      ]
    });
    pass.setPipeline(this.renderPipeline);
    pass.setBindGroup(0, bg);
    pass.draw(3, 1, 0, 0);
    pass.end();
    this.device.queue.submit([encoder.finish()]);

    canvas.width = w;
    canvas.height = h;
    const ctx2d = canvas.getContext('2d');
    if (ctx2d) {
      ctx2d.drawImage(offscreen, 0, 0);
      this.drawClusterLabelsOverlay(ctx2d, w, h, clusters, nodeFloats, n);
    }

    uBuf.destroy();
    nBuf.destroy();
  }

  shortClusterLabel(cluster, index) {
    const raw = String(cluster?.title || '').replace(/^["'«“]+|["'»”]+$/g, '').trim();
    const words = raw.split(/\s+/).filter((w) => w.length > 2);
    const shortText = words.slice(0, 3).join(' ').slice(0, 20);
    const count = cluster?.articleCount || 1;
    return `#${index + 1} ${shortText || 'Tema'} (${count})`;
  }

  drawClusterLabelsOverlay(ctx, w, h, clusters, nodeFloats, n) {
    ctx.save();
    const fontSize = Math.max(10, Math.round(h * 0.082));
    ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "Inter", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let i = 0; i < n; i++) {
      const x = nodeFloats[i * 4 + 0] * w;
      const y = nodeFloats[i * 4 + 1] * h;
      const label = this.shortClusterLabel(clusters[i], i);

      const pillW = Math.min(w * 0.23, ctx.measureText(label).width + 12);
      const pillH = Math.round(fontSize * 1.55);
      const py = Math.min(h - pillH / 2 - 3, y + Math.round(h * 0.14));

      ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
      ctx.strokeStyle = i === 0 ? 'rgba(22, 163, 74, 0.55)' : 'rgba(17, 24, 39, 0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(x - pillW / 2, py - pillH / 2, pillW, pillH, 4);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#111827';
      ctx.fillText(label, x, py + 0.5, pillW - 8);
    }
    ctx.restore();
  }

  renderCanvas2DFallback(canvas, clusters, hoverIndex = -1) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = (canvas.width = canvas.clientWidth || 420);
    const h = (canvas.height = canvas.clientHeight || 130);
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, w, h);
    const n = Math.min(clusters.length, 8);
    const nodeFloats = new Float32Array(16 * 4);
    for (let i = 0; i < n; i++) {
      const px = (i + 0.6) / Math.max(n, 1);
      const py = 0.45;
      nodeFloats[i * 4] = px;
      nodeFloats[i * 4 + 1] = py;
      ctx.beginPath();
      ctx.arc(px * w, py * h, i === hoverIndex ? 18 : 14, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? 'rgba(22, 163, 74, 0.25)' : 'rgba(17, 24, 39, 0.15)';
      ctx.fill();
    }
    this.drawClusterLabelsOverlay(ctx, w, h, clusters, nodeFloats, n);
  }
}
